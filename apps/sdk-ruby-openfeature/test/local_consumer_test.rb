# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "minitest/autorun"
require "confeature_openfeature"
require "open_feature/sdk/isolated"

class LocalConsumerTest < Minitest::Test
  SDK = OpenFeature::SDK
  KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

  class MeasuredClient < Confeature::Client
    attr_reader :details_calls, :hook_accesses

    def initialize(**options)
      @details_calls = 0
      @hook_accesses = 0
      super
    end

    def get_value_details(...)
      @details_calls += 1
      super
    end

    def hooks
      @hook_accesses += 1
      super
    end
  end

  def setup
    @native = MeasuredClient.new(
      sdk_key: KEY, polling_mode: Confeature::PollingMode.manual_poll, cache_directory: :memory,
      default_user: Confeature::User.new(identifier: "native-default"),
      flag_overrides: Confeature::FlagOverrides.new(
        data_source: Confeature::ConfigOverrideDataSource.new(settings),
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
    )
    @api = SDK::Isolated.create_api
    @api.set_provider_and_wait(ConfeatureOpenFeature::Provider.new(client: @native), domain: "fixture")
    @client = @api.build_client(domain: "fixture")
  end

  def teardown
    @api&.shutdown
    @native&.close
  end

  def test_absent_targeting_key_and_custom_percentage_attribute
    absent = SDK::EvaluationContext.new(Identifier: "shadow", plan: "beta")
    result = @client.fetch_boolean_details(flag_key: "identity", default_value: true, evaluation_context: absent)
    assert_equal [false, "baseline", nil], [result.value, result.variant, result.error_code]

    empty = SDK::EvaluationContext.new(targeting_key: "")
    result = @client.fetch_boolean_details(flag_key: "identity", default_value: false, evaluation_context: empty)
    assert_equal [true, "rolled", "SPLIT"], [result.value, result.variant, result.reason]

    result = @client.fetch_boolean_details(flag_key: "custom", default_value: false, evaluation_context: absent)
    assert_equal [true, "rolled", "SPLIT"], [result.value, result.variant, result.reason]
    assert_equal 3, @native.details_calls
    assert_equal 0, @native.hook_accesses
  end

  def test_number_uses_the_stored_type_and_preserves_native_errors
    result = @client.fetch_number_details(flag_key: "integer", default_value: 0.1)
    assert_equal [2, "two", nil], [result.value, result.variant, result.error_code]
    result = @client.fetch_number_details(flag_key: "decimal", default_value: 0)
    assert_equal [0.5, "half", nil], [result.value, result.variant, result.error_code]
    result = @client.fetch_integer_details(flag_key: "decimal", default_value: 99)
    assert_equal [99, "TYPE_MISMATCH"], [result.value, result.error_code]
    result = @client.fetch_float_details(flag_key: "unknown", default_value: 0.0)
    assert_equal [0.0, "FLAG_NOT_FOUND"], [result.value, result.error_code]
  end

  def test_typed_integer_and_float_resolvers_return_native_variants
    integer = @client.fetch_integer_details(flag_key: "integer", default_value: 0)
    decimal = @client.fetch_float_details(flag_key: "decimal", default_value: 0.0)

    assert_equal [2, "two", nil], [integer.value, integer.variant, integer.error_code]
    assert_equal [0.5, "half", nil], [decimal.value, decimal.variant, decimal.error_code]
    assert_equal 2, @native.details_calls
  end

  def test_string_targeting_uses_the_merged_api_transaction_client_and_invocation_context
    @api.configure do |configuration|
      configuration.evaluation_context = SDK::EvaluationContext.new(plan: "api", region: "eu")
    end
    @api.set_transaction_context_propagator(SDK::ThreadLocalTransactionContextPropagator.new)
    @api.set_transaction_context(SDK::EvaluationContext.new(plan: "transaction", transport: "isolated"))
    @client.evaluation_context = SDK::EvaluationContext.new(plan: "client", surface: "checkout")

    context = SDK::EvaluationContext.new(plan: "invocation")
    targeted = @client.fetch_string_details(flag_key: "text", default_value: "fallback", evaluation_context: context)
    baseline = @client.fetch_string_details(flag_key: "text", default_value: "fallback")

    assert_equal ["example", "text-variant", "TARGETING_MATCH", nil],
                 [targeted.value, targeted.variant, targeted.reason, targeted.error_code]
    assert_equal ["original", "text-baseline", nil], [baseline.value, baseline.variant, baseline.error_code]
    assert_equal 2, @native.details_calls
  ensure
    @api.set_transaction_context(nil)
  end

  def test_object_returns_fallback_without_a_native_call
    fallback = { "value" => true }
    result = @client.fetch_object_details(flag_key: "integer", default_value: fallback)
    assert_same fallback, result.value
    assert_equal "TYPE_MISMATCH", result.error_code
    assert_equal 0, @native.details_calls
  end

  def test_openfeature_shutdown_preserves_the_native_client
    @api.shutdown

    assert_equal true, @native.get_value("identity", false)
    assert_equal 0, @native.hook_accesses
  end

  private

  def settings
    split = {
      "t" => 0, "v" => { "b" => false }, "i" => "baseline",
      "p" => [{ "p" => 100, "v" => { "b" => true }, "i" => "rolled" }]
    }
    text_conditions = { "plan" => "invocation", "region" => "eu", "transport" => "isolated", "surface" => "checkout" }
                      .map { |name, value| { "u" => { "a" => name, "c" => 28, "s" => value } } }
    {
      "f" => {
        "identity" => split,
        "custom" => split.merge("a" => "plan"),
        "text" => {
          "t" => 1, "v" => { "s" => "original" }, "i" => "text-baseline",
          "r" => [{ "c" => text_conditions, "s" => { "v" => { "s" => "example" }, "i" => "text-variant" } }]
        },
        "integer" => { "t" => 2, "v" => { "i" => 2 }, "i" => "two" },
        "decimal" => { "t" => 3, "v" => { "d" => 0.5 }, "i" => "half" }
      }
    }
  end
end
