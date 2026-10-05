# frozen_string_literal: true

module Confeature
  # Subscribe to client lifecycle events. Mirrors ConfigCat's
  # `ConfigCat::Hooks` 1:1 at the public API surface (constitution
  # Principle II, epic #268).
  #
  # Four hook points map to the JS-family reference contract:
  # `client_ready`, `config_changed`, `flag_evaluated`, `error`.
  # Listener exceptions are caught and logged — never escape to the
  # emitter. Obtain via `Confeature::Client#hooks`.
  class Hooks
    def initialize(logger: nil)
      @logger = logger || Confeature.default_logger
      @lock = Mutex.new
      @on_client_ready = []
      @on_config_changed = []
      @on_flag_evaluated = []
      @on_error = []
    end

    # Subscribe to the first successful config load.
    def add_on_client_ready(&block)
      raise ArgumentError, "block required" unless block_given?

      @lock.synchronize { @on_client_ready << block }
      nil
    end

    # Subscribe to every fetched config (`config` is the settings hash).
    def add_on_config_changed(&block)
      raise ArgumentError, "block required" unless block_given?

      @lock.synchronize { @on_config_changed << block }
      nil
    end

    # Subscribe to every `EvaluationDetails` produced by `get_value_details`.
    def add_on_flag_evaluated(&block)
      raise ArgumentError, "block required" unless block_given?

      @lock.synchronize { @on_flag_evaluated << block }
      nil
    end

    # Subscribe to non-fatal SDK errors (HTTP failures, cache I/O).
    def add_on_error(&block)
      raise ArgumentError, "block required" unless block_given?

      @lock.synchronize { @on_error << block }
      nil
    end

    # --- internal invokers ----------------------------------------------

    def invoke_on_client_ready
      callbacks = @lock.synchronize { @on_client_ready.dup }
      callbacks.each { |cb| safe_call(cb, :on_client_ready) }
    end

    def invoke_on_config_changed(config)
      callbacks = @lock.synchronize { @on_config_changed.dup }
      callbacks.each { |cb| safe_call(cb, :on_config_changed, config) }
    end

    def invoke_on_flag_evaluated(details)
      callbacks = @lock.synchronize { @on_flag_evaluated.dup }
      callbacks.each { |cb| safe_call(cb, :on_flag_evaluated, details) }
    end

    def invoke_on_error(message)
      callbacks = @lock.synchronize { @on_error.dup }
      callbacks.each { |cb| safe_call(cb, :on_error, message) }
    end

    private

    def safe_call(callback, name, *args)
      callback.call(*args)
    rescue StandardError => e
      @logger.error("Hooks: #{name} listener raised: #{e.class}: #{e.message}")
    end
  end
end
