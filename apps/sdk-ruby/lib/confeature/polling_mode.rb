# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  # Polling-mode factory + value types.
  #
  # Mirrors the upstream `configcat` gem's `PollingMode` module: three
  # factory methods produce frozen value objects that the client wires
  # into the matching poll service (AutoPoll → daemon thread, LazyLoad
  # → on-demand staleness check, ManualPoll → caller-driven).
  module PollingMode
    AutoPoll = Struct.new(:poll_interval_seconds, :max_init_wait_time_seconds, keyword_init: true) do
      def to_s
        "AutoPoll(interval=#{poll_interval_seconds}s, " \
          "max_init_wait=#{max_init_wait_time_seconds}s)"
      end
    end

    LazyLoad = Struct.new(:cache_refresh_interval_seconds, keyword_init: true) do
      def to_s
        "LazyLoad(refresh=#{cache_refresh_interval_seconds}s)"
      end
    end

    ManualPoll = Class.new do
      def to_s
        "ManualPoll"
      end

      def ==(other)
        other.is_a?(ManualPoll)
      end
      alias_method :eql?, :==

      def hash
        ManualPoll.hash
      end
    end

    # Build an AutoPoll value with the standard ConfigCat defaults.
    def self.auto_poll(poll_interval: 60, max_init_wait_time: 5)
      AutoPoll.new(
        poll_interval_seconds: poll_interval,
        max_init_wait_time_seconds: max_init_wait_time
      ).freeze
    end

    # Build a LazyLoad value with the standard ConfigCat default.
    def self.lazy_load(cache_refresh_interval: 60)
      LazyLoad.new(cache_refresh_interval_seconds: cache_refresh_interval).freeze
    end

    # Singleton ManualPoll value — identity-stable for cheap `equal?`
    # short-circuits when the client checks the active mode.
    MANUAL_POLL = ManualPoll.new.freeze

    def self.manual_poll
      MANUAL_POLL
    end
  end
end
