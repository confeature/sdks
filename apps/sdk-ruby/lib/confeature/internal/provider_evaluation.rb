# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "../evaluation_details"
require_relative "evaluator"
require_relative "override_eval"
require_relative "provider_user"

module Confeature
  module Internal
    module ProviderEvaluation
      FLAG_TYPES = {
        boolean: [TrueClass, FalseClass].freeze,
        string: [String].freeze,
        integer: [Integer].freeze,
        float: [Float].freeze,
        number: [Integer, Float].freeze
      }.freeze

      module_function

      def evaluate(client, key, fallback, flag_type:, **attributes)
        return EvaluationDetails.from_error(key, fallback, error: "TYPE_MISMATCH") unless FLAG_TYPES.key?(flag_type)

        client.get_value_details(key, fallback, ProviderUser.new(flag_type: flag_type, **attributes))
      rescue StandardError
        # Exceptions can include caller context or transport data.
        EvaluationDetails.from_error(key, fallback, error: "EVAL_EXCEPTION")
      end

      def resolve(key, fallback, user, config:, local_overrides:)
        # Let the native evaluator determine the stored type from one read.
        # OpenFeature's number method accepts both numeric types independently
        # of the type of its fallback.
        result =
          if local_overrides.nil?
            Evaluator.evaluate(config, key, nil, user)
          else
            resolve_override(local_overrides, key, user)
          end
        error = result.error || type_error(result.value, user.flag_type)
        return result if error.nil?

        Evaluator::EvaluationResult.new(value: fallback, error: error)
      end

      def resolve_override(overrides, key, user)
        found, result = OverrideEval.evaluate_full_config_override_details_sync(overrides, key, nil, user)
        return result if found

        matched, value, error = OverrideEval.evaluate_sync_details(overrides, key, nil)
        Evaluator::EvaluationResult.new(value: value, error: matched ? error : "KEY_NOT_FOUND")
      end

      def type_error(value, flag_type)
        return "TYPE_MISMATCH" unless FLAG_TYPES.fetch(flag_type).any? { |type| value.is_a?(type) }
        return "MALFORMED_VALUE" if value.is_a?(Float) && !value.finite?

        nil
      end
    end
  end
end
