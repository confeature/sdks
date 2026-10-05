# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Spec 043 US1 parity gate — 58/58 byte-identical to ConfigCat.
#
# Loads the TS-generated parity corpus and the canonical configs from
# `packages/test-fixtures-sdk-parity/fixtures/`, builds one
# `Confeature::Client` per tuple in `ManualPoll` mode with a
# `LOCAL_ONLY` override bundle holding the tuple's config-specific
# map, and asserts that the resolved value equals the recorded
# `expected` field byte-for-byte.
#
# Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST
# pass. If a tuple drifts, STOP and investigate the override-eval /
# evaluator code — never mutate the corpus to make the test green.

RSpec.describe "parity corpus" do
  let(:tuples) { SpecHelpers.parity_corpus }
  let(:configs) { SpecHelpers.parity_configs }

  it "has 58 tuples" do
    expect(tuples.size).to eq(58)
  end

  it "matches every tuple byte-identically" do
    failures = []

    tuples.each do |tuple|
      cfg = configs.fetch(tuple["configId"]) do
        raise "corpus references unknown configId=#{tuple["configId"].inspect}"
      end

      data_source = Confeature::MapOverrideDataSource.new(cfg["overridesMap"])
      flag_overrides = Confeature::FlagOverrides.new(
        data_source: data_source,
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )

      client = Confeature::Client.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: flag_overrides,
        cache_directory: :memory,
        logger: SpecHelpers::SilentLogger.new
      )

      user = build_user(tuple["user"])
      actual = client.get_value(tuple["key"], tuple["defaultValue"], user)
      client.close

      next if actual == tuple["expected"]

      failures << "Parity drift on #{tuple["description"].inspect}\n  " \
                  "expected: #{tuple["expected"].inspect} (#{value_kind(tuple["expected"])})\n  " \
                  "actual:   #{actual.inspect} (#{value_kind(actual)})"
    end

    expect(failures).to be_empty, lambda {
      "#{failures.size}/#{tuples.size} parity tuples drifted — " \
        "Constitution Principle II NON-NEGOTIABLE; investigate the " \
        "evaluator / override-eval code, do NOT mutate the corpus.\n\n" \
        "#{failures.join("\n\n")}"
    }
  end

  def build_user(raw)
    return nil if raw.nil?

    Confeature::User.new(
      identifier: raw["identifier"] || "",
      email: raw["email"],
      country: raw["country"],
      custom: raw["custom"]
    )
  end

  def value_kind(value)
    case value
    when true, false then "bool"
    when Integer then "int"
    when Float then "float"
    when String then "string"
    when nil then "nil"
    else value.class.name
    end
  end
end
