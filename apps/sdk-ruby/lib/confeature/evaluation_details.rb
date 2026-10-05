# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  # Typed result envelope returned by
  # `Confeature::Client#get_value_details` +
  # `Confeature::Snapshot#get_value_details`.
  #
  # Spec 086 / closes #266 for the sdk-ruby slice. Field layout mirrors
  # upstream `configcat` 8.x's `ConfigCat::EvaluationDetails` 1:1 so a
  # migrating consumer reads the same attribute names in the same
  # positions: a customer migrating from ConfigCat to Confeature renames
  # only the `require` line.
  #
  # Stable error codes populating `error` on fail branches match the
  # evaluator's tier-0 set:
  #   `KEY_NOT_FOUND` / `TYPE_MISMATCH` / `MALFORMED_VALUE` /
  #   `UNSUPPORTED_TYPE` / `NO_CONFIG` / `MALFORMED_CONFIG` /
  #   `VALUE_NOT_BOOL` / `CLIENT_CLOSED`.
  #
  # `fetch_time` is a `Time` instance (UTC) at which the active config
  # was last fetched from the CDN / restored from the on-disk cache.
  # `nil` until any config has loaded.
  #
  # `matched_targeting_rule` + `matched_percentage_option` are populated
  # by the spec-120 evaluation engine when a targeting rule / percentage
  # option decided the value (FR-011); `nil` otherwise (no rule matched,
  # or a served fallback / default).
  class EvaluationDetails
    attr_reader :key, :value, :variation_id, :fetch_time, :user,
                :is_default_value, :error,
                :matched_targeting_rule, :matched_percentage_option

    def initialize(key:, value:, variation_id: nil, fetch_time: nil, user: nil,
                   is_default_value: false, error: nil,
                   matched_targeting_rule: nil, matched_percentage_option: nil)
      @key = key
      @value = value
      @variation_id = variation_id
      @fetch_time = fetch_time
      @user = user
      @is_default_value = is_default_value
      @error = error
      @matched_targeting_rule = matched_targeting_rule
      @matched_percentage_option = matched_percentage_option
    end

    # Convenience factory for fail-closed branches: closed client,
    # caller-supplied invalid input, etc. Mirrors upstream
    # `ConfigCat::EvaluationDetails.from_error` 1:1.
    def self.from_error(key, value, error:, variation_id: nil)
      new(key: key, value: value, variation_id: variation_id,
          is_default_value: true, error: error)
    end
  end

  # The targeting rule that decided an evaluated value (FR-011). Mirrors
  # upstream `configcat`'s `TargetingRule` shape: it exposes the raw
  # `config_v6` rule Hash (`conditions`, `served_value`, `percentage_options`)
  # so a migrating consumer can introspect the matched rule. Per FR-017 the
  # detail surfaces resolved identity only — not a textual evaluation trace.
  class TargetingRule
    attr_reader :conditions, :served_value, :percentage_options

    # @param rule [Hash] the matched `config_v6` targeting-rule Hash (`c,s?,p?`).
    def initialize(rule)
      rule = {} unless rule.is_a?(Hash)
      @conditions = rule["c"]
      @served_value = rule["s"]
      @percentage_options = rule["p"]
    end
  end

  # The percentage option that decided an evaluated value (FR-011). Mirrors
  # upstream `configcat`'s `PercentageOption`: `percentage` (width),
  # `variation_id`, and the raw served `value` envelope.
  class PercentageOption
    attr_reader :percentage, :value, :variation_id

    # @param option [Hash] the matched `config_v6` percentage-option Hash (`p,v,i`).
    def initialize(option)
      option = {} unless option.is_a?(Hash)
      @percentage = option["p"]
      @value = option["v"]
      @variation_id = option["i"]
    end
  end
end
