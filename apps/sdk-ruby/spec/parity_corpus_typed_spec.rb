# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Spec 072 US2 typed-parity gate — 13/13 byte-identical to ConfigCat.
#
# Sibling to `parity_corpus_spec.rb`. Loads the 13-tuple typed corpus
# + the typed configs from `packages/test-fixtures-sdk-parity/fixtures/`,
# builds one `Confeature::Client` per tuple in `ManualPoll` mode with a
# `LOCAL_ONLY` override bundle holding the tuple's config-specific
# typed map, and asserts that the widened Ruby evaluator resolves each
# tuple to its `expected` value.
#
# Ruby's strict typing matters for `t=3` (double) settings: the corpus
# carries the `feature.zero-threshold` slot as JSON `0`, which `JSON.parse`
# decodes as an `Integer`. The evaluator requires a `Float` for the `d`
# slot. We rehydrate the corpus per setting type so that doubles arrive
# as `Float` even when the JSON source encoding is integer-valued. The
# same normalisation applies to the override map (an Integer `0` would
# otherwise hit Branch 6 of override-eval as a TYPE_MISMATCH versus a
# `Float` default). The Python typed driver does the same — see
# `apps/sdk-python/tests/parity/test_parity_corpus_typed.py`.
#
# Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST
# pass. If a tuple drifts, STOP and investigate the evaluator code —
# never mutate the corpus to make the test green.

RSpec.describe "parity corpus typed" do
  # Setting-type discriminators — mirror Evaluator::SETTING_TYPE_*.
  SETTING_TYPE_INT = 2
  SETTING_TYPE_DOUBLE = 3

  let(:tuples) { SpecHelpers.parity_corpus_typed }
  let(:configs) { SpecHelpers.parity_configs_typed }

  it "has 13 tuples" do
    expect(tuples.size).to eq(13)
  end

  it "matches every tuple byte-identically" do
    failures = []

    tuples.each do |tuple|
      cfg = configs.fetch(tuple["configId"]) do
        raise "typed corpus references unknown configId=#{tuple["configId"].inspect}"
      end

      setting_types = setting_types_by_key(cfg)
      overrides_map = normalise_overrides(cfg["overridesMap"], setting_types)

      default_value = tuple["defaultValue"]
      expected = tuple["expected"]
      setting_type = setting_types[tuple["key"]]
      unless setting_type.nil?
        default_value = normalise_for_setting_type(default_value, setting_type)
        expected = normalise_for_setting_type(expected, setting_type)
      end

      data_source = Confeature::MapOverrideDataSource.new(overrides_map)
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
      actual = client.get_value(tuple["key"], default_value, user)
      client.close

      next if actual == expected && actual.instance_of?(expected.class)

      failures << "Typed parity drift on #{tuple["description"].inspect}\n  " \
                  "expected: #{expected.inspect} (#{expected.class})\n  " \
                  "actual:   #{actual.inspect} (#{actual.class})"
    end

    expect(failures).to be_empty, lambda {
      "#{failures.size}/#{tuples.size} typed parity tuples drifted — " \
        "Constitution Principle II NON-NEGOTIABLE; investigate the " \
        "evaluator / override-eval code, do NOT mutate the corpus.\n\n" \
        "#{failures.join("\n\n")}"
    }
  end

  # Extract per-key `t` discriminators from a typed config record.
  def setting_types_by_key(config_record)
    out = {}
    settings = config_record.dig("config", "f")
    return out unless settings.is_a?(Hash)

    settings.each do |key, setting|
      next unless setting.is_a?(Hash)

      t = setting["t"]
      out[key] = t if t.is_a?(Integer)
    end
    out
  end

  # Rehydrate a JSON-decoded primitive against a `SettingType`. JSON
  # has one numeric type; Ruby's strict evaluator distinguishes
  # `Integer` (`t=2`) and `Float` (`t=3`). Pass-through for bools and
  # strings so TYPE_MISMATCH tuples still surface through the evaluator.
  def normalise_for_setting_type(value, setting_type)
    return value if [true, false].include?(value)

    case setting_type
    when SETTING_TYPE_INT
      value.is_a?(Float) ? value.to_i : value
    when SETTING_TYPE_DOUBLE
      value.is_a?(Integer) ? value.to_f : value
    else
      value
    end
  end

  def normalise_overrides(overrides, setting_types)
    overrides.each_with_object({}) do |(key, value), acc|
      st = setting_types[key]
      acc[key] = st.nil? ? value : normalise_for_setting_type(value, st)
    end
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
end
