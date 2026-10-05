# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# ConfigCat conformance — replays the vendored upstream evaluation matrix
# (spec 120). Mirrors the spec-117 TS reference suite
# (`packages/sdk-shared/tests/parity-upstream.test.ts`) and the spec-118 Python
# port (`apps/sdk-python/tests/parity/test_upstream_corpus.py`) in Ruby. The
# corpus (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
# `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is the
# oracle: each `(config, key, user) → expected` tuple is checked against
# `Evaluator.evaluate(...).value` (and `.variation_id` for the variation-id
# matrix).
#
# Scope = the full conformance surface (SC-001): US1 targeting rules, US2 the 36
# comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
# multilevel + circular detection) / AND-groups, US5 attribute conversion +
# trimming + typed-attribute validation + variationId/matched detail. Per FR-017
# only structured value/identity is asserted (no textual trace).
#
# The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
# faithfully — most critically the Go `csv.Reader` LazyQuotes semantics (a `"`
# only opens a quoted field at the field start), without which every JSON-array
# attribute cell is corrupted. The CSV is parsed by a hand-rolled LazyQuotes
# reader (`parse_csv_line`) rather than the stdlib `CSV` library — stdlib `CSV`
# both mis-parses the LazyQuotes JSON-array cells AND is no longer a default gem
# (Ruby 3.4+), so the manual port is the correct + dependency-free choice.

require "json"

# Corpus loaders, CSV/cell parsers, and assertion helpers for the upstream
# conformance matrix. Lives at file scope (NOT inside the `RSpec.describe`
# block) so the curated constants — the matrix→SDK-key table, the conversion /
# trimming driver tables, the regex literals — are module constants rather than
# leaky in-block declarations (`Lint/ConstantDefinitionInBlock` /
# `RSpec/LeakyConstantDeclaration`). Mirrors how `spec/spec_helper.rb` keeps
# `SpecHelpers` fixtures + `SAMPLE_SDK_KEY` at module scope. Every method here is
# a pure function of its arguments (no RSpec DSL); the example groups below
# `include` this module to call them and assert on the collected drift.
module ParityUpstreamCorpus
  module_function

  Evaluator = Confeature::Internal::Evaluator
  UPSTREAM_DIR = SpecHelpers.upstream_corpus_dir
  NULL_TOKEN = "##null##"

  # A targeting-context value object whose custom attributes stay TYPED. The
  # public `Confeature::User` stringifies custom values (its documented
  # contract); the conversion-driver cases feed numbers / arrays / epochs that
  # MUST reach the comparator layer un-stringified. The evaluator reads
  # attributes duck-typed, so this stand-in is sufficient and avoids redesigning
  # the public surface.
  CorpusUser = Struct.new(:identifier, :email, :country, :custom, keyword_init: true)

  # Matrix → SDK key mapping (verbatim from upstream-corpus.ts MATRIX_TO_SDK_KEY).
  PKD = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
  JCP = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"
  MATRIX_TO_SDK_KEY = [
    { matrix: "testmatrix.csv", sdk_key: "#{PKD}AG6C1ngVb0CvM07un6JisQ", kind: "value" },
    { matrix: "testmatrix_semantic.csv", sdk_key: "#{PKD}iV8vH2MBakKxkFZylxHmTg", kind: "value" },
    { matrix: "testmatrix_number.csv", sdk_key: "#{PKD}FCWN-k1dV0iBf8QZrDgjdw", kind: "value" },
    { matrix: "testmatrix_semantic_2.csv", sdk_key: "#{PKD}U8nt3zEhDEO5S2ulubCopA", kind: "value" },
    { matrix: "testmatrix_sensitive.csv", sdk_key: "#{PKD}-0YmVOUNgEGKkgRF-rU65g", kind: "value" },
    { matrix: "testmatrix_segments_old.csv", sdk_key: "#{PKD}y_ZB7o-Xb0Swxth-ZlMSeA", kind: "value" },
    { matrix: "testmatrix_and_or.csv", sdk_key: "#{JCP}ByMO9yZNn02kXcm72lnY1A", kind: "value" },
    { matrix: "testmatrix_comparators_v6.csv", sdk_key: "#{JCP}OfQqcTjfFUGBwMKqtyEOrQ", kind: "value" },
    { matrix: "testmatrix_prerequisite_flag.csv", sdk_key: "#{JCP}JoGwdqJZQ0K2xDy7LnbyOg", kind: "value" },
    { matrix: "testmatrix_segments.csv", sdk_key: "#{JCP}h99HYXWWNE2bH8eWyLAVMA", kind: "value" },
    { matrix: "testmatrix_unicode.csv", sdk_key: "#{JCP}Da6w8dBbmUeMUBhh0iEeQQ", kind: "value" },
    { matrix: "testmatrix_variationId.csv", sdk_key: "#{PKD}spQnkRTIPEWVivZkWM84lQ", kind: "variation" }
  ].freeze

  # `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob was
  # NOT captured by the spec-117 vendoring (known DATA gap #401, not an engine
  # gap). The multilevel-prerequisite path IS exercised by the 3-level
  # circular_dep chain + the reconstructed-chain unit test below. Excluded LOUDLY
  # here (same marker the TS / Python references use), never silently skipped.
  UNVENDORED_EVAL_LOG_KEYS = ["dependentFeatureMultipleLevels"].freeze

  VALUE_MATRICES = %w[
    testmatrix.csv testmatrix_comparators_v6.csv testmatrix_semantic.csv
    testmatrix_semantic_2.csv testmatrix_number.csv testmatrix_sensitive.csv
    testmatrix_unicode.csv
  ].freeze

  US4_MATRICES = %w[
    testmatrix_and_or.csv testmatrix_segments.csv
    testmatrix_segments_old.csv testmatrix_prerequisite_flag.csv
  ].freeze

  ATTRIBUTE_CONVERSION_DRIVER = [
    { key: "numberToStringConversion", custom1: 0.12345, expected: "1" },
    { key: "numberToStringConversionInt", custom1: 125, expected: "4" },
    { key: "numberToStringConversionPositiveExp", custom1: -1.23456789e96, expected: "2" },
    { key: "numberToStringConversionNegativeExp", custom1: -1.23456789e-96, expected: "4" },
    { key: "numberToStringConversionNaN", custom1: Float::NAN, expected: "3" },
    { key: "numberToStringConversionPositiveInf", custom1: Float::INFINITY, expected: "4" },
    { key: "numberToStringConversionNegativeInf", custom1: -Float::INFINITY, expected: "3" },
    { key: "dateToStringConversion", custom1: 1_680_307_199.999, expected: "3" },
    { key: "dateToStringConversionNaN", custom1: Float::NAN, expected: "3" },
    { key: "dateToStringConversionPositiveInf", custom1: Float::INFINITY, expected: "1" },
    { key: "dateToStringConversionNegativeInf", custom1: -Float::INFINITY, expected: "5" },
    { key: "stringArrayToStringConversion", custom1: ["read", "Write", " eXecute "], expected: "4" },
    { key: "stringArrayToStringConversionEmpty", custom1: [], expected: "5" },
    { key: "stringArrayToStringConversionSpecialChars", custom1: ["+<>%\"'\\/\t\r\n"], expected: "3" },
    { key: "stringArrayToStringConversionUnicode", custom1: ["äöüÄÖÜçéèñışğâ¢™✓😀"], expected: "2" }
  ].freeze

  TRIMMING_KEYS = [
    %w[isoneof isnotoneof isoneofhashed isnotoneofhashed equalshashed notequalshashed
       arraycontainsanyofhashed arraynotcontainsanyofhashed equals notequals startwithanyof
       notstartwithanyof endswithanyof notendswithanyof arraycontainsanyof arraynotcontainsanyof
       startwithanyofhashed notstartwithanyofhashed endswithanyofhashed notendswithanyofhashed].map do |k|
      { key: k, expected: "no trim" }
    end,
    [
      { key: "semverisoneof", expected: "4 trim" }, { key: "semverisnotoneof", expected: "5 trim" },
      { key: "semverless", expected: "6 trim" }, { key: "semverlessequals", expected: "7 trim" },
      { key: "semvergreater", expected: "8 trim" }, { key: "semvergreaterequals", expected: "9 trim" },
      { key: "numberequals", expected: "10 trim" }, { key: "numbernotequals", expected: "11 trim" },
      { key: "numberless", expected: "12 trim" }, { key: "numberlessequals", expected: "13 trim" },
      { key: "numbergreater", expected: "14 trim" }, { key: "numbergreaterequals", expected: "15 trim" },
      { key: "datebefore", expected: "18 trim" }, { key: "dateafter", expected: "19 trim" },
      { key: "containsanyof", expected: "no trim" }, { key: "notcontainsanyof", expected: "no trim" }
    ]
  ].flatten.freeze

  VALUE_TRIMMING_KEYS = [
    %w[isoneof isnotoneof containsanyof notcontainsanyof isoneofhashed isnotoneofhashed
       equalshashed notequalshashed arraycontainsanyofhashed arraynotcontainsanyofhashed
       equals notequals startwithanyof notstartwithanyof endswithanyof notendswithanyof
       arraycontainsanyof arraynotcontainsanyof startwithanyofhashed notstartwithanyofhashed
       endswithanyofhashed notendswithanyofhashed].map { |k| { key: k, expected: "no trim" } },
    [
      { key: "semverisoneof", expected: "4 trim" }, { key: "semverisnotoneof", expected: "5 trim" },
      { key: "semverless", expected: "6 trim" }, { key: "semverlessequals", expected: "7 trim" },
      { key: "semvergreater", expected: "8 trim" }, { key: "semvergreaterequals", expected: "9 trim" }
    ]
  ].flatten.freeze

  # -------------------------------------------------------------------------
  # Cached config loaders.
  # -------------------------------------------------------------------------

  def content_by_key_map
    @content_by_key_map ||= JSON.parse(File.read(File.join(UPSTREAM_DIR, "content-by-key.json")))
  end

  def eval_log_configs_map
    @eval_log_configs_map ||=
      JSON.parse(File.read(File.join(UPSTREAM_DIR, "evaluationlog", "_configs-by-key.json")))
  end

  # -------------------------------------------------------------------------
  # CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port).
  # A `"` only opens a quoted field when it is the FIRST char of the field;
  # anywhere else it is a literal quote. Getting this wrong corrupts every
  # JSON-array attribute cell.
  # -------------------------------------------------------------------------

  # A flat single-pass state machine — the clearest faithful port of Go's
  # csv.Reader LazyQuotes loop. Kept inline (not split into a quoted-state
  # helper) because extracting that arm re-introduces block nesting or forces a
  # boolean-returning predicate; the flat `if/elsif` chain stays within the
  # nesting / length budgets without either.
  def parse_csv_line(line)
    fields = []
    field = +""
    in_quotes = false
    field_start = true
    idx = 0
    len = line.length
    while idx < len
      char = line[idx]
      # An escaped quote `""` inside a quoted field: emit one `"`, skip the pair.
      if in_quotes && char == '"' && idx + 1 < len && line[idx + 1] == '"'
        field << '"'
        idx += 1
      elsif in_quotes && char == '"'
        in_quotes = false # a lone `"` closes the quoted field
      elsif in_quotes
        field << char
      elsif char == '"' && field_start
        in_quotes = true # a `"` only opens a quote at the field start (LazyQuotes)
        field_start = false
      elsif char == ";"
        fields << field
        field = +""
        field_start = true
      else
        field << char
        field_start = false
      end
      idx += 1
    end
    fields << field
    fields
  end

  INT_RE = /\A-?\d+\z/
  FLOAT_RE = /\A-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\z/

  # Parse a CSV cell to its primitive (mirrors upstream `parseCell`).
  def parse_cell(str)
    if INT_RE.match?(str)
      n = str.to_i
      return n if n.abs <= 9_007_199_254_740_991
    end
    return Float(str) if FLOAT_RE.match?(str) && Float(str, exception: false)
    return true if str == "True"
    return false if str == "False"

    str
  end

  # Build a CorpusUser from the first four CSV columns (port `userFromRow`).
  def user_from_row(line, custom_key)
    return nil if line.empty? || line[0] == NULL_TOKEN

    set_or_none = lambda do |v|
      v.nil? || v == "" || v == NULL_TOKEN ? nil : v
    end
    identifier = !line[0].nil? && line[0] != "" ? line[0] : ""
    email = set_or_none.call(line[1])
    country = set_or_none.call(line[2])
    custom_val = set_or_none.call(line[3])
    custom = custom_val.nil? ? nil : { custom_key => custom_val }
    CorpusUser.new(identifier: identifier, email: email, country: country, custom: custom)
  end

  def load_matrix(matrix)
    entry = MATRIX_TO_SDK_KEY.find { |m| m[:matrix] == matrix }
    raise "Unknown testmatrix file: #{matrix}" if entry.nil?

    config = content_by_key_map[entry[:sdk_key]]
    raise "No config for matrix #{matrix} (sdkKey #{entry[:sdk_key]})" if config.nil?

    text = File.read(File.join(UPSTREAM_DIR, matrix), encoding: "UTF-8")
    lines = text.split(/\r?\n/).reject(&:empty?)
    header = parse_csv_line(lines[0])
    custom_key = header[3]
    setting_keys = header[4..]

    tuples = []
    lines[1..].each do |raw_line|
      cols = parse_csv_line(raw_line)
      user = user_from_row(cols, custom_key)
      setting_keys.each_with_index do |key, c|
        raw = c + 4 < cols.length ? cols[c + 4] : ""
        expected = entry[:kind] == "value" ? parse_cell(raw) : raw
        tuples << {
          matrix: matrix, key: key, user: user,
          kind: entry[:kind], expected: expected, config: config
        }
      end
    end
    tuples
  end

  # -------------------------------------------------------------------------
  # evaluationlog/<scenario> (port loadEvalLogScenario).
  # -------------------------------------------------------------------------

  def eval_log_user(raw)
    return nil if raw.nil? || raw.empty?

    identifier = ""
    email = nil
    country = nil
    custom = {}
    raw.each do |k, v|
      val = v.to_s
      case k
      when "Identifier" then identifier = val
      when "Email" then email = val
      when "Country" then country = val
      else custom[k] = val
      end
    end
    CorpusUser.new(identifier: identifier, email: email, country: country, custom: custom.empty? ? nil : custom)
  end

  def eval_log_config(suite)
    json_override = suite["jsonOverride"]
    if json_override
      path = File.join(UPSTREAM_DIR, "evaluationlog", "_overrides", json_override)
      return JSON.parse(File.read(path))
    end
    sdk_key = suite["sdkKey"]
    if sdk_key
      config = content_by_key_map[sdk_key] || eval_log_configs_map[sdk_key]
      raise "No config for eval-log sdkKey #{sdk_key}" if config.nil?

      return config
    end
    raise "Eval-log suite has neither jsonOverride nor sdkKey"
  end

  def load_eval_log_scenario(scenario)
    suite = JSON.parse(File.read(File.join(UPSTREAM_DIR, "evaluationlog", "#{scenario}.json")))
    config = eval_log_config(suite)
    suite["tests"].map do |t|
      {
        scenario: scenario, key: t["key"], default_value: t["defaultValue"],
        user: eval_log_user(t["user"]), expected_value: t["returnValue"], config: config
      }
    end
  end

  # -------------------------------------------------------------------------
  # Assertion helpers (port assertMatrixTuple / assertEvalLogValue). Each
  # collects drift strings into a `failures` array; the example group makes the
  # single `expect(failures).to be_empty` assertion so RSpec sees it directly.
  # -------------------------------------------------------------------------

  def setting_type(config, key)
    settings = config["f"]
    return nil unless settings.is_a?(Hash)

    setting = settings[key]
    return nil unless setting.is_a?(Hash)

    t = setting["t"]
    t.is_a?(Integer) && t != true && t != false ? t : nil
  end

  # Type-appropriate default matching the resolved primitive type. Ruby's
  # strict evaluator distinguishes int (t=2) from double (t=3), so the default
  # must be the SAME numeric kind the setting type expects.
  def default_for(expected, stype)
    return false if [true, false].include?(expected)
    return stype == 3 ? 0.0 : 0 if expected.is_a?(Numeric)

    "__default__"
  end

  # Cast a JSON-decoded eval-log default to the type implied by `t`.
  def coerce_default(default, stype)
    return default if [true, false].include?(default)
    return default.to_f if stype == 3 && default.is_a?(Integer)
    return default.to_i if stype == 2 && default.is_a?(Float)

    default
  end

  def assert_matrix_tuple(tuple, failures)
    config = tuple[:config]
    user = tuple[:user]
    label = "#{tuple[:matrix]} #{tuple[:key]} user=#{user_repr(user)}"
    if tuple[:kind] == "variation"
      result = Evaluator.evaluate(config, tuple[:key], nil, user)
      record_failure(failures, label, result.variation_id, tuple[:expected]) if result.variation_id != tuple[:expected]
    else
      expected = tuple[:expected]
      default = default_for(expected, setting_type(config, tuple[:key]))
      result = Evaluator.evaluate(config, tuple[:key], default, user)
      record_failure(failures, label, result.value, expected) unless value_equal?(result.value, expected)
    end
  end

  def assert_eval_log_value(tuple, failures)
    expected = tuple[:expected_value]
    stype = setting_type(tuple[:config], tuple[:key])
    default = tuple[:default_value].nil? ? default_for(expected, stype) : coerce_default(tuple[:default_value], stype)
    label = "#{tuple[:scenario]} #{tuple[:key]} user=#{user_repr(tuple[:user])}"
    result = Evaluator.evaluate(tuple[:config], tuple[:key], default, tuple[:user])
    record_failure(failures, label, result.value, expected) unless value_equal?(result.value, expected)
  end

  # Numeric-tolerant equality (5 == 5.0); booleans must not equate with ints.
  def value_equal?(actual, expected)
    if expected.is_a?(Numeric) && expected != true && expected != false
      return false if [true, false].include?(actual)
      return actual.is_a?(Numeric) && actual.nan? if expected.is_a?(Float) && expected.nan?

      return actual.is_a?(Numeric) && actual == expected
    end
    # Guard bool/int drift (true != 1 in Ruby already, but be explicit).
    return false if [true, false].include?(expected) != [true, false].include?(actual)

    actual == expected
  end

  def record_failure(failures, label, actual, expected)
    failures << "#{label}: actual=#{actual.inspect} expected=#{expected.inspect}"
  end

  def user_repr(user)
    return "nil" if user.nil?

    "id=#{user.identifier.inspect} email=#{user.email.inspect} " \
      "country=#{user.country.inspect} custom=#{user.custom.inspect}"
  end

  # Collect drift across a tuple list (matrix or eval-log). The caller asserts.
  def matrix_failures(tuples)
    failures = []
    tuples.each { |t| assert_matrix_tuple(t, failures) }
    failures
  end

  def eval_log_failures(scenario, skip_keys: [])
    failures = []
    load_eval_log_scenario(scenario).each do |t|
      next if skip_keys.include?(t[:key])

      assert_eval_log_value(t, failures)
    end
    failures
  end

  def comparison_config(fixture)
    JSON.parse(File.read(File.join(UPSTREAM_DIR, "#{fixture}.json")))
  end

  # -------------------------------------------------------------------------
  # Evaluation-log TRACE fidelity (ADR 0003 / epic #494, Ruby slice of #501).
  #
  # Replays `parity-evaluationlog.json` — each scenario tuple carries an
  # `expectedTrace` byte-string — and asserts the federated Ruby evaluator emits
  # the byte-identical textual trace. Mirrors the Python reference
  # `test_eval_log_trace_fidelity` + the Go `parity_evallog_trace_test.go` + the
  # TS `assertEvalLogTrace`: a capturing logger records every (level, eventId,
  # message) the evaluator emits during the walk (the WARN 3001/3003/3004 + ERROR
  # 1002 lines, then the INFO 5000 multi-line trace); each call is rendered
  # `"<LEVEL>: [<eventId>] <message>"` and joined with "\n". `expectedTrace` is
  # already Confeature-canonical, so this is the same byte-string every native
  # runner replays.
  # -------------------------------------------------------------------------

  TraceLevel = Confeature::Internal::EvalLogger::TraceLevel

  # The 14 scenarios that carry an `expectedTrace` (others assert value only).
  TRACE_SCENARIOS = %w[
    simple_value 1_targeting_rule 2_targeting_rules and_rules
    options_based_on_user_id options_based_on_custom_attr
    options_after_targeting_rule options_within_targeting_rule
    list_truncation number_validation circular_dep prerequisite_flag
    semver_validation epoch_date_validation
  ].freeze

  LEVEL_LABEL = {
    TraceLevel::ERROR => "ERROR",
    TraceLevel::WARN => "WARN",
    TraceLevel::INFO => "INFO",
    TraceLevel::DEBUG => "DEBUG"
  }.freeze

  # Records each emitted (level, eventId, message) for the capture string.
  # Mirrors the Go/Python tests' inline logger. `level` reports INFO so the
  # evaluator builds the trace; `log` appends each emitted line.
  class CaptureLogger
    attr_reader :calls

    def initialize
      @calls = []
    end

    def level
      TraceLevel::INFO
    end

    def log(level, event_id, message)
      @calls << [level, event_id, message]
    end
  end

  def eval_log_trace_tuples
    @eval_log_trace_tuples ||= SpecHelpers.parity_evaluationlog
  end

  # Build a User from the tuple's LOWERCASE user object (port `traceUser`):
  # `{identifier, email?, country?, custom?}`. Custom values are fed
  # un-stringified so the typed-attribute conversion cases are exercised.
  def trace_user(raw)
    return nil if raw.nil? || raw.empty?

    CorpusUser.new(
      identifier: raw["identifier"].is_a?(String) ? raw["identifier"] : "",
      email: raw["email"].is_a?(String) ? raw["email"] : nil,
      country: raw["country"].is_a?(String) ? raw["country"] : nil,
      custom: raw["custom"].is_a?(::Hash) && !raw["custom"].empty? ? raw["custom"] : nil
    )
  end

  # Coerce the JSON-decoded default to the type the setting expects. JSON decodes
  # every integral number to Integer; the strict evaluator wants a Float for a
  # double setting (`t=3`) — a wrong-kind numeric default would TYPE_MISMATCH
  # before the trace.
  def trace_default(default, config, key)
    return default if [true, false].include?(default) || !default.is_a?(Numeric)

    setting_type(config, key) == 3 ? default.to_f : default.to_i
  end

  def reconstruct_trace(logger)
    logger.calls.map { |level, event_id, message| "#{LEVEL_LABEL[level]}: [#{event_id}] #{message}" }.join("\n")
  end

  def assert_eval_log_trace(tuple, failures)
    expected = tuple["expectedTrace"]
    return if expected.nil?

    logger = CaptureLogger.new
    user = trace_user(tuple["user"])
    default = trace_default(tuple["defaultValue"], tuple["config"], tuple["key"])
    Evaluator.evaluate_traced(tuple["config"], tuple["key"], default, user, logger)
    actual = reconstruct_trace(logger)
    return if actual == expected

    failures << "trace mismatch for #{tuple["scenario"]}/#{tuple["key"]}\n" \
                "--- want ---\n#{expected}\n--- got ---\n#{actual}"
  end
end

RSpec.describe "parity upstream corpus" do
  # The corpus loaders / parsers / assertion helpers live in
  # `ParityUpstreamCorpus` (file scope, above) so its curated constant tables
  # are not leaky in-block declarations. `include` pulls the helper methods in
  # as private instance methods; the module's constants (`Evaluator`,
  # `CorpusUser`, `UNVENDORED_EVAL_LOG_KEYS`, the matrix/driver tables) resolve
  # unqualified from those instance-method bodies via ancestor lookup. Example
  # bodies that touch a constant directly qualify it through the module — that
  # keeps every constant a single module-scope definition (no re-declaration
  # inside this example group).
  include ParityUpstreamCorpus

  # =========================================================================
  # US1/US2 — value + comparator matrices
  # =========================================================================

  describe "value + comparator matrices (US1/US2)" do
    ParityUpstreamCorpus::VALUE_MATRICES.each do |matrix|
      it "matches the #{matrix} value matrix byte-identically" do
        tuples = load_matrix(matrix)
        expect(tuples).not_to be_empty
        failures = matrix_failures(tuples)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end
  end

  # =========================================================================
  # US1 — targeting-rule eval-log scenarios
  # =========================================================================

  describe "targeting-rule eval-log scenarios (US1)" do
    %w[1_targeting_rule 2_targeting_rules simple_value].each do |scenario|
      it "matches the #{scenario} targeting-rule scenario" do
        failures = eval_log_failures(scenario)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end

    it "reports the matched targeting rule (FR-011)" do
      cases = load_eval_log_scenario("1_targeting_rule")
      matching = cases.find { |c| c[:expected_value] == "Dog" }
      result = ParityUpstreamCorpus::Evaluator.evaluate(matching[:config], matching[:key], "default", matching[:user])
      expect(result.value).to eq("Dog")
      expect(result.matched_targeting_rule).not_to be_nil
      expect(result.matched_percentage_option).to be_nil
      expect(result.variation_id).to eq("d0cd8f06")
    end

    it "serves the fallback with a reason and never raises when no user (FR-016)" do
      no_user = load_eval_log_scenario("1_targeting_rule").find { |c| c[:user].nil? }
      result = ParityUpstreamCorpus::Evaluator.evaluate(no_user[:config], no_user[:key], "default", nil)
      expect(result.value).to eq("Cat")
      expect(result.error).to be_nil
      expect(result.eval_error).to include("User Object is missing")
      expect(result.matched_targeting_rule).to be_nil
    end
  end

  # =========================================================================
  # US3 — percentage rollout
  # =========================================================================

  describe "percentage rollout (US3)" do
    %w[
      options_based_on_user_id options_based_on_custom_attr
      options_after_targeting_rule options_within_targeting_rule
    ].each do |scenario|
      it "matches the #{scenario} percentage scenario" do
        failures = eval_log_failures(scenario)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end

    it "buckets deterministically (FR-005)" do
      cases = load_eval_log_scenario("options_based_on_user_id")
      with_user = cases.find { |c| !c[:user].nil? }
      config = with_user[:config]
      key = with_user[:key]
      user = with_user[:user]
      first = ParityUpstreamCorpus::Evaluator.evaluate(config, key, "default", user)
      20.times do
        again = ParityUpstreamCorpus::Evaluator.evaluate(config, key, "default", user)
        expect(again.value).to eq(first.value)
        expect(again.variation_id).to eq(first.variation_id)
      end
      expect(first.value).to eq(with_user[:expected_value])
      expect(first.matched_percentage_option).not_to be_nil
    end
  end

  # =========================================================================
  # US4 — segments / prerequisites / AND-OR matrices + scenarios
  # =========================================================================

  describe "segments / prerequisites / AND-OR (US4)" do
    ParityUpstreamCorpus::US4_MATRICES.each do |matrix|
      it "matches the #{matrix} matrix byte-identically" do
        tuples = load_matrix(matrix)
        expect(tuples).not_to be_empty
        failures = matrix_failures(tuples)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end

    %w[segment prerequisite_flag and_rules].each do |scenario|
      it "matches the #{scenario} eval-log scenario" do
        failures = eval_log_failures(scenario, skip_keys: ParityUpstreamCorpus::UNVENDORED_EVAL_LOG_KEYS)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end

    it "resolves a multilevel prerequisite through a reconstructed chain (#401 data gap)" do
      config = {
        "p" => { "u" => "", "r" => 0, "s" => "salt" },
        "s" => [],
        "f" => {
          "mainFeatureWithoutUserCondition" => { "t" => 0, "v" => { "b" => true }, "i" => "main", "r" => [] },
          "intermediateFeature" => {
            "t" => 0, "v" => { "b" => false }, "i" => "inter",
            "r" => [{
              "c" => [
                { "p" => { "f" => "mainFeatureWithoutUserCondition", "c" => 0, "v" => { "b" => true } } },
                { "p" => { "f" => "mainFeatureWithoutUserCondition", "c" => 0, "v" => { "b" => true } } }
              ],
              "s" => { "v" => { "b" => true }, "i" => "interT" }
            }]
          },
          "dependentFeatureMultipleLevels" => {
            "t" => 1, "v" => { "s" => "Cat" }, "i" => "dep",
            "r" => [{
              "c" => [{ "p" => { "f" => "intermediateFeature", "c" => 0, "v" => { "b" => true } } }],
              "s" => { "v" => { "s" => "Dog" }, "i" => "depDog" }
            }]
          }
        }
      }
      result = ParityUpstreamCorpus::Evaluator.evaluate(config, "dependentFeatureMultipleLevels", "default", nil)
      expect(result.value).to eq("Dog")
      expect(result.matched_targeting_rule).not_to be_nil
    end
  end

  # =========================================================================
  # US4 — circular-dependency termination (SC-004)
  # =========================================================================

  describe "circular-dependency termination (SC-004)" do
    it "bounds circular_dep scenarios to a fail-closed default (SC-004)" do
      failures = []
      load_eval_log_scenario("circular_dep").each do |t|
        start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        result = ParityUpstreamCorpus::Evaluator.evaluate(t[:config], t[:key], "default", t[:user])
        elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - start
        failures << "#{t[:key]} took too long (#{elapsed}s)" if elapsed >= 1.0
        failures << "#{t[:key]} value=#{result.value.inspect}" unless result.value == "default"
        failures << "#{t[:key]} no error" if result.error.nil?
      end
      expect(failures).to be_empty, -> { failures.join("\n") }
    end

    it "terminates a direct two-flag cycle" do
      config = {
        "p" => { "u" => "", "r" => 0, "s" => "salt" }, "s" => [],
        "f" => {
          "flagA" => {
            "t" => 1, "v" => { "s" => "A" }, "i" => "a",
            "r" => [{ "c" => [{ "p" => { "f" => "flagB", "c" => 0, "v" => { "b" => true } } }],
                      "s" => { "v" => { "s" => "AA" }, "i" => "aa" } }]
          },
          "flagB" => {
            "t" => 1, "v" => { "s" => "B" }, "i" => "b",
            "r" => [{ "c" => [{ "p" => { "f" => "flagA", "c" => 0, "v" => { "b" => true } } }],
                      "s" => { "v" => { "s" => "BB" }, "i" => "bb" } }]
          }
        }
      }
      result = ParityUpstreamCorpus::Evaluator.evaluate(config, "flagA", "default", nil)
      expect(result.value).to eq("default")
      expect(result.error).not_to be_nil
    end
  end

  # =========================================================================
  # US5 — normalization / conversion / trimming (comparison_*.json drivers)
  # =========================================================================

  describe "normalization / conversion / trimming (US5)" do
    it "matches comparison_attribute_conversion" do
      config = comparison_config("comparison_attribute_conversion")
      failures = []
      ParityUpstreamCorpus::ATTRIBUTE_CONVERSION_DRIVER.each do |c|
        user = ParityUpstreamCorpus::CorpusUser.new(identifier: "12345", custom: { "Custom1" => c[:custom1] })
        result = ParityUpstreamCorpus::Evaluator.evaluate(config, c[:key], "default", user)
        unless result.value == c[:expected]
          failures << "#{c[:key]} custom1=#{c[:custom1].inspect}: #{result.value.inspect}"
        end
      end
      expect(failures).to be_empty, -> { failures.join("\n") }
    end

    it "matches comparison_attribute_trimming" do
      config = comparison_config("comparison_attribute_trimming")
      user = ParityUpstreamCorpus::CorpusUser.new(
        identifier: " 12345 ", country: '[" USA "]',
        custom: { "Version" => " 1.0.0 ", "Number" => " 3 ", "Date" => " 1705253400 " }
      )
      failures = []
      ParityUpstreamCorpus::TRIMMING_KEYS.each do |c|
        result = ParityUpstreamCorpus::Evaluator.evaluate(config, c[:key], "default", user)
        unless result.value == c[:expected]
          failures << "#{c[:key]}: #{result.value.inspect} expected #{c[:expected].inspect}"
        end
      end
      expect(failures).to be_empty, -> { failures.join("\n") }
    end

    it "matches comparison_value_trimming" do
      config = comparison_config("comparison_value_trimming")
      user = ParityUpstreamCorpus::CorpusUser.new(
        identifier: "12345", country: '["USA"]',
        custom: { "Version" => "1.0.0", "Number" => "3", "Date" => "1705253400" }
      )
      failures = []
      ParityUpstreamCorpus::VALUE_TRIMMING_KEYS.each do |c|
        result = ParityUpstreamCorpus::Evaluator.evaluate(config, c[:key], "default", user)
        unless result.value == c[:expected]
          failures << "#{c[:key]}: #{result.value.inspect} expected #{c[:expected].inspect}"
        end
      end
      expect(failures).to be_empty, -> { failures.join("\n") }
    end
  end

  # =========================================================================
  # US5 — typed-attribute validation outcomes (FR-010) + list truncation
  # =========================================================================

  describe "typed-attribute validation (US5, FR-010)" do
    %w[semver_validation number_validation epoch_date_validation list_truncation].each do |scenario|
      it "matches the #{scenario} validation scenario" do
        failures = eval_log_failures(scenario)
        expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
      end
    end
  end

  # =========================================================================
  # US5 — variationId + matched rule/option detail (FR-011)
  # =========================================================================

  describe "variationId + matched rule/option detail (US5, FR-011)" do
    it "matches the testmatrix_variationId.csv matrix" do
      tuples = load_matrix("testmatrix_variationId.csv")
      expect(tuples).not_to be_empty
      failures = matrix_failures(tuples)
      expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n")}" }
    end

    it "reports value + variation id for a matched segment flag" do
      cases = load_eval_log_scenario("segment")
      match = cases.find { |c| c[:key] == "featureWithSegmentTargeting" && !c[:user].nil? }
      result = ParityUpstreamCorpus::Evaluator.evaluate(match[:config], match[:key], false, match[:user])
      expect(result.value).to be(true)
      expect(result.matched_targeting_rule).not_to be_nil
      expect(result.variation_id).not_to be_nil
    end
  end

  # =========================================================================
  # Evaluation-log TRACE fidelity (ADR 0003 / epic #494, Ruby slice of #501)
  # =========================================================================

  describe "evaluation-log trace fidelity (ADR 0003)" do
    it "emits the byte-identical trace for every trace-bearing scenario" do
      tuples = eval_log_trace_tuples
      expect(tuples).not_to be_empty
      failures = []
      seen = Hash.new(0)
      tuples.each do |t|
        next if t["expectedTrace"].nil? || !ParityUpstreamCorpus::TRACE_SCENARIOS.include?(t["scenario"])

        seen[t["scenario"]] += 1
        assert_eval_log_trace(t, failures)
      end
      expect(failures).to be_empty, -> { "#{failures.size} drift:\n#{failures.join("\n\n")}" }
      # Every trace-bearing scenario must have been asserted (guards a silently
      # shrinking oracle / a renamed scenario).
      missing = ParityUpstreamCorpus::TRACE_SCENARIOS.reject { |s| seen[s].positive? }
      expect(missing).to be_empty, -> { "scenarios with no asserted tuples: #{missing.join(", ")}" }
    end
  end
end
