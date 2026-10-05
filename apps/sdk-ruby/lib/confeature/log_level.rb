# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "logger"

module Confeature
  # Confeature log levels. Int values align with stdlib `Logger`
  # severity constants so customers can swap between Confeature levels
  # and stdlib levels transparently.
  module LogLevel
    DEBUG   = ::Logger::DEBUG    # 0
    INFO    = ::Logger::INFO     # 1
    WARNING = ::Logger::WARN     # 2
    ERROR   = ::Logger::ERROR    # 3
    OFF     = ::Logger::UNKNOWN + 1 # 6 — above every stdlib level

    ALL = [DEBUG, INFO, WARNING, ERROR, OFF].freeze
  end
end
