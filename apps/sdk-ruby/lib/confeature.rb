# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Top-level barrel for the Confeature Ruby SDK.
#
# The public API surface mirrors the upstream `configcat` gem 1:1
# (Constitution Principle II): a customer that already uses ConfigCat
# in Ruby can migrate by changing the require name and the SDK key
# value.

require_relative "confeature/version"
require_relative "confeature/user"
require_relative "confeature/log_level"
require_relative "confeature/logger"
require_relative "confeature/polling_mode"
require_relative "confeature/flag_overrides"
require_relative "confeature/evaluation_details"
require_relative "confeature/snapshot"
require_relative "confeature/client"

# Re-export internal SDK-key helpers at the top level for unit tests
# and parity-corpus verification. These live under `Confeature::` and
# delegate to `Confeature::Internal::SdkKey`.
require_relative "confeature/internal/sdk_key"

module Confeature
  def self.derive_cache_key(sdk_key)
    Internal::SdkKey.derive_cache_key(sdk_key)
  end

  def self.redact_sdk_key(sdk_key)
    Internal::SdkKey.redact(sdk_key)
  end

  def self.valid_confeature_key_format?(sdk_key)
    Internal::SdkKey.valid_confeature_key_format?(sdk_key)
  end
end
