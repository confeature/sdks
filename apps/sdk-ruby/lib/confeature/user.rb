# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  # Targeting context for flag evaluation.
  #
  # Field names mirror the upstream `configcat` gem's `User` 1:1
  # (Constitution Principle II). The evaluator consumes `identifier`,
  # `email`, `country`, and typed `custom` attributes.
  #
  # `custom` accepts TYPED values, matching the upstream `configcat`
  # gem's `User` (which stores `custom` verbatim — no stringification).
  # A value may be a `String`, `Integer`, `Float`, `Time`/`DateTime`,
  # `true`/`false`, or `Array<String>`. The evaluator converts each
  # non-string value per ConfigCat's documented comparator semantics
  # (number → invariant decimal string, date → Unix epoch seconds,
  # string array → JSON). Keys are coerced to `String`; values pass
  # through verbatim so the evaluator can apply type-specific
  # conversions (string values behave byte-identically to before).
  class User
    attr_reader :identifier, :email, :country, :custom

    # @param identifier [String] Stable user identifier (required, empty allowed).
    # @param email [String, nil] Optional contact email.
    # @param country [String, nil] Optional ISO country code or country tag.
    # @param custom [Hash{String => Object}, nil] Optional map of typed custom
    #   attributes (String / Integer / Float / Time / DateTime / boolean /
    #   Array<String>). Values are NOT stringified — they pass through verbatim
    #   to the evaluator (matches the upstream `configcat` gem 1:1).
    def initialize(identifier:, email: nil, country: nil, custom: nil)
      @identifier = identifier
      @email = email
      @country = country
      @custom = custom.nil? ? nil : custom.transform_keys(&:to_s).freeze
      freeze
    end

    def ==(other)
      other.is_a?(User) &&
        identifier == other.identifier &&
        email == other.email &&
        country == other.country &&
        custom == other.custom
    end
    alias eql? ==

    def hash
      [identifier, email, country, custom].hash
    end
  end
end
