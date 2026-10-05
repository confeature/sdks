// SPDX-License-Identifier: MIT

package confeature_test

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// Spec 038 US1 parity gate — 58/58 byte-identical to ConfigCat.
//
// Loads the TS-generated parity corpus + canonical configs from
// `packages/test-fixtures-sdk-parity/fixtures/`, runs one subtest per
// tuple via t.Run (subtest name = tuple.Description so a drift surfaces
// by its description in the test report), and asserts that the Go
// `confeature.Client` resolves each tuple to its `expected` value.
//
// Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST pass.
// If a tuple drifts, STOP and investigate the override-eval / evaluator
// code — never mutate the corpus to make the test green.
//
// Type-coercion note: encoding/json decodes JSON numbers into any as
// float64. The corpus's int defaultValue/expected entries (default=42)
// therefore arrive as float64(42) on both sides of the assertion, so
// reflect.DeepEqual still holds. The override values in the
// overridesMap are exclusively booleans, which decode as Go bool.

const parityTestSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

type parityTuple struct {
	Description  string          `json:"description"`
	ConfigID     string          `json:"configId"`
	Key          string          `json:"key"`
	DefaultValue any             `json:"defaultValue"`
	User         *map[string]any `json:"user"`
	Expected     any             `json:"expected"`
	// ExpectedVariationID is the optional analytics-dedup id (setting.i /
	// rule s.i / percentage-option i) that a tuple asserts via the PUBLIC
	// Get<T>ValueDetails accessor (spec 152 / #475 US2). Absent on value-only
	// tuples; a non-empty value triggers the variationId assertion in the
	// rules driver in ADDITION to the value assertion.
	ExpectedVariationID string `json:"expectedVariationId"`
}

type parityConfigRecord struct {
	ID           string         `json:"id"`
	Description  string         `json:"description"`
	OverridesMap map[string]any `json:"overridesMap"`
}

func loadParityCorpus(t *testing.T) []parityTuple {
	t.Helper()
	path := testutil.ParityCorpusPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read parity corpus %s: %v", path, err)
	}
	var tuples []parityTuple
	if err := json.Unmarshal(raw, &tuples); err != nil {
		t.Fatalf("unmarshal parity corpus: %v", err)
	}
	return tuples
}

func loadParityConfigs(t *testing.T) map[string]parityConfigRecord {
	t.Helper()
	path := testutil.ParityConfigsPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read parity configs %s: %v", path, err)
	}
	var records []parityConfigRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("unmarshal parity configs: %v", err)
	}
	out := make(map[string]parityConfigRecord, len(records))
	for _, r := range records {
		out[r.ID] = r
	}
	return out
}

// makeParityUser converts a corpus user-dict into the public User
// struct. nil pointer → nil User. Empty identifier is preserved (it
// is a legitimate corpus variant — the "empty-id" tuples).
func makeParityUser(u *map[string]any) *confeature.User {
	if u == nil {
		return nil
	}
	m := *u
	user := &confeature.User{}
	if v, ok := m["identifier"].(string); ok {
		user.Identifier = v
	}
	if v, ok := m["email"].(string); ok {
		user.Email = v
	}
	if v, ok := m["country"].(string); ok {
		user.Country = v
	}
	if v, ok := m["custom"].(map[string]any); ok {
		user.Custom = make(map[string]any, len(v))
		for k, val := range v {
			if decoded, present := decodeTypedAttribute(val); present {
				user.Custom[k] = decoded
			}
		}
	}
	return user
}

// decodeTypedAttribute maps the spec-151/#468 typed-attribute corpus encoding
// (packages/test-fixtures-sdk-parity, FR-001) onto a native Go custom-attribute
// value for the public User.Custom (map[string]any, mirroring configcat/go-sdk
// v9):
//
//   - string            → string (verbatim)
//   - number (JSON)     → float64 (json.Unmarshal default)
//   - bool              → bool
//   - string[]          → []string
//   - {"$date": <secs>} → time.Time at the encoded Unix epoch SECONDS (the
//     fractional part is nanosecond-restored)
//   - {"$num": "NaN"|"Infinity"|"-Infinity"} → the matching non-finite float64
//     (#479): JSON cannot represent these (JSON.stringify collapses all three to
//     null), so the exporter tags them; the evaluator renders the float back to
//     "NaN"/"Infinity"/"-Infinity", exactly as the JS family does.
func decodeTypedAttribute(val any) (any, bool) {
	switch v := val.(type) {
	case nil:
		return nil, false
	case string, bool, float64:
		return v, true
	case []any:
		arr := make([]string, len(v))
		for i, e := range v {
			s, ok := e.(string)
			if !ok {
				// Not a string array — pass through untouched; the evaluator's
				// own conversion/validation path handles the mismatch.
				return v, true
			}
			arr[i] = s
		}
		return arr, true
	case map[string]any:
		if secs, ok := v["$date"].(float64); ok {
			// Unix epoch SECONDS → time.Time (fractional preserved via ns).
			return time.Unix(0, int64(secs*float64(time.Second))).UTC(), true
		}
		if tag, ok := v["$num"].(string); ok {
			// Non-finite number tag (#479) → the matching float64.
			switch tag {
			case "NaN":
				return math.NaN(), true
			case "Infinity":
				return math.Inf(1), true
			case "-Infinity":
				return math.Inf(-1), true
			}
		}
		return v, true
	default:
		return v, true
	}
}

// parityConfigRecordRaw retains the full `config` field so we can
// inspect each setting's discriminator (`t`) — required for the typed
// corpus driver to normalise JSON-decoded floats to native Go ints
// (`t = 2` SettingType.Int) without forking the corpus (research §R3).
type parityConfigRecordRaw struct {
	ID           string         `json:"id"`
	Description  string         `json:"description"`
	Config       map[string]any `json:"config"`
	OverridesMap map[string]any `json:"overridesMap"`
}

// TestParityCorpus is the spec 038 US1 parity gate. It MUST stay green
// at 58/58 — any drift implies a Principle II violation.
func TestParityCorpus(t *testing.T) {
	tuples := loadParityCorpus(t)
	configsByID := loadParityConfigs(t)

	if len(tuples) != 58 {
		t.Fatalf("expected 58 corpus tuples, got %d — regenerate via "+
			"`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/",
			len(tuples))
	}

	for _, tuple := range tuples {
		tuple := tuple // capture per-iteration
		t.Run(tuple.Description, func(t *testing.T) {
			cfg, ok := configsByID[tuple.ConfigID]
			if !ok {
				t.Fatalf("corpus references unknown configId=%q; "+
					"regenerate fixtures via `pnpm run export:corpus`",
					tuple.ConfigID)
			}

			client, err := confeature.NewClient(
				parityTestSDKKey,
				confeature.WithManualPoll(),
				confeature.WithFlagOverrides(confeature.FlagOverrides{
					DataSource: confeature.NewMapOverrideDataSource(cfg.OverridesMap),
					Behaviour:  confeature.LocalOnly,
				}),
			)
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			defer func() { _ = client.Close() }()

			actual := client.GetValue(
				tuple.Key,
				tuple.DefaultValue,
				makeParityUser(tuple.User),
			)

			if !reflect.DeepEqual(actual, tuple.Expected) {
				t.Errorf("Parity drift on %q\n"+
					"  expected: %v (%T)\n"+
					"  actual:   %v (%T)\n"+
					"Constitution Principle II NON-NEGOTIABLE — investigate "+
					"the evaluator / override-eval code, do NOT mutate the corpus.",
					tuple.Description,
					tuple.Expected, tuple.Expected,
					actual, actual)
			}
		})
	}
}

// ── #258 typed-corpus tier ───────────────────────────────────────────
//
// Sibling driver to TestParityCorpus. Loads the 13-tuple typed corpus
// + the typed configs and exercises the four-type evaluator widening
// (string / int / double) across the typed SettingType matrix plus 3
// TYPE_MISMATCH cases. The boolean tier above is left byte-unchanged
// (US4 / FR-009).
//
// JSON-decoding subtlety (research §R3): encoding/json decodes every
// JSON number to float64. The evaluator surfaces native Go int(v) for
// t = 2 (SettingType.Int) and float64 for t = 3 (SettingType.Double).
// The driver therefore pre-normalises defaultValue / expected /
// overridesMap entries based on the per-key SettingType read from the
// typed configs — the corpus stays byte-identical (FR-008), the Go
// view of it is just rehydrated against the SettingType discriminator.

func loadTypedConfigs(t *testing.T) map[string]parityConfigRecordRaw {
	t.Helper()
	path := testutil.ParityConfigsTypedPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read typed parity configs %s: %v", path, err)
	}
	var records []parityConfigRecordRaw
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("unmarshal typed parity configs: %v", err)
	}
	out := make(map[string]parityConfigRecordRaw, len(records))
	for _, r := range records {
		out[r.ID] = r
	}
	return out
}

func loadTypedCorpus(t *testing.T) []parityTuple {
	t.Helper()
	path := testutil.ParityCorpusTypedPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read typed parity corpus %s: %v", path, err)
	}
	var tuples []parityTuple
	if err := json.Unmarshal(raw, &tuples); err != nil {
		t.Fatalf("unmarshal typed parity corpus: %v", err)
	}
	return tuples
}

// settingTypesByKey extracts the per-key SettingType (`t`) discriminator
// from a typed config record's wire `config.f` map. Used to normalise
// JSON-decoded floats to native Go ints when a setting declares
// SettingType.Int (t = 2).
func settingTypesByKey(rec parityConfigRecordRaw) map[string]int {
	return settingTypesFromConfig(rec.Config)
}

// settingTypesFromConfig extracts the per-key SettingType (`t`)
// discriminator from a wire config map's `f` block. Shared by the typed
// driver (via settingTypesByKey) and the rules driver — both need to
// rehydrate JSON-decoded floats to native Go ints for SettingType.Int
// (t = 2) settings, since the evaluator (mirroring configcat/go-sdk v9)
// requires a Go int default for an int setting and surfaces TYPE_MISMATCH
// for a float64 default otherwise.
func settingTypesFromConfig(config map[string]any) map[string]int {
	out := make(map[string]int)
	settings, ok := config["f"].(map[string]any)
	if !ok {
		return out
	}
	for key, settingAny := range settings {
		setting, ok := settingAny.(map[string]any)
		if !ok {
			continue
		}
		tAny, ok := setting["t"]
		if !ok {
			continue
		}
		if tFloat, ok := tAny.(float64); ok {
			out[key] = int(tFloat)
		}
	}
	return out
}

// normaliseForSettingType rehydrates a JSON-decoded value against the
// per-key SettingType. Only float64 inputs are inspected — strings,
// bools and other shapes pass through untouched so the TYPE_MISMATCH
// tuples (e.g. a string default against an int setting) still surface
// the mismatch through the override-eval / evaluator decision tree.
//
//   - t = 2 (Int):    float64 → int   (the evaluator's native widening).
//   - t = 3 (Double): float64 → float64 (pass through; documents intent).
//   - else:           pass through.
func normaliseForSettingType(v any, settingType int) any {
	f, ok := v.(float64)
	if !ok {
		return v
	}
	switch settingType {
	case 2: // SettingType.Int — evaluator returns int(v).
		return int(f)
	default:
		return f
	}
}

// normaliseOverrides converts every override entry whose key declares
// SettingType.Int (t = 2) from float64 to int so the public-API
// NewMapOverrideDataSource routes it to the I slot (research §R3).
func normaliseOverrides(raw map[string]any, settingTypes map[string]int) map[string]any {
	out := make(map[string]any, len(raw))
	for key, value := range raw {
		st, hasType := settingTypes[key]
		if !hasType {
			out[key] = value
			continue
		}
		out[key] = normaliseForSettingType(value, st)
	}
	return out
}

// TestParityCorpusTyped is the spec 071 US2 typed-corpus parity gate.
// It MUST stay green at 13/13 — any drift implies a regression of the
// four-type evaluator widening (issue #258).
func TestParityCorpusTyped(t *testing.T) {
	tuples := loadTypedCorpus(t)
	configsByID := loadTypedConfigs(t)

	if len(tuples) != 13 {
		t.Fatalf("expected 13 typed corpus tuples, got %d — regenerate via "+
			"`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/",
			len(tuples))
	}

	for _, tuple := range tuples {
		tuple := tuple // capture per-iteration
		t.Run(tuple.Description, func(t *testing.T) {
			cfg, ok := configsByID[tuple.ConfigID]
			if !ok {
				t.Fatalf("typed corpus references unknown configId=%q; "+
					"regenerate fixtures via `pnpm run export:corpus`",
					tuple.ConfigID)
			}

			settingTypes := settingTypesByKey(cfg)
			normalisedOverrides := normaliseOverrides(cfg.OverridesMap, settingTypes)

			defaultValue := tuple.DefaultValue
			expected := tuple.Expected
			if st, hasType := settingTypes[tuple.Key]; hasType {
				defaultValue = normaliseForSettingType(defaultValue, st)
				expected = normaliseForSettingType(expected, st)
			}

			client, err := confeature.NewClient(
				parityTestSDKKey,
				confeature.WithManualPoll(),
				confeature.WithFlagOverrides(confeature.FlagOverrides{
					DataSource: confeature.NewMapOverrideDataSource(normalisedOverrides),
					Behaviour:  confeature.LocalOnly,
				}),
			)
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			defer func() { _ = client.Close() }()

			actual := client.GetValue(
				tuple.Key,
				defaultValue,
				makeParityUser(tuple.User),
			)

			if !reflect.DeepEqual(actual, expected) {
				t.Errorf("Typed parity drift on %q\n"+
					"  expected: %v (%T)\n"+
					"  actual:   %v (%T)\n"+
					"Constitution Principle II NON-NEGOTIABLE — investigate "+
					"the evaluator code, do NOT mutate the corpus.",
					tuple.Description,
					expected, expected,
					actual, actual)
			}

			// FR-013 (spec 075): exercise the same tuple via the typed
			// accessor. The typed call MUST resolve to a byte-identical
			// typed value — proves the typed surface is a pure widening
			// of the four-type evaluator with no behavioural drift.
			typedActual := callTypedGetter(
				client, tuple.Key, defaultValue,
				makeParityUser(tuple.User),
			)
			if typedActual != nil && !reflect.DeepEqual(typedActual, expected) {
				t.Errorf("Typed-accessor parity drift on %q (FR-013)\n"+
					"  expected: %v (%T)\n"+
					"  typed:    %v (%T)\n"+
					"The typed getter must resolve to the same value as the "+
					"untyped GetValue path (spec 075 §FR-013).",
					tuple.Description,
					expected, expected,
					typedActual, typedActual)
			}
		})
	}
}

// callTypedGetter dispatches the corpus tuple to the right typed
// accessor based on the Go type of defaultValue. Returns nil when the
// default's Go type is none of the four supported primitives — in
// which case the FR-013 sibling assertion is skipped for that tuple
// (TYPE_MISMATCH tuples whose default has no matching typed accessor
// still go through the existing untyped GetValue assertion above).
func callTypedGetter(
	client *confeature.Client, key string, defaultValue any, user *confeature.User,
) any {
	switch d := defaultValue.(type) {
	case bool:
		return client.GetBoolValue(key, d, user)
	case string:
		return client.GetStringValue(key, d, user)
	case int:
		return client.GetIntValue(key, d, user)
	case float64:
		return client.GetFloatValue(key, d, user)
	}
	return nil
}
