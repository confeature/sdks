// SPDX-License-Identifier: MIT

package evaluator_test

// ConfigCat conformance — replays the vendored upstream evaluation matrix.
//
// Mirrors the spec-117 TS reference suite
// (packages/sdk-shared/tests/parity-upstream.test.ts) and the spec-118 Python
// suite (apps/sdk-python/tests/parity/test_upstream_corpus.py) in Go. The corpus
// (packages/test-fixtures-sdk-parity/fixtures/upstream/, anchor
// configcat/go-sdk@08c4882 v9 — see fixtures/upstream/PROVENANCE.md) is the
// oracle: each (config, key, user) -> expected tuple is checked against
// EvaluateForUser(...).Value (and .VariationID for the variation-id matrix).
//
// Scope = the full conformance surface (SC-001): US1 targeting rules, US2 the 36
// comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
// multilevel + circular detection) / AND-groups, US5 attribute conversion +
// trimming + typed-attribute validation + variationId/matched detail. This file
// asserts structured value/identity; the byte-identical textual evaluation-log
// trace (ADR 0003 / epic #494) is asserted in parity_evallog_trace_test.go.
//
// The loaders below port packages/test-fixtures-sdk-parity/src/upstream-corpus.ts
// faithfully — most critically the Go csv.Reader LazyQuotes semantics (a " only
// opens a quoted field at the field start), without which every JSON-array
// attribute cell is corrupted.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

const nullToken = "##null##"

func upstreamDir() string { return testutil.UpstreamCorpusDir() }

// ---------------------------------------------------------------------------
// Matrix -> SDK key mapping (verbatim from upstream-corpus.ts MATRIX_TO_SDK_KEY).
// ---------------------------------------------------------------------------

const (
	pkdPrefix = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
	jcpPrefix = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"
)

type matrixEntry struct {
	matrix string
	sdkKey string
	kind   string // "value" | "variation"
}

var matrixToSDKKey = []matrixEntry{
	{"testmatrix.csv", pkdPrefix + "AG6C1ngVb0CvM07un6JisQ", "value"},
	{"testmatrix_semantic.csv", pkdPrefix + "iV8vH2MBakKxkFZylxHmTg", "value"},
	{"testmatrix_number.csv", pkdPrefix + "FCWN-k1dV0iBf8QZrDgjdw", "value"},
	{"testmatrix_semantic_2.csv", pkdPrefix + "U8nt3zEhDEO5S2ulubCopA", "value"},
	{"testmatrix_sensitive.csv", pkdPrefix + "-0YmVOUNgEGKkgRF-rU65g", "value"},
	{"testmatrix_segments_old.csv", pkdPrefix + "y_ZB7o-Xb0Swxth-ZlMSeA", "value"},
	{"testmatrix_and_or.csv", jcpPrefix + "ByMO9yZNn02kXcm72lnY1A", "value"},
	{"testmatrix_comparators_v6.csv", jcpPrefix + "OfQqcTjfFUGBwMKqtyEOrQ", "value"},
	{"testmatrix_prerequisite_flag.csv", jcpPrefix + "JoGwdqJZQ0K2xDy7LnbyOg", "value"},
	{"testmatrix_segments.csv", jcpPrefix + "h99HYXWWNE2bH8eWyLAVMA", "value"},
	{"testmatrix_unicode.csv", jcpPrefix + "Da6w8dBbmUeMUBhh0iEeQQ", "value"},
	{"testmatrix_variationId.csv", pkdPrefix + "spQnkRTIPEWVivZkWM84lQ", "variation"},
}

// ---------------------------------------------------------------------------
// Config loaders (cached).
// ---------------------------------------------------------------------------

var (
	contentByKeyCache    map[string]evaluator.Config
	evalLogConfigsCache  map[string]evaluator.Config
	comparisonFixtCache  = map[string]evaluator.Config{}
	overrideConfigsCache = map[string]evaluator.Config{}
)

func readJSONFile(t *testing.T, path string) any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	return v
}

func contentByKey(t *testing.T) map[string]evaluator.Config {
	t.Helper()
	if contentByKeyCache == nil {
		v := readJSONFile(t, filepath.Join(upstreamDir(), "content-by-key.json"))
		contentByKeyCache = toConfigMap(v)
	}
	return contentByKeyCache
}

func evalLogConfigsByKey(t *testing.T) map[string]evaluator.Config {
	t.Helper()
	if evalLogConfigsCache == nil {
		v := readJSONFile(t, filepath.Join(upstreamDir(), "evaluationlog", "_configs-by-key.json"))
		evalLogConfigsCache = toConfigMap(v)
	}
	return evalLogConfigsCache
}

func toConfigMap(v any) map[string]evaluator.Config {
	m, _ := v.(map[string]any)
	out := make(map[string]evaluator.Config, len(m))
	for k, val := range m {
		if cfg, ok := val.(map[string]any); ok {
			out[k] = cfg
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port).
// ---------------------------------------------------------------------------

// parseCSVLine parses one CSV line under upstream conventions (LazyQuotes). A "
// only opens a quoted field when it is the FIRST char of the field; anywhere
// else it is a literal quote. So ["read","execute"] parses to the literal
// string (quotes preserved). Getting this wrong corrupts every JSON-array
// attribute.
func parseCSVLine(line string) []string {
	var fields []string
	var field strings.Builder
	inQuotes := false
	fieldStart := true
	runes := []rune(line)
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		switch {
		case inQuotes:
			if ch == '"' {
				if i+1 < len(runes) && runes[i+1] == '"' {
					field.WriteRune('"')
					i++
				} else {
					inQuotes = false
				}
			} else {
				field.WriteRune(ch)
			}
		case ch == '"' && fieldStart:
			inQuotes = true
			fieldStart = false
		case ch == ';':
			fields = append(fields, field.String())
			field.Reset()
			fieldStart = true
		default:
			field.WriteRune(ch)
			fieldStart = false
		}
	}
	fields = append(fields, field.String())
	return fields
}

// parseCell parses a CSV cell to its primitive (mirrors upstream parseCell).
func parseCell(s string) any {
	if isIntLiteral(s) {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n <= 9007199254740991 && n >= -9007199254740991 {
			return int(n)
		}
	}
	if isFloatLiteral(s) {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	}
	if s == "True" {
		return true
	}
	if s == "False" {
		return false
	}
	return s
}

func isIntLiteral(s string) bool {
	if s == "" {
		return false
	}
	i := 0
	if s[0] == '-' {
		if len(s) == 1 {
			return false
		}
		i = 1
	}
	for ; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isFloatLiteral(s string) bool {
	if s == "" {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return false
	}
	// Match the upstream regex ^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$ — reject
	// things ParseFloat accepts but the regex doesn't (e.g. "Inf", "NaN").
	body := strings.TrimPrefix(s, "-")
	for _, c := range body {
		if (c < '0' || c > '9') && c != '.' && c != 'e' && c != 'E' && c != '+' && c != '-' {
			return false
		}
	}
	return true
}

// userFromRow builds a *evaluator.User from the first four CSV columns (port
// userFromRow). Returns nil when col 0 is the null token (no user).
func userFromRow(line []string, customKey string) *evaluator.User {
	if len(line) == 0 || line[0] == nullToken {
		return nil
	}
	setOrEmpty := func(idx int) string {
		if idx >= len(line) {
			return ""
		}
		v := line[idx]
		if v == "" || v == nullToken {
			return ""
		}
		return v
	}
	user := &evaluator.User{Identifier: line[0]}
	user.Email = setOrEmpty(1)
	user.Country = setOrEmpty(2)
	if cv := setOrEmpty(3); cv != "" {
		user.Custom = map[string]any{customKey: cv}
	}
	return user
}

type matrixTuple struct {
	matrix   string
	key      string
	user     *evaluator.User
	kind     string
	expected any
	config   evaluator.Config
}

func loadMatrix(t *testing.T, matrix string) []matrixTuple {
	t.Helper()
	var entry *matrixEntry
	for i := range matrixToSDKKey {
		if matrixToSDKKey[i].matrix == matrix {
			entry = &matrixToSDKKey[i]
			break
		}
	}
	if entry == nil {
		t.Fatalf("unknown testmatrix file: %s", matrix)
	}
	config, ok := contentByKey(t)[entry.sdkKey]
	if !ok {
		t.Fatalf("no config for matrix %s (sdkKey %s)", matrix, entry.sdkKey)
	}

	raw, err := os.ReadFile(filepath.Join(upstreamDir(), matrix))
	if err != nil {
		t.Fatalf("read %s: %v", matrix, err)
	}
	lines := splitNonEmptyLines(string(raw))
	header := parseCSVLine(lines[0])
	customKey := header[3]
	settingKeys := header[4:]

	var tuples []matrixTuple
	for r := 1; r < len(lines); r++ {
		cols := parseCSVLine(lines[r])
		user := userFromRow(cols, customKey)
		for c, key := range settingKeys {
			rawCell := ""
			if c+4 < len(cols) {
				rawCell = cols[c+4]
			}
			var expected any
			if entry.kind == "value" {
				expected = parseCell(rawCell)
			} else {
				expected = rawCell
			}
			tuples = append(tuples, matrixTuple{
				matrix:   matrix,
				key:      key,
				user:     user,
				kind:     entry.kind,
				expected: expected,
				config:   config,
			})
		}
	}
	return tuples
}

func splitNonEmptyLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	parts := strings.Split(text, "\n")
	out := parts[:0]
	for _, p := range parts {
		if len(p) > 0 {
			out = append(out, p)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// evaluationlog/<scenario> (port loadEvalLogScenario).
// ---------------------------------------------------------------------------

type evalLogTuple struct {
	scenario     string
	key          string
	defaultValue any // nil = absent
	user         *evaluator.User
	expected     any
	config       evaluator.Config
}

func evalLogUser(raw map[string]any) *evaluator.User {
	if len(raw) == 0 {
		return nil
	}
	user := &evaluator.User{}
	custom := map[string]any{}
	for k, v := range raw {
		val := stringifyAny(v)
		switch k {
		case "Identifier":
			user.Identifier = val
		case "Email":
			user.Email = val
		case "Country":
			user.Country = val
		default:
			custom[k] = val
		}
	}
	if len(custom) > 0 {
		user.Custom = custom
	}
	return user
}

func stringifyAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func evalLogConfig(t *testing.T, suite map[string]any) evaluator.Config {
	t.Helper()
	if jsonOverride, ok := suite["jsonOverride"].(string); ok && jsonOverride != "" {
		if cfg, ok := overrideConfigsCache[jsonOverride]; ok {
			return cfg
		}
		v := readJSONFile(t, filepath.Join(upstreamDir(), "evaluationlog", "_overrides", jsonOverride))
		cfg, _ := v.(map[string]any)
		overrideConfigsCache[jsonOverride] = cfg
		return cfg
	}
	if sdkKey, ok := suite["sdkKey"].(string); ok && sdkKey != "" {
		if cfg, ok := contentByKey(t)[sdkKey]; ok {
			return cfg
		}
		if cfg, ok := evalLogConfigsByKey(t)[sdkKey]; ok {
			return cfg
		}
		t.Fatalf("no config for eval-log sdkKey %s", sdkKey)
	}
	t.Fatalf("eval-log suite has neither jsonOverride nor sdkKey")
	return nil
}

func loadEvalLogScenario(t *testing.T, scenario string) []evalLogTuple {
	t.Helper()
	v := readJSONFile(t, filepath.Join(upstreamDir(), "evaluationlog", scenario+".json"))
	suite, _ := v.(map[string]any)
	config := evalLogConfig(t, suite)
	tests, _ := suite["tests"].([]any)
	out := make([]evalLogTuple, 0, len(tests))
	for _, rawT := range tests {
		test, _ := rawT.(map[string]any)
		var user *evaluator.User
		if u, ok := test["user"].(map[string]any); ok {
			user = evalLogUser(u)
		}
		key, _ := test["key"].(string)
		out = append(out, evalLogTuple{
			scenario:     scenario,
			key:          key,
			defaultValue: test["defaultValue"], // nil when absent
			user:         user,
			expected:     test["returnValue"],
			config:       config,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Assertion helpers (port assertMatrixTuple / assertEvalLogValue).
// ---------------------------------------------------------------------------

func settingType(config evaluator.Config, key string) (int, bool) {
	settings, ok := config["f"].(map[string]any)
	if !ok {
		return 0, false
	}
	setting, ok := settings[key].(map[string]any)
	if !ok {
		return 0, false
	}
	switch t := setting["t"].(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	}
	return 0, false
}

// defaultFor returns a type-appropriate default matching the resolved primitive
// type. Go's strict evaluator distinguishes int (t=2) from double (t=3), so the
// default must be the SAME numeric kind the setting type expects.
func defaultFor(expected any, st int, hasType bool) any {
	switch expected.(type) {
	case bool:
		return false
	case int, float64:
		if hasType && st == settingTypeDoubleConst {
			return 0.0
		}
		if hasType && st == settingTypeIntConst {
			return 0
		}
		// Fall back to the expected's own kind when the setting type is unknown.
		if _, isFloat := expected.(float64); isFloat {
			return 0.0
		}
		return 0
	default:
		return "__default__"
	}
}

const (
	settingTypeIntConst    = 2
	settingTypeDoubleConst = 3
)

// coerceDefault casts a JSON-decoded eval-log default to the type implied by t.
func coerceDefault(def any, st int, hasType bool) any {
	switch d := def.(type) {
	case bool:
		return d
	case float64:
		if hasType && st == settingTypeIntConst {
			return int(d)
		}
		if hasType && st == settingTypeDoubleConst {
			return d
		}
		// JSON numbers decode to float64; if it is integral and no type info,
		// keep as float64 (the evaluator's nil-default path is not used here).
		return d
	default:
		return def
	}
}

func assertMatrixTuple(t *testing.T, tup matrixTuple) {
	t.Helper()
	label := tup.matrix + " " + tup.key + " " + userRepr(tup.user)
	if tup.kind == "variation" {
		result := evaluator.EvaluateForUser(tup.config, tup.key, nil, tup.user)
		if result.VariationID != tup.expected {
			t.Errorf("%s: variationID = %q; want %q", label, result.VariationID, tup.expected)
		}
		return
	}
	st, hasType := settingType(tup.config, tup.key)
	def := defaultFor(tup.expected, st, hasType)
	result := evaluator.EvaluateForUser(tup.config, tup.key, def, tup.user)
	assertValueEqual(t, result.Value, tup.expected, label)
}

func assertEvalLogValue(t *testing.T, tup evalLogTuple) {
	t.Helper()
	st, hasType := settingType(tup.config, tup.key)
	var def any
	if tup.defaultValue != nil {
		def = coerceDefault(tup.defaultValue, st, hasType)
	} else {
		def = defaultFor(tup.expected, st, hasType)
	}
	label := tup.scenario + " " + tup.key + " " + userRepr(tup.user)
	result := evaluator.EvaluateForUser(tup.config, tup.key, def, tup.user)
	assertValueEqual(t, result.Value, tup.expected, label)
}

// assertValueEqual asserts numeric-tolerant equality (5 == 5.0); exact
// otherwise. Booleans never silently equal numbers.
func assertValueEqual(t *testing.T, actual, expected any, label string) {
	t.Helper()
	// Booleans first (so true never equates to 1).
	if eb, ok := expected.(bool); ok {
		ab, ok := actual.(bool)
		if !ok || ab != eb {
			t.Errorf("%s: actual=%#v expected=%#v", label, actual, expected)
		}
		return
	}
	if _, ok := actual.(bool); ok {
		t.Errorf("%s: actual=%#v expected=%#v (bool/non-bool drift)", label, actual, expected)
		return
	}
	if ef, ok := numeric(expected); ok {
		af, ok := numeric(actual)
		if !ok {
			t.Errorf("%s: actual=%#v expected=%#v (non-numeric actual)", label, actual, expected)
			return
		}
		if math.IsNaN(ef) {
			if !math.IsNaN(af) {
				t.Errorf("%s: actual=%#v expected NaN", label, actual)
			}
			return
		}
		if af != ef {
			t.Errorf("%s: actual=%#v expected=%#v", label, actual, expected)
		}
		return
	}
	if actual != expected {
		t.Errorf("%s: actual=%#v expected=%#v", label, actual, expected)
	}
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

func userRepr(u *evaluator.User) string {
	if u == nil {
		return "user=nil"
	}
	return "user{id=" + u.Identifier + " email=" + u.Email + " country=" + u.Country + "}"
}

// ===========================================================================
// US1/US2/US3 — comparator + value matrices
// ===========================================================================

var valueMatrices = []string{
	"testmatrix.csv",
	"testmatrix_comparators_v6.csv",
	"testmatrix_semantic.csv",
	"testmatrix_semantic_2.csv",
	"testmatrix_number.csv",
	"testmatrix_sensitive.csv",
	"testmatrix_unicode.csv",
}

func TestValueMatrices(t *testing.T) {
	for _, matrix := range valueMatrices {
		matrix := matrix
		t.Run(matrix, func(t *testing.T) {
			tuples := loadMatrix(t, matrix)
			if len(tuples) == 0 {
				t.Fatalf("%s produced no tuples", matrix)
			}
			for _, tup := range tuples {
				assertMatrixTuple(t, tup)
			}
		})
	}
}

// ===========================================================================
// US1 — targeting-rule eval-log scenarios
// ===========================================================================

func TestTargetingRuleScenarios(t *testing.T) {
	for _, scenario := range []string{"1_targeting_rule", "2_targeting_rules", "simple_value"} {
		scenario := scenario
		t.Run(scenario, func(t *testing.T) {
			for _, tup := range loadEvalLogScenario(t, scenario) {
				assertEvalLogValue(t, tup)
			}
		})
	}
}

func TestMatchedTargetingRuleIsReported(t *testing.T) {
	cases := loadEvalLogScenario(t, "1_targeting_rule")
	var match *evalLogTuple
	for i := range cases {
		if cases[i].expected == "Dog" {
			match = &cases[i]
			break
		}
	}
	if match == nil {
		t.Fatal("no Dog case in 1_targeting_rule")
	}
	result := evaluator.EvaluateForUser(match.config, match.key, "default", match.user)
	if result.Value != "Dog" {
		t.Errorf("Value = %v; want Dog", result.Value)
	}
	if result.MatchedTargetingRule == nil {
		t.Error("MatchedTargetingRule should be set")
	}
	if result.MatchedPercentageOption != nil {
		t.Error("MatchedPercentageOption should be nil")
	}
	if result.VariationID != "d0cd8f06" {
		t.Errorf("VariationID = %q; want d0cd8f06", result.VariationID)
	}
}

func TestNoUserServesFallbackWithReasonNoError(t *testing.T) {
	var noUser *evalLogTuple
	cases := loadEvalLogScenario(t, "1_targeting_rule")
	for i := range cases {
		if cases[i].user == nil {
			noUser = &cases[i]
			break
		}
	}
	if noUser == nil {
		t.Fatal("no no-user case in 1_targeting_rule")
	}
	result := evaluator.EvaluateForUser(noUser.config, noUser.key, "default", nil)
	if result.Value != "Cat" {
		t.Errorf("Value = %v; want Cat (fallback)", result.Value)
	}
	if result.Error != "" {
		t.Errorf("Error = %q; want empty (a value was cleanly resolved)", result.Error)
	}
	if !strings.Contains(result.EvalError, "User Object is missing") {
		t.Errorf("EvalError = %q; want it to mention missing user", result.EvalError)
	}
	if result.MatchedTargetingRule != nil {
		t.Error("MatchedTargetingRule should be nil")
	}
}

// ===========================================================================
// US3 — percentage rollout
// ===========================================================================

func TestPercentageScenarios(t *testing.T) {
	scenarios := []string{
		"options_based_on_user_id",
		"options_based_on_custom_attr",
		"options_after_targeting_rule",
		"options_within_targeting_rule",
	}
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario, func(t *testing.T) {
			for _, tup := range loadEvalLogScenario(t, scenario) {
				assertEvalLogValue(t, tup)
			}
		})
	}
}

func TestPercentageBucketingIsDeterministic(t *testing.T) {
	cases := loadEvalLogScenario(t, "options_based_on_user_id")
	var withUser *evalLogTuple
	for i := range cases {
		if cases[i].user != nil {
			withUser = &cases[i]
			break
		}
	}
	if withUser == nil {
		t.Fatal("no with-user case in options_based_on_user_id")
	}
	first := evaluator.EvaluateForUser(withUser.config, withUser.key, "default", withUser.user)
	for i := 0; i < 20; i++ {
		again := evaluator.EvaluateForUser(withUser.config, withUser.key, "default", withUser.user)
		if again.Value != first.Value {
			t.Fatalf("non-deterministic value: %v != %v", again.Value, first.Value)
		}
		if again.VariationID != first.VariationID {
			t.Fatalf("non-deterministic variationID: %v != %v", again.VariationID, first.VariationID)
		}
	}
	assertValueEqual(t, first.Value, withUser.expected, "deterministic first value")
	if first.MatchedPercentageOption == nil {
		t.Error("MatchedPercentageOption should be set")
	}
}

// ===========================================================================
// US4 — segments / prerequisites / AND-OR matrices
// ===========================================================================

var us4Matrices = []string{
	"testmatrix_and_or.csv",
	"testmatrix_segments.csv",
	"testmatrix_segments_old.csv",
	"testmatrix_prerequisite_flag.csv",
}

func TestUS4Matrices(t *testing.T) {
	for _, matrix := range us4Matrices {
		matrix := matrix
		t.Run(matrix, func(t *testing.T) {
			tuples := loadMatrix(t, matrix)
			if len(tuples) == 0 {
				t.Fatalf("%s produced no tuples", matrix)
			}
			for _, tup := range tuples {
				assertMatrixTuple(t, tup)
			}
		})
	}
}

// dependentFeatureMultipleLevels is the ONE corpus case whose config blob was
// NOT captured by the spec-117 vendoring (the multilevel chain is served from a
// different, unvendored config — known data gap #401). The engine's multilevel-
// prerequisite logic IS exercised by the 3-level circular_dep chain + the
// reconstructed-chain unit test below — this is a vendoring DATA gap, not an
// engine gap. Excluded LOUDLY here (same marker the TS/Python references use),
// never silently skipped.
var unvendoredEvalLogKeys = map[string]bool{"dependentFeatureMultipleLevels": true}

func TestUS4EvalLogScenarios(t *testing.T) {
	for _, scenario := range []string{"segment", "prerequisite_flag", "and_rules"} {
		scenario := scenario
		t.Run(scenario, func(t *testing.T) {
			for _, tup := range loadEvalLogScenario(t, scenario) {
				if unvendoredEvalLogKeys[tup.key] {
					t.Logf("EXCLUDED (known data gap #401, config blob unvendored): %s", tup.key)
					continue
				}
				assertEvalLogValue(t, tup)
			}
		})
	}
}

func TestMultilevelPrerequisiteResolvesThroughReconstructedChain(t *testing.T) {
	// Reconstructed from evaluationlog/prerequisite_flag (its config blob was not
	// vendored, see above). Proves the engine recurses A -> B -> C correctly.
	config := evaluator.Config{
		"p": map[string]any{"u": "", "r": float64(0), "s": "salt"},
		"s": []any{},
		"f": map[string]any{
			"mainFeatureWithoutUserCondition": map[string]any{
				"t": float64(0), "v": map[string]any{"b": true}, "i": "main", "r": []any{},
			},
			"intermediateFeature": map[string]any{
				"t": float64(0), "v": map[string]any{"b": false}, "i": "inter",
				"r": []any{
					map[string]any{
						"c": []any{
							map[string]any{"p": map[string]any{"f": "mainFeatureWithoutUserCondition", "c": float64(0), "v": map[string]any{"b": true}}},
							map[string]any{"p": map[string]any{"f": "mainFeatureWithoutUserCondition", "c": float64(0), "v": map[string]any{"b": true}}},
						},
						"s": map[string]any{"v": map[string]any{"b": true}, "i": "interT"},
					},
				},
			},
			"dependentFeatureMultipleLevels": map[string]any{
				"t": float64(1), "v": map[string]any{"s": "Cat"}, "i": "dep",
				"r": []any{
					map[string]any{
						"c": []any{
							map[string]any{"p": map[string]any{"f": "intermediateFeature", "c": float64(0), "v": map[string]any{"b": true}}},
						},
						"s": map[string]any{"v": map[string]any{"s": "Dog"}, "i": "depDog"},
					},
				},
			},
		},
	}
	result := evaluator.EvaluateForUser(config, "dependentFeatureMultipleLevels", "default", nil)
	if result.Value != "Dog" {
		t.Errorf("Value = %v; want Dog", result.Value)
	}
	if result.MatchedTargetingRule == nil {
		t.Error("MatchedTargetingRule should be set")
	}
}

// ===========================================================================
// US4 — circular-dependency termination (SC-004)
// ===========================================================================

func TestCircularDepScenariosBoundedFallback(t *testing.T) {
	for _, tup := range loadEvalLogScenario(t, "circular_dep") {
		start := time.Now()
		result := evaluator.EvaluateForUser(tup.config, tup.key, "default", tup.user)
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("%s took too long (%v) — cycle not bounded", tup.key, elapsed)
		}
		if result.Value != "default" {
			t.Errorf("%s: Value = %v; want default (cycle fail-closed)", tup.key, result.Value)
		}
		if result.Error == "" {
			t.Errorf("%s: Error empty; want a fail-closed error code", tup.key)
		}
	}
}

func TestDirectTwoFlagCycleTerminates(t *testing.T) {
	config := evaluator.Config{
		"p": map[string]any{"u": "", "r": float64(0), "s": "salt"},
		"s": []any{},
		"f": map[string]any{
			"flagA": map[string]any{
				"t": float64(1), "v": map[string]any{"s": "A"}, "i": "a",
				"r": []any{
					map[string]any{
						"c": []any{map[string]any{"p": map[string]any{"f": "flagB", "c": float64(0), "v": map[string]any{"b": true}}}},
						"s": map[string]any{"v": map[string]any{"s": "AA"}, "i": "aa"},
					},
				},
			},
			"flagB": map[string]any{
				"t": float64(1), "v": map[string]any{"s": "B"}, "i": "b",
				"r": []any{
					map[string]any{
						"c": []any{map[string]any{"p": map[string]any{"f": "flagA", "c": float64(0), "v": map[string]any{"b": true}}}},
						"s": map[string]any{"v": map[string]any{"s": "BB"}, "i": "bb"},
					},
				},
			},
		},
	}
	result := evaluator.EvaluateForUser(config, "flagA", "default", nil)
	if result.Value != "default" {
		t.Errorf("Value = %v; want default", result.Value)
	}
	if result.Error == "" {
		t.Error("Error empty; want a fail-closed error code")
	}
}

// ===========================================================================
// US5 — normalization / conversion / trimming (comparison_*.json drivers)
// ===========================================================================

func comparisonConfig(t *testing.T, fixture string) evaluator.Config {
	t.Helper()
	if cfg, ok := comparisonFixtCache[fixture]; ok {
		return cfg
	}
	v := readJSONFile(t, filepath.Join(upstreamDir(), fixture+".json"))
	cfg, _ := v.(map[string]any)
	comparisonFixtCache[fixture] = cfg
	return cfg
}

type conversionCase struct {
	key      string
	custom1  any
	expected string
}

// Drivers ported verbatim from upstream-corpus.ts (the typed-attribute cases the
// vendored comparison_*.json fixtures are designed to exercise).
var attributeConversionDriver = []conversionCase{
	{"numberToStringConversion", 0.12345, "1"},
	{"numberToStringConversionInt", 125.0, "4"},
	{"numberToStringConversionPositiveExp", -1.23456789e96, "2"},
	{"numberToStringConversionNegativeExp", -12345.6789e-100, "4"},
	{"numberToStringConversionNaN", math.NaN(), "3"},
	{"numberToStringConversionPositiveInf", math.Inf(1), "4"},
	{"numberToStringConversionNegativeInf", math.Inf(-1), "3"},
	{"dateToStringConversion", 1680307199.999, "3"},
	{"dateToStringConversionNaN", math.NaN(), "3"},
	{"dateToStringConversionPositiveInf", math.Inf(1), "1"},
	{"dateToStringConversionNegativeInf", math.Inf(-1), "5"},
	{"stringArrayToStringConversion", []string{"read", "Write", " eXecute "}, "4"},
	{"stringArrayToStringConversionEmpty", []string{}, "5"},
	{"stringArrayToStringConversionSpecialChars", []string{"+<>%\"'\\/\t\r\n"}, "3"},
	{"stringArrayToStringConversionUnicode", []string{"äöüÄÖÜçéèñışğâ¢™✓😀"}, "2"},
}

func TestComparisonAttributeConversion(t *testing.T) {
	config := comparisonConfig(t, "comparison_attribute_conversion")
	for _, c := range attributeConversionDriver {
		user := &evaluator.User{Identifier: "12345", Custom: map[string]any{"Custom1": c.custom1}}
		result := evaluator.EvaluateForUser(config, c.key, "default", user)
		if result.Value != c.expected {
			t.Errorf("attribute_conversion %s custom1=%#v: actual=%#v expected=%q",
				c.key, c.custom1, result.Value, c.expected)
		}
	}
}

type trimCase struct {
	key      string
	expected string
}

var attributeTrimmingDriver = []trimCase{
	{"isoneof", "no trim"}, {"isnotoneof", "no trim"}, {"isoneofhashed", "no trim"},
	{"isnotoneofhashed", "no trim"}, {"equalshashed", "no trim"}, {"notequalshashed", "no trim"},
	{"arraycontainsanyofhashed", "no trim"}, {"arraynotcontainsanyofhashed", "no trim"},
	{"equals", "no trim"}, {"notequals", "no trim"}, {"startwithanyof", "no trim"},
	{"notstartwithanyof", "no trim"}, {"endswithanyof", "no trim"}, {"notendswithanyof", "no trim"},
	{"arraycontainsanyof", "no trim"}, {"arraynotcontainsanyof", "no trim"},
	{"startwithanyofhashed", "no trim"}, {"notstartwithanyofhashed", "no trim"},
	{"endswithanyofhashed", "no trim"}, {"notendswithanyofhashed", "no trim"},
	{"semverisoneof", "4 trim"}, {"semverisnotoneof", "5 trim"}, {"semverless", "6 trim"},
	{"semverlessequals", "7 trim"}, {"semvergreater", "8 trim"}, {"semvergreaterequals", "9 trim"},
	{"numberequals", "10 trim"}, {"numbernotequals", "11 trim"}, {"numberless", "12 trim"},
	{"numberlessequals", "13 trim"}, {"numbergreater", "14 trim"}, {"numbergreaterequals", "15 trim"},
	{"datebefore", "18 trim"}, {"dateafter", "19 trim"},
	{"containsanyof", "no trim"}, {"notcontainsanyof", "no trim"},
}

func TestComparisonAttributeTrimming(t *testing.T) {
	config := comparisonConfig(t, "comparison_attribute_trimming")
	for _, c := range attributeTrimmingDriver {
		user := &evaluator.User{
			Identifier: " 12345 ",
			Country:    `[" USA "]`,
			Custom:     map[string]any{"Version": " 1.0.0 ", "Number": " 3 ", "Date": " 1705253400 "},
		}
		result := evaluator.EvaluateForUser(config, c.key, "default", user)
		if result.Value != c.expected {
			t.Errorf("attribute_trimming %s: actual=%#v expected=%q", c.key, result.Value, c.expected)
		}
	}
}

var valueTrimmingDriver = []trimCase{
	{"isoneof", "no trim"}, {"isnotoneof", "no trim"}, {"containsanyof", "no trim"},
	{"notcontainsanyof", "no trim"}, {"isoneofhashed", "no trim"}, {"isnotoneofhashed", "no trim"},
	{"equalshashed", "no trim"}, {"notequalshashed", "no trim"},
	{"arraycontainsanyofhashed", "no trim"}, {"arraynotcontainsanyofhashed", "no trim"},
	{"equals", "no trim"}, {"notequals", "no trim"}, {"startwithanyof", "no trim"},
	{"notstartwithanyof", "no trim"}, {"endswithanyof", "no trim"}, {"notendswithanyof", "no trim"},
	{"arraycontainsanyof", "no trim"}, {"arraynotcontainsanyof", "no trim"},
	{"startwithanyofhashed", "no trim"}, {"notstartwithanyofhashed", "no trim"},
	{"endswithanyofhashed", "no trim"}, {"notendswithanyofhashed", "no trim"},
	{"semverisoneof", "4 trim"}, {"semverisnotoneof", "5 trim"}, {"semverless", "6 trim"},
	{"semverlessequals", "7 trim"}, {"semvergreater", "8 trim"}, {"semvergreaterequals", "9 trim"},
}

func TestComparisonValueTrimming(t *testing.T) {
	config := comparisonConfig(t, "comparison_value_trimming")
	for _, c := range valueTrimmingDriver {
		user := &evaluator.User{
			Identifier: "12345",
			Country:    `["USA"]`,
			Custom:     map[string]any{"Version": "1.0.0", "Number": "3", "Date": "1705253400"},
		}
		result := evaluator.EvaluateForUser(config, c.key, "default", user)
		if result.Value != c.expected {
			t.Errorf("value_trimming %s: actual=%#v expected=%q", c.key, result.Value, c.expected)
		}
	}
}

// ===========================================================================
// US5 — typed-attribute validation outcomes (FR-010) + list truncation
// ===========================================================================

func TestValidationScenarios(t *testing.T) {
	scenarios := []string{"semver_validation", "number_validation", "epoch_date_validation", "list_truncation"}
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario, func(t *testing.T) {
			for _, tup := range loadEvalLogScenario(t, scenario) {
				assertEvalLogValue(t, tup)
			}
		})
	}
}

// ===========================================================================
// US5 — variationId + matched rule/option detail (FR-011)
// ===========================================================================

func TestVariationIDMatrix(t *testing.T) {
	tuples := loadMatrix(t, "testmatrix_variationId.csv")
	if len(tuples) == 0 {
		t.Fatal("testmatrix_variationId.csv produced no tuples")
	}
	for _, tup := range tuples {
		assertMatrixTuple(t, tup)
	}
}

func TestSegmentMatchedFlagReportsValueAndVariationID(t *testing.T) {
	cases := loadEvalLogScenario(t, "segment")
	var match *evalLogTuple
	for i := range cases {
		if cases[i].key == "featureWithSegmentTargeting" && cases[i].user != nil {
			match = &cases[i]
			break
		}
	}
	if match == nil {
		t.Fatal("no featureWithSegmentTargeting with-user case in segment scenario")
	}
	result := evaluator.EvaluateForUser(match.config, match.key, false, match.user)
	if result.Value != true {
		t.Errorf("Value = %v; want true", result.Value)
	}
	if result.MatchedTargetingRule == nil {
		t.Error("MatchedTargetingRule should be set")
	}
	if result.VariationID == "" {
		t.Error("VariationID should be set")
	}
}
