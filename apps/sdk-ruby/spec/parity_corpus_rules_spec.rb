# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Targeting-rule parity (spec 135 / #431, epic #382, US3) — the
# CORPUS_RULES corpus injected through the full-config offline override.
#
# Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which
# feed a value-only `overridesMap` via `MapOverrideDataSource`), the rule
# corpus carries the whole `{ p, f, s }` config and is injected via
# `Confeature.create_flag_overrides_from_config` +
# `OverrideBehaviour::LOCAL_ONLY`. The SDK then resolves targeting rules /
# segments / % options offline through the real Ruby evaluator, exactly
# as it would against a CDN-served config — no network round-trip.
#
# Runner contract (mirrors apps/sdk-node/tests/parity/parity-rules.test.ts
# + the Python / .NET ports): every tuple branches on the config's
# `injectionMode`:
#   - `"full-config"` → capability-probe
#     `Confeature.create_flag_overrides_from_config`. If sdk-ruby exposes
#     it, build the override and assert the PUBLIC `client.get_value`
#     returns `tuple["expected"]`. If it does NOT, SKIP with a reason —
#     NEVER fall back to the flat-map path (SC-004: no `"full-config"`
#     tuple is ever resolved on the map path, and a skip is reported with
#     its reason).
#
# sdk-ruby HAS adopted the full-config path, so every loaded rule tuple runs
# and passes; there are no skips for this family.
#
# Constitution invariant (Principle II NON-NEGOTIABLE): every loaded tuple
# MUST pass. If a tuple drifts and it is a real Ruby targeting-rule engine
# gap (not an override-wiring bug), STOP and file a discrete #382 follow-up —
# never a corpus or test workaround (AC4 / SC-004).

# Capability probe: does this SDK expose the full-config override factory?
# The full-config path is gated on this — never silently resolved on the
# flat-map path (SC-004).
HAS_FULL_CONFIG_OVERRIDES =
  Confeature.respond_to?(:create_flag_overrides_from_config)

# config_v6 setting-type tags: INT (t=2) and DOUBLE (t=3). The evaluator's
# int-vs-double TYPE_MISMATCH guard is STRICT (Principle II) — an Integer
# default refuses a DOUBLE setting and vice versa. Declared at module scope so
# the constants do not leak from inside the RSpec block.
SETTING_TYPE_INT = 2
SETTING_TYPE_DOUBLE = 3

# Non-finite number tags from the typed-attribute corpus encoding (#479).
# `JSON.stringify(NaN|±Infinity)` is lossy `null`, so the exporter tags the
# value `{"$num" => "NaN"|"Infinity"|"-Infinity"}`; the runner rehydrates each
# to the matching Ruby Float. Declared at module scope (mirroring the SETTING_*
# constants) so it does not leak from inside the RSpec block.
NON_FINITE_NUM = {
  "NaN" => Float::NAN,
  "Infinity" => Float::INFINITY,
  "-Infinity" => -Float::INFINITY
}.freeze

RSpec.describe "parity corpus rules" do
  let(:tuples) { SpecHelpers.parity_corpus_rules }
  let(:configs) { SpecHelpers.parity_configs_rules }

  it "is non-empty (append-only floor)" do
    # Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
    # foundational #383 tuples are never removed) and grows with every
    # comparator spec, so we assert only that the fixture actually loaded —
    # not a hardcoded total that re-trips on every growth. Per-tuple
    # correctness is covered by the per-tuple example below, and JSON↔TS sync
    # is owned by the central `check:exports` gate, so this guard is purely a
    # non-empty smoke and never needs a per-spec bump.
    expect(tuples.size).to be >= 8
  end

  it "exposes the full-config override factory (no skips)" do
    expect(HAS_FULL_CONFIG_OVERRIDES).to be(true),
                                         "Confeature.create_flag_overrides_from_config must be exposed; " \
                                         "sdk-ruby has adopted the full-config override path (#431)."
  end

  it "matches every targeting-rule tuple via public get_value" do
    failures = []
    skips = []

    tuples.each do |tuple|
      cfg = configs.fetch(tuple["configId"]) do
        raise "rule corpus references unknown configId=#{tuple["configId"].inspect}"
      end

      injection_mode = cfg["injectionMode"]
      # The rule corpus is full-config only; a flat-map tuple here would
      # mean a corpus regression, never a silent flat-map fallback (SC-004).
      unless injection_mode == "full-config"
        raise "rule corpus tuple #{tuple["description"].inspect} has unexpected " \
              "injectionMode=#{injection_mode.inspect}; expected 'full-config'."
      end

      unless HAS_FULL_CONFIG_OVERRIDES
        # SC-004: NEVER fall back to the flat-map path — skip with a reason.
        skips << "#{tuple["description"]}: SDK has not adopted full-config overrides"
        next
      end

      failures.concat(resolve_tuple(tuple, cfg))
    end

    skips.each { |reason| RSpec.configuration.reporter.message("SKIP (SC-004): #{reason}") }

    expect(failures).to be_empty, lambda {
      "#{failures.size}/#{tuples.size} targeting-rule tuples drifted — " \
        "Constitution Principle II NON-NEGOTIABLE; investigate the evaluator / " \
        "override router, do NOT mutate the corpus. If this is a real Ruby " \
        "targeting-rule engine gap (not an override-wiring bug), STOP and file " \
        "a discrete #382 follow-up — never a corpus or test workaround.\n\n" \
        "#{failures.join("\n\n")}"
    }
  end

  # Resolve one full-config rule tuple through the PUBLIC client and return a
  # list of failure messages (empty on success). When the tuple carries an
  # `expectedVariationId` (spec 152 / #475, US2), resolve through
  # `get_value_details` so the SAME call yields BOTH the value and the
  # `.variation_id` identity — then assert both. The config drives the
  # full-config override path, so `variation_id` must survive the
  # override→details router (#395 gap class).
  def resolve_tuple(tuple, cfg)
    flag_overrides = Confeature.create_flag_overrides_from_config(
      cfg["config"],
      Confeature::OverrideBehaviour::LOCAL_ONLY
    )
    client = Confeature::Client.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
      polling_mode: Confeature::PollingMode.manual_poll,
      flag_overrides: flag_overrides,
      cache_directory: :memory,
      logger: SpecHelpers::SilentLogger.new
    )

    user = build_user(tuple["user"])
    # Type the corpus `defaultValue` to the flag's declared numeric kind so the
    # evaluator's STRICT int-vs-double TYPE_MISMATCH guard is satisfied without
    # relaxing the engine (default-TYPING fix, not a value/comparison weakening
    # — values still compare numerically).
    default_value = typed_default(cfg["config"], tuple["key"], tuple["defaultValue"])
    expected_variation_id = tuple["expectedVariationId"]

    begin
      if expected_variation_id.nil?
        actual = client.get_value(tuple["key"], default_value, user)
        actual_variation_id = nil
      else
        details = client.get_value_details(tuple["key"], default_value, user)
        actual = details.value
        actual_variation_id = details.variation_id
      end
    ensure
      client.close
    end

    collect_tuple_failures(tuple, actual, expected_variation_id, actual_variation_id)
  end

  def collect_tuple_failures(tuple, actual, expected_variation_id, actual_variation_id)
    unless parity_value_match?(tuple["expected"], actual)
      return ["Targeting-rule parity drift on #{tuple["description"].inspect}\n  " \
              "expected: #{tuple["expected"].inspect} (#{value_kind(tuple["expected"])})\n  " \
              "actual:   #{actual.inspect} (#{value_kind(actual)})"]
    end

    return [] if expected_variation_id.nil?
    return [] if actual_variation_id == expected_variation_id

    ["variationId parity drift on #{tuple["description"].inspect}\n  " \
     "expected: #{expected_variation_id.inspect}\n  " \
     "actual:   #{actual_variation_id.inspect}\n  " \
     "(the PUBLIC get_value_details must propagate the evaluator " \
     "variationId through the full-config override path — #395 gap class)"]
  end

  def build_user(raw)
    return nil if raw.nil?

    Confeature::User.new(
      identifier: raw["identifier"] || "",
      email: raw["email"],
      country: raw["country"],
      custom: decode_custom(raw["custom"])
    )
  end

  # Rehydrate a `user.custom` map from the typed-attribute encoding (spec 151 /
  # #468, #479). The JSON corpus encodes each value by its NATURAL JSON type
  # (string→String, number→Numeric, bool→bool, string[]→Array) with two tagged
  # exceptions:
  #   - a Date is `{"$date" => <unix-epoch-seconds>}`, rehydrated to a UTC
  #     `Time` at those (fractional) epoch seconds — the inverse of the
  #     exporter's `getTime() / 1000`.
  #   - a non-finite number is `{"$num" => "NaN"|"Infinity"|"-Infinity"}`
  #     (#479), rehydrated to the matching Ruby `Float` — because
  #     `JSON.stringify(NaN|±Infinity)` collapses to a lossy `null`, the
  #     exporter tags the value instead so the 6 number/date-to-string
  #     conversion tuples round-trip the actual float, not an ABSENT attribute.
  # Every other shape passes through verbatim to the typed
  # `Confeature::User.custom`.
  def decode_custom(custom)
    return nil if custom.nil?

    custom.transform_values { |raw| decode_custom_value(raw) }
  end

  def decode_custom_value(value)
    return value unless value.is_a?(Hash)

    if value.keys == ["$date"]
      Time.at(value["$date"]).utc
    elsif value.keys == ["$num"]
      NON_FINITE_NUM.fetch(value["$num"]) do
        raise "unknown $num tag #{value["$num"].inspect}; expected " \
              "NaN/Infinity/-Infinity (#479)"
      end
    else
      value
    end
  end

  # Coerce the corpus `defaultValue` to match the flag's declared numeric kind.
  # The corpus encodes numeric defaults in their natural JSON type (the 4
  # decimal tuples carry default `-1`, parsed as a Ruby Integer), so we widen
  # it to the setting's declared `t` (Float for t=3, Integer for t=2) — fixing
  # the runner, NEVER relaxing the engine. Read `t` from the config, not the
  # `expected` type, since a whole-numbered decimal parses from JSON as Integer.
  # `true`/`false` are not Numeric in Ruby, so a boolean default is never
  # coerced here.
  def typed_default(config, key, default)
    return default unless default.is_a?(Numeric)

    settings = config["f"] if config.is_a?(Hash)
    setting = settings[key] if settings.is_a?(Hash)
    setting_type = setting["t"] if setting.is_a?(Hash)

    case setting_type
    when SETTING_TYPE_DOUBLE then default.to_f
    when SETTING_TYPE_INT then default.to_i
    else default
    end
  end

  # Compare a resolved parity value against its expected. Ruby's `==` already
  # compares Integer/Float NUMERICALLY (`0 == 0.0` is true), so a whole DOUBLE
  # expectation encoded as a JSON integer (e.g. decimal base `0`) still matches
  # a resolved Float `0.0`. `true`/`false` are NOT Numeric and never `==` a
  # number, so int-vs-bool parity stays strict (Principle II).
  def parity_value_match?(expected, actual)
    expected == actual
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
