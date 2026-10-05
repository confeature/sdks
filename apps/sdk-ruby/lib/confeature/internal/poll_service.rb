# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "../polling_mode"

module Confeature
  module Internal
    # Polling strategies: AutoPoll (daemon thread), LazyLoad (on-demand
    # staleness), ManualPoll (caller-driven).
    #
    # Lifecycle:
    #   - constructor accepts a `fetch_callback` (no args, returns
    #     ConfigFetcher::FetchResult) bound to the client's
    #     ConfigFetcher.
    #   - `start(callback)` is idempotent. AutoPoll spawns its daemon
    #     thread here. LazyLoad / ManualPoll record the callback but
    #     spawn nothing.
    #   - `force_refresh` invokes the callback synchronously and
    #     returns a `RefreshResult`.
    #   - `stop(timeout: 5.0)` signals the thread and joins (no-op for
    #     non-AutoPoll modes).
    #
    # AutoPoll uses `Thread.new` + `Mutex` + `ConditionVariable` for
    # cancel signalling. Threads are daemon so process shutdown never
    # hangs on a poll-thread join.
    module PollService
      RefreshResult = Struct.new(:success, :error, keyword_init: true) do
        def self.from_fetch(fetch_result)
          if %i[fetched not_modified].include?(fetch_result.status)
            new(success: true)
          else
            new(success: false, error: fetch_result.error || "FETCH_FAILED")
          end
        end
      end

      # Abstract base — subclasses provide the per-mode behaviour.
      class Base
        def start(_callback)
          raise NotImplementedError
        end

        def stop(timeout: 5.0)
          raise NotImplementedError
        end

        def force_refresh
          raise NotImplementedError
        end

        # Hook for LazyLoad's on-demand staleness-driven fetch.
        # AutoPoll + ManualPoll return immediately.
        def maybe_fetch_for_get_value
          nil
        end
      end

      class AutoPollService < Base
        def initialize(options)
          super()
          @options = options
          @callback = nil
          @started = false
          @mutex = Mutex.new
          @stop_mutex = Mutex.new
          @stop_cond = ConditionVariable.new
          @stopped = false
          @thread = nil
        end

        def start(callback)
          @mutex.synchronize do
            return if @started

            @callback = callback
            @started = true
          end

          # Eager initial fetch so first get_value lands on real config.
          safe_invoke(@callback)

          @thread = Thread.new { run_loop }
          @thread.name = "confeature-autopoll" if @thread.respond_to?(:name=)
          @thread.report_on_exception = false if @thread.respond_to?(:report_on_exception=)
        end

        def stop(timeout: 5.0)
          @stop_mutex.synchronize do
            @stopped = true
            @stop_cond.broadcast
          end
          thread = @thread
          @thread = nil
          thread&.join(timeout)
          nil
        end

        def force_refresh
          cb = @callback
          return RefreshResult.new(success: false, error: "NOT_STARTED") if cb.nil?

          result = safe_invoke(cb)
          return RefreshResult.new(success: false, error: "CALLBACK_RAISED") if result.nil?

          RefreshResult.from_fetch(result)
        end

        private

        def run_loop
          interval = @options.poll_interval_seconds
          loop do
            @stop_mutex.synchronize do
              return if @stopped

              @stop_cond.wait(@stop_mutex, interval)
              return if @stopped
            end
            cb = @callback
            return if cb.nil?

            safe_invoke(cb)
          end
        end

        # Returns the callback's result, or nil if the callback raised.
        # The shipped `ConfigFetcher.fetch` is fail-closed; this guard
        # exists so a misbehaving custom callback can't crash the
        # daemon thread or the force_refresh path.
        def safe_invoke(cb)
          cb.call
        rescue StandardError
          nil
        end
      end

      class LazyLoadService < Base
        def initialize(options)
          super()
          @options = options
          @callback = nil
          @last_fetched_at = 0.0
          @mutex = Mutex.new
        end

        def start(callback)
          @mutex.synchronize { @callback = callback }
        end

        def stop(timeout: 5.0) # rubocop:disable Lint/UnusedMethodArgument
          nil
        end

        def force_refresh
          cb = @callback
          return RefreshResult.new(success: false, error: "NOT_STARTED") if cb.nil?

          result = RefreshResult.from_fetch(cb.call)
          @mutex.synchronize { @last_fetched_at = Time.now.to_f } if result.success
          result
        end

        def maybe_fetch_for_get_value
          cb = @callback
          return nil if cb.nil?

          now = Time.now.to_f
          stale = (now - @last_fetched_at) >= @options.cache_refresh_interval_seconds
          return nil unless stale

          begin
            cb.call
            @mutex.synchronize { @last_fetched_at = Time.now.to_f }
          rescue StandardError
            # Swallow — fetch errors are logged inside ConfigFetcher.
          end
          nil
        end
      end

      class ManualPollService < Base
        def initialize
          super
          @callback = nil
        end

        def start(callback)
          @callback = callback
        end

        def stop(timeout: 5.0) # rubocop:disable Lint/UnusedMethodArgument
          nil
        end

        def force_refresh
          cb = @callback
          return RefreshResult.new(success: false, error: "NOT_STARTED") if cb.nil?

          RefreshResult.from_fetch(cb.call)
        end
      end

      # Build the service matching the supplied PollingMode value.
      def self.build(mode)
        case mode
        when PollingMode::AutoPoll then AutoPollService.new(mode)
        when PollingMode::LazyLoad then LazyLoadService.new(mode)
        when PollingMode::ManualPoll then ManualPollService.new
        else
          raise ArgumentError,
                "Unsupported polling mode: #{mode.inspect}. " \
                "Use PollingMode.auto_poll, .lazy_load, or .manual_poll."
        end
      end
    end
  end
end
