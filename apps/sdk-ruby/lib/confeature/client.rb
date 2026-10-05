# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "evaluation_details"
require_relative "flag_overrides"
require_relative "hooks"
require_relative "internal/cache"
require_relative "internal/config_fetcher"
require_relative "internal/evaluator"
require_relative "internal/override_eval"
require_relative "internal/poll_service"
require_relative "internal/sdk_key"
require_relative "logger"
require_relative "polling_mode"
require_relative "snapshot"
require_relative "version"

module Confeature
  # Top-level entry point — drop-in equivalent of the upstream
  # `configcat` gem's `ConfigCatClient`.
  #
  # Constructor kwargs mirror the upstream gem's option set:
  #   sdk_key:           required non-empty Confeature SDK key.
  #   polling_mode:      PollingMode.auto_poll(...) by default.
  #   cache_directory:   filesystem cache dir.
  #                      :memory → memory-only.
  #                      nil → platform default (~/.cache/confeature).
  #   request_timeout_seconds: per-request timeout (default 30 s).
  #   logger:            a Confeature::Logger instance.
  #   flag_overrides:    optional FlagOverrides (LOCAL_ONLY in v1).
  #   base_url:          CDN base URL override (self-hosted).
  #   default_user:      default User consulted when get_value's `user`
  #                      arg is nil.
  #
  # `#get_value` resolves the four `SettingType` discriminators
  # (spec 072, issue #259):
  #   - `t=0` (boolean) → expects a `TrueClass` / `FalseClass` default;
  #   - `t=1` (string)  → expects a `String` default;
  #   - `t=2` (int)     → expects an `Integer` default;
  #   - `t=3` (double)  → expects a `Float` default — strict, Ruby's
  #     `Float === 5` is false so an `Integer` default refuses with
  #     `TYPE_MISMATCH` (deliberate, matches ConfigCat-Ruby behaviour).
  # Type-mismatched defaults round-trip as-is with `TYPE_MISMATCH`
  # under the hood. Genuinely unknown `t` discriminators (e.g. `99`)
  # still resolve as `UNSUPPORTED_TYPE`.
  class Client # rubocop:disable Metrics/ClassLength
    def initialize(sdk_key:,
                   polling_mode: nil,
                   cache_directory: nil,
                   request_timeout_seconds: 30.0,
                   logger: nil,
                   flag_overrides: nil,
                   base_url: nil,
                   default_user: nil)
      raise ArgumentError, "sdk_key is required and must be a non-empty String" if invalid_sdk_key?(sdk_key)
      if request_timeout_seconds <= 0
        raise ArgumentError,
              "request_timeout_seconds must be > 0; got #{request_timeout_seconds.inspect}"
      end
      validate_flag_overrides!(flag_overrides)
      validate_logger!(logger)

      @sdk_key = sdk_key
      @logger = logger || Confeature.default_logger
      @flag_overrides = flag_overrides
      @default_user = default_user
      @closed = false
      # Spec 097 / #267 — mirrors ConfigCat::ConfigCatClient's offline flag.
      # Set via `set_offline` / `set_online`; read by `fetch_and_apply`,
      # `force_refresh`, `offline?`. Plain Ruby ivar — protected by @lock
      # alongside the rest of the state.
      @offline = false
      # Spec 108 / #268 — mirrors ConfigCat's Hooks bus. Four hook points
      # (client_ready, config_changed, flag_evaluated, error) wired below
      # in fetch_and_apply / get_value_details / initialize cache restore.
      @hooks = Hooks.new(logger: @logger)
      @client_ready_fired = false
      @lock = Mutex.new

      log_invalid_format(sdk_key)

      @cache_key = Internal::SdkKey.derive_cache_key(sdk_key)
      @cache = Internal::Cache.build(
        cache_directory: cache_directory,
        cache_key: @cache_key,
        sdk_key: sdk_key,
        logger: @logger
      )
      @config = nil
      @etag = nil
      # Wall-clock time of the active config's last successful fetch /
      # cache restore. Surfaced via `EvaluationDetails.fetch_time`
      # (spec 086 / #266). `nil` until a config loads.
      @fetch_time = nil
      existing = @cache.read
      if existing
        @config = existing.body
        @etag = existing.etag
        @fetch_time = Time.at(existing.fetched_at) if existing.fetched_at
        # Hook bus (spec 108 / #268) — cache hit fires client_ready once.
        fire_client_ready_once
      end

      @mode = polling_mode || PollingMode.auto_poll
      @fetcher = Internal::ConfigFetcher.new(
        sdk_key: sdk_key,
        version: Confeature::VERSION,
        logger: @logger,
        base_url: base_url,
        request_timeout_seconds: request_timeout_seconds
      )
      @service = Internal::PollService.build(@mode)

      # LocalOnly customers don't fetch — every call is served by the
      # override-eval path. Skipping `service.start` keeps tests +
      # LocalOnly customers offline.
      return if local_only_mode?

      @service.start(method(:fetch_and_apply))
    end

    # ---- Public API --------------------------------------------------

    def get_value(key, default, user = nil)
      return default if @closed

      # Override path FIRST — spec 036 correctness. The router (spec 135 /
      # #431) threads the user so a full-config override source resolves
      # targeting rules through the real evaluator; the flat-map source
      # keeps the byte-identical value-only path.
      effective_user = user || @default_user
      found, value = Internal::OverrideEval.evaluate(@flag_overrides, key, default, effective_user)
      return value if found

      begin
        @service.maybe_fetch_for_get_value
      rescue StandardError => e
        @logger.warning(
          "Client#get_value: maybe_fetch_for_get_value raised " \
          "(sdkKey=#{Internal::SdkKey.redact(@sdk_key)}): #{e.class}"
        )
      end

      result = Internal::Evaluator.evaluate(@config, key, default, effective_user)
      result.value
    end

    def snapshot
      Snapshot.new(
        config: @config,
        flag_overrides: @flag_overrides,
        default_user: @default_user,
        fetch_time: @fetch_time
      )
    end

    # Spec 086 / #266 — typed-envelope mirror of `get_value`. Routes
    # through the snapshot path so override semantics + fetch_time
    # capture stay consistent across the two accessors.
    #
    # Closed clients return an envelope with the supplied default,
    # `is_default_value: true`, and `error: "CLIENT_CLOSED"` (matches
    # the closed-client read semantics of `get_value`).
    def get_value_details(key, default, user = nil)
      return EvaluationDetails.from_error(key, default, error: "CLIENT_CLOSED") if @closed

      begin
        @service.maybe_fetch_for_get_value
      rescue StandardError => e
        @logger.warning(
          "Client#get_value_details: maybe_fetch_for_get_value raised " \
          "(sdkKey=#{Internal::SdkKey.redact(@sdk_key)}): #{e.class}"
        )
      end

      details = snapshot.get_value_details(key, default, user)
      @hooks.invoke_on_flag_evaluated(details)
      details
    end

    # Spec 108 / #268 — returns the hooks bus for subscribing lifecycle events.
    # Mirrors ConfigCat's `ConfigCatClient#hooks`.
    attr_reader :hooks

    # Spec 086 / #266 — evaluates every known flag for `user` and
    # returns a Hash<String, Object>.
    #
    # Iterates the union of cached-config flag keys + override keys
    # (the same set the snapshot's `get_all_keys` returns). Per-key
    # value is resolved via `get_value(key, nil, user)`; keys whose
    # resolved value is `nil` are omitted, mirroring upstream's
    # exclusion semantics. Closed clients return an empty Hash.
    def get_all_values(user = nil)
      return {} if @closed

      begin
        @service.maybe_fetch_for_get_value
      rescue StandardError => e
        @logger.warning(
          "Client#get_all_values: maybe_fetch_for_get_value raised " \
          "(sdkKey=#{Internal::SdkKey.redact(@sdk_key)}): #{e.class}"
        )
      end

      snap = snapshot
      snap.get_all_keys.each_with_object({}) do |key, acc|
        value = snap.get_value(key, nil, user)
        acc[key] = value unless value.nil?
      end
    end

    def force_refresh
      return Internal::PollService::RefreshResult.new(success: false, error: "CLIENT_CLOSED") if @closed
      return Internal::PollService::RefreshResult.new(success: true) if local_only_mode?
      if @offline
        # Spec 097 / #267 — no HTTP while offline.
        return Internal::PollService::RefreshResult.new(success: false, error: "OFFLINE_MODE")
      end

      # ManualPoll's start was deferred for LocalOnly; ensure the
      # service has the callback wired before forcing a refresh.
      ensure_service_started

      @service.force_refresh
    end

    # Spec 097 / #267 slice 8/14 — re-enables HTTP polling. Idempotent.
    # Mirrors ConfigCat::ConfigCatClient#set_online. Closed clients log
    # warning + no-op. LocalOnly clients log warning + no-op.
    def set_online
      if @closed
        @logger.warning(
          "Client#set_online: called after close (sdkKey=#{Internal::SdkKey.redact(@sdk_key)})"
        )
        return
      end
      if local_only_mode?
        @logger.warning(
          "Client#set_online: client is configured to use the LOCAL_ONLY override " \
          "behaviour, thus set_online has no effect (sdkKey=#{Internal::SdkKey.redact(@sdk_key)})"
        )
        return
      end
      @offline = false
      nil
    end

    # Spec 097 / #267 slice 8/14 — suspends HTTP polling; serves the
    # cached config. Idempotent. Mirrors ConfigCat::ConfigCatClient#set_offline.
    # Closed clients log warning + no-op. LocalOnly clients are a silent no-op.
    def set_offline
      if @closed
        @logger.warning(
          "Client#set_offline: called after close (sdkKey=#{Internal::SdkKey.redact(@sdk_key)})"
        )
        return
      end
      return if local_only_mode?

      @offline = true
      nil
    end

    # Spec 097 / #267 slice 8/14 — true when HTTP polling is suspended.
    # Mirrors ConfigCat::ConfigCatClient#offline?. Closed clients return
    # true. LocalOnly clients return true.
    def offline?
      return true if @closed
      return true if local_only_mode?

      @offline
    end

    def close
      return if @closed

      @closed = true
      begin
        @service.stop(timeout: 5.0)
      rescue StandardError => e
        @logger.warning(
          "Client#close: poll service stop raised " \
          "(sdkKey=#{Internal::SdkKey.redact(@sdk_key)}): #{e.class}"
        )
      end
      begin
        @fetcher.close
      rescue StandardError => e
        @logger.warning(
          "Client#close: fetcher close raised " \
          "(sdkKey=#{Internal::SdkKey.redact(@sdk_key)}): #{e.class}"
        )
      end
      nil
    end

    # ---- Internals ---------------------------------------------------

    private

    def invalid_sdk_key?(sdk_key)
      !sdk_key.is_a?(String) || sdk_key.empty?
    end

    def validate_flag_overrides!(flag_overrides)
      return if flag_overrides.nil?
      return if flag_overrides.is_a?(FlagOverrides)

      raise TypeError, "flag_overrides must be a Confeature::FlagOverrides instance or nil"
    end

    def validate_logger!(logger)
      return if logger.nil?
      return if logger.is_a?(Confeature::Logger)

      raise TypeError, "logger must be a Confeature::Logger instance or nil"
    end

    def log_invalid_format(sdk_key)
      return if Internal::SdkKey.valid_confeature_key_format?(sdk_key)

      @logger.warning(
        "INVALID_SDK_KEY format for sdkKey=#{Internal::SdkKey.redact(sdk_key)}. " \
        "Continuing — the SDK is lenient about key format at runtime."
      )
    end

    def local_only_mode?
      return false if @flag_overrides.nil?

      @flag_overrides.behaviour == OverrideBehaviour::LOCAL_ONLY
    end

    def ensure_service_started
      # `start` is idempotent — re-calling is cheap.
      @service.start(method(:fetch_and_apply))
    end

    def fetch_and_apply
      # Spec 097 / #267 — skip HTTP while offline. AutoPoll / LazyLoad /
      # ManualPoll all route here, so a single gate suffices.
      return Internal::ConfigFetcher::FetchResult.new(status: :failed, error: "OFFLINE_MODE") if @offline

      result = @fetcher.fetch(@etag)
      new_config = nil
      @lock.synchronize do
        case result.status
        when :fetched
          if result.body
            @config = result.body
            @etag = result.etag
            # Stamp `@fetch_time` for `EvaluationDetails.fetch_time`
            # (spec 086 / #266).
            @fetch_time = Time.now
            new_config = result.body
            @cache.write(
              Internal::Cache::CacheEntry.new(
                body: result.body,
                etag: result.etag,
                fetched_at: Internal::Cache.now_seconds
              )
            )
          end
        when :not_modified
          @etag = result.etag if result.etag
          # `not_modified` still confirms freshness — refresh stamp.
          @fetch_time = Time.now
        end
      end
      # Hook bus (spec 108 / #268) — fire outside the lock so listeners
      # can re-enter the client without deadlock.
      case result.status
      when :fetched
        if new_config
          @hooks.invoke_on_config_changed(new_config)
          fire_client_ready_once
        end
      when :not_modified
        fire_client_ready_once
      when :failed
        @hooks.invoke_on_error(result.error || "Config fetch failed.")
      end
      result
    end

    def fire_client_ready_once
      should_fire = @lock.synchronize do
        next false if @client_ready_fired

        @client_ready_fired = true
        true
      end
      @hooks.invoke_on_client_ready if should_fire
    end
  end
end
