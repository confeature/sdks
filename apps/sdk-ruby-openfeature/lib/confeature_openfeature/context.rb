# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "date"

module ConfeatureOpenFeature
  module Context
    TARGETING_KEY = OpenFeature::SDK::EvaluationContext::TARGETING_KEY
    RESERVED = [TARGETING_KEY, "Identifier", "Email", "Country"].freeze

    module_function

    def user_attributes(context)
      identifier = context&.targeting_key
      return unless identifier.nil? || identifier.is_a?(String)

      fields = context&.fields || {}
      {
        identifier: identifier&.dup,
        email: copy_string(fields["Email"]),
        country: copy_string(fields["Country"]),
        custom: custom_attributes(fields)
      }
    end

    def copy_string(value)
      value.dup if value.is_a?(String)
    end

    def custom_attributes(fields)
      fields.each_with_object({}) do |(key, value), custom|
        next if RESERVED.include?(key)

        selected = attribute_value(value)
        custom[key] = selected unless selected.nil?
      end
    end

    def attribute_value(value)
      case value
      when String, Time, DateTime then value.dup
      when Integer, TrueClass, FalseClass then value
      when Float then value if value.finite?
      when Array then value.map(&:dup) if value.all?(String)
      end
    end
  end
end
