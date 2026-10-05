# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "evaluation_details"
require_relative "internal/evaluator"
require_relative "internal/override_eval"

module Confeature
  # Immutable view of the last-fetched config + a reference to overrides.
  #
  # All methods are synchronous. `get_value` consults overrides FIRST
  # via `Internal::OverrideEval.evaluate_sync`, then falls through to
  # the cached config + boolean evaluator. This is the spec-036
  # correctness path that the Ruby SDK inherits from day one.
  #
  # `fetch_time` is captured at snapshot construction time so
  # `EvaluationDetails.fetch_time` is immutable across the snapshot's
  # life (spec 086 / #266).
  class Snapshot
    def initialize(config:, flag_overrides:, default_user:, fetch_time: nil)
      @config = config
      @flag_overrides = flag_overrides
      @default_user = default_user
      @fetch_time = fetch_time
      freeze
    end

    def get_value(key, default, user = nil)
      # Override path FIRST — spec 036 correctness. Route through the
      # full-config-aware router (spec 135 / #431) so a rule-bearing
      # override source resolves targeting rules; the flat-map source is
      # unchanged.
      effective_user = user || @default_user
      found, value = Internal::OverrideEval.evaluate(@flag_overrides, key, default, effective_user)
      return value if found

      result = Internal::Evaluator.evaluate(
        @config, key, default, effective_user
      )
      result.value
    end

    def get_all_keys
      keys = []
      if @config.is_a?(Hash)
        settings = @config["f"]
        keys.concat(settings.keys) if settings.is_a?(Hash)
      end
      if @flag_overrides
        begin
          override_map = @flag_overrides.data_source.get_overrides_sync
        rescue StandardError
          override_map = nil
        end
        keys.concat(override_map.keys) if override_map.is_a?(Hash)
      end
      keys.uniq.sort
    end

    # Spec 086 / #266 — typed-envelope mirror of `get_value`.
    #
    # For LocalOnly consumers, the override map is the only source of
    # truth: a key present in the map yields the typed value with
    # `error: nil`; a missing key yields the default with
    # `error: "KEY_NOT_FOUND"`. The override-eval helper returns the
    # default on both KEY_NOT_FOUND and TYPE_MISMATCH branches,
    # indistinguishable from a legitimate override whose value equals
    # the default — Snapshot re-queries the map to disambiguate.
    #
    # Non-LocalOnly clients route through the evaluator; the
    # `EvaluationResult.error` string propagates verbatim into the
    # envelope's `error` field.
    def get_value_details(key, default, user = nil)
      effective_user = user || @default_user
      return local_only_details(key, default, effective_user) if local_only?

      result = Internal::Evaluator.evaluate(@config, key, default, effective_user)
      matched_rule = result.matched_targeting_rule && TargetingRule.new(result.matched_targeting_rule)
      matched_option = result.matched_percentage_option && PercentageOption.new(result.matched_percentage_option)
      EvaluationDetails.new(
        key: key,
        value: result.value,
        variation_id: result.variation_id,
        user: effective_user,
        is_default_value: !result.error.nil?,
        error: result.error,
        fetch_time: @fetch_time,
        matched_targeting_rule: matched_rule,
        matched_percentage_option: matched_option
      )
    end

    private

    def local_only?
      return false if @flag_overrides.nil?

      @flag_overrides.behaviour == OverrideBehaviour::LOCAL_ONLY
    end

    def local_only_details(key, default, effective_user)
      # Full-config override source → resolve through the real evaluator
      # so targeting rules apply AND the served `variation_id` survives
      # to the PUBLIC details envelope (spec 152 / #475, US2; closes the
      # #395 gap class). Dispatch on the source TYPE, never the resolved
      # value, mirroring `get_value`'s `OverrideEval.evaluate` router.
      found_full, result = Internal::OverrideEval.evaluate_full_config_override_details_sync(
        @flag_overrides, key, default, effective_user
      )
      if found_full
        matched_rule = result.matched_targeting_rule && TargetingRule.new(result.matched_targeting_rule)
        matched_option = result.matched_percentage_option && PercentageOption.new(result.matched_percentage_option)
        return EvaluationDetails.new(
          key: key,
          value: result.value,
          variation_id: result.variation_id,
          user: effective_user,
          is_default_value: !result.error.nil?,
          error: result.error,
          fetch_time: @fetch_time,
          matched_targeting_rule: matched_rule,
          matched_percentage_option: matched_option
        )
      end

      found, value = Internal::OverrideEval.evaluate_sync(@flag_overrides, key, default)
      data_source = @flag_overrides.data_source
      overrides_map =
        if data_source.respond_to?(:get_overrides_sync)
          begin
            data_source.get_overrides_sync
          rescue StandardError
            nil
          end
        end
      present = overrides_map.is_a?(Hash) && overrides_map.key?(key)

      if found && present
        EvaluationDetails.new(
          key: key,
          value: value,
          user: effective_user,
          fetch_time: @fetch_time
        )
      else
        EvaluationDetails.new(
          key: key,
          value: default,
          is_default_value: true,
          error: "KEY_NOT_FOUND",
          user: effective_user,
          fetch_time: @fetch_time
        )
      end
    end
  end
end
