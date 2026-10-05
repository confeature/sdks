# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "logger"

require_relative "log_level"

module Confeature
  # Pluggable logger surface.
  #
  # Customers integrate by either:
  #   - keeping the default stderr-backed logger (wraps stdlib
  #     `::Logger.new($stderr)`), or
  #   - subclassing `Confeature::Logger` and passing the instance via
  #     the client's `logger:` constructor kwarg.
  #
  # The default level is WARNING (mirrors `configcat`'s default).
  class Logger
    attr_reader :level

    def initialize(level: LogLevel::WARNING, io: $stderr)
      @level = level
      @logger = ::Logger.new(io)
      @logger.progname = "confeature"
      @logger.level = level_to_stdlib(level)
    end

    def error(message)
      @logger.error(message) if @level <= LogLevel::ERROR
    end

    def warning(message)
      @logger.warn(message) if @level <= LogLevel::WARNING
    end

    def info(message)
      @logger.info(message) if @level <= LogLevel::INFO
    end

    def debug(message)
      @logger.debug(message) if @level <= LogLevel::DEBUG
    end

    private

    def level_to_stdlib(level)
      # LogLevel::OFF maps above ::Logger::UNKNOWN so nothing fires.
      return ::Logger::UNKNOWN + 1 if level == LogLevel::OFF

      level
    end
  end

  # Build the SDK's default logger — stderr-backed, WARNING level.
  def self.default_logger
    Logger.new
  end
end
