# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "confeature"
require "open_feature/sdk"
require_relative "confeature_openfeature/context"
require_relative "confeature_openfeature/version"

module ConfeatureOpenFeature
  class Provider
    OpenFeatureProvider = OpenFeature::SDK::Provider
    ErrorCode = OpenFeatureProvider::ErrorCode
    Reason = OpenFeatureProvider::Reason
    ResolutionDetails = OpenFeatureProvider::ResolutionDetails
    FLAG_TYPES = %i[boolean string number integer float object].freeze
    ERROR_CODES = {
      "CLIENT_CLOSED" => ErrorCode::PROVIDER_NOT_READY,
      "NO_CONFIG" => ErrorCode::PROVIDER_NOT_READY,
      "KEY_NOT_FOUND" => ErrorCode::FLAG_NOT_FOUND,
      "UNSUPPORTED_TYPE" => ErrorCode::TYPE_MISMATCH,
      "TYPE_MISMATCH" => ErrorCode::TYPE_MISMATCH,
      "MALFORMED_VALUE" => ErrorCode::PARSE_ERROR,
      "MALFORMED_CONFIG" => ErrorCode::PARSE_ERROR,
      "VALUE_NOT_BOOL" => ErrorCode::PARSE_ERROR
    }.freeze

    attr_reader :metadata

    # The caller owns the lifecycle and polling configuration of its client.
    def initialize(client:)
      raise ArgumentError, "A Confeature client is required." unless client.is_a?(Confeature::Client)

      @client = client
      @metadata = OpenFeatureProvider::ProviderMetadata.new(name: "Confeature").freeze
    end

    FLAG_TYPES.each do |type|
      define_method(:"fetch_#{type}_value") do |flag_key:, default_value:, evaluation_context: nil|
        resolve(type, flag_key, default_value, evaluation_context)
      end
    end

    private

    def resolve(type, key, fallback, context)
      return failed(fallback, ErrorCode::TYPE_MISMATCH) if type == :object

      attributes = Context.user_attributes(context)
      return failed(fallback, ErrorCode::INVALID_CONTEXT) if attributes.nil?

      details = Confeature::Internal::ProviderEvaluation.evaluate(
        @client, key, fallback, flag_type: type, **attributes
      )
      if details.is_default_value || !details.error.nil?
        return failed(fallback, ERROR_CODES.fetch(details.error, ErrorCode::GENERAL))
      end

      ResolutionDetails.new(value: details.value, variant: details.variation_id, reason: reason(details))
    end

    def failed(fallback, code)
      ResolutionDetails.new(value: fallback, reason: Reason::ERROR, error_code: code)
    end

    def reason(details)
      return Reason::SPLIT unless details.matched_percentage_option.nil?
      return Reason::TARGETING_MATCH unless details.matched_targeting_rule.nil?

      Reason::UNKNOWN
    end
  end
end
