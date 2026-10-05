// SPDX-License-Identifier: MIT

package evaluator_test

import (
	"testing"

	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
)

func boolConfig(key string, value bool) evaluator.Config {
	return evaluator.Config{
		"f": map[string]any{
			key: map[string]any{
				"t": float64(0), // SettingType.Bool
				"v": map[string]any{"b": value},
				"i": "vid-" + key,
				"r": []any{},
			},
		},
	}
}

func TestEvaluate_HappyPath(t *testing.T) {
	r := evaluator.Evaluate(boolConfig("flag", true), "flag", false)
	if r.Value != true {
		t.Errorf("Value = %v; want true", r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
	if r.VariationID != "vid-flag" {
		t.Errorf("VariationID = %q; want vid-flag", r.VariationID)
	}
}

func TestEvaluate_NoConfig(t *testing.T) {
	r := evaluator.Evaluate(nil, "flag", true)
	if r.Value != true {
		t.Errorf("Value = %v; want true", r.Value)
	}
	if r.Error != "NO_CONFIG" {
		t.Errorf("Error = %q; want NO_CONFIG", r.Error)
	}
}

func TestEvaluate_KeyNotFound(t *testing.T) {
	cfg := boolConfig("present", true)
	r := evaluator.Evaluate(cfg, "missing", false)
	if r.Value != false {
		t.Errorf("Value = %v; want false (default)", r.Value)
	}
	if r.Error != "KEY_NOT_FOUND" {
		t.Errorf("Error = %q; want KEY_NOT_FOUND", r.Error)
	}
}

func TestEvaluate_UnsupportedType(t *testing.T) {
	// FR-010 reshape (spec 071): UNSUPPORTED_TYPE is now reserved for
	// a TRULY unknown SettingType discriminator. For t = 1 (string),
	// t = 2 (int), t = 3 (double) the four-type evaluator resolves the
	// typed slot — see the dedicated typed tests below. A genuinely
	// unknown t (e.g. 99) keeps the original UNSUPPORTED_TYPE branch.
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(99), // unknown SettingType discriminator
				"v": map[string]any{"b": true},
				"i": "vid",
				"r": []any{},
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", false)
	if r.Value != false {
		t.Errorf("Value = %v; want default false", r.Value)
	}
	if r.Error != "UNSUPPORTED_TYPE" {
		t.Errorf("Error = %q; want UNSUPPORTED_TYPE", r.Error)
	}
}

func TestEvaluate_TypeMismatch(t *testing.T) {
	cfg := boolConfig("flag", true)
	r := evaluator.Evaluate(cfg, "flag", "not-a-bool")
	if r.Value != "not-a-bool" {
		t.Errorf("Value = %v; want \"not-a-bool\" (default)", r.Value)
	}
	if r.Error != "TYPE_MISMATCH" {
		t.Errorf("Error = %q; want TYPE_MISMATCH", r.Error)
	}
}

func TestEvaluate_MalformedConfig(t *testing.T) {
	r := evaluator.Evaluate(evaluator.Config{"f": "not-a-map"}, "flag", true)
	if r.Value != true {
		t.Errorf("Value = %v; want default true", r.Value)
	}
	if r.Error != "MALFORMED_CONFIG" {
		t.Errorf("Error = %q; want MALFORMED_CONFIG", r.Error)
	}
}

func TestEvaluate_ValueNotBool(t *testing.T) {
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(0),
				"v": map[string]any{"b": "not-a-bool"},
				"i": "vid",
				"r": []any{},
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", false)
	if r.Value != false {
		t.Errorf("Value = %v; want default false", r.Value)
	}
	if r.Error != "VALUE_NOT_BOOL" {
		t.Errorf("Error = %q; want VALUE_NOT_BOOL", r.Error)
	}
}

func TestEvaluate_MissingVField(t *testing.T) {
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(0),
				"i": "vid",
				"r": []any{},
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", false)
	if r.Value != false {
		t.Errorf("Value = %v; want default false", r.Value)
	}
	if r.Error != "MALFORMED_VALUE" {
		t.Errorf("Error = %q; want MALFORMED_VALUE", r.Error)
	}
}

func TestEvaluate_FalseValue(t *testing.T) {
	r := evaluator.Evaluate(boolConfig("flag", false), "flag", true)
	if r.Value != false {
		t.Errorf("Value = %v; want false (overrides default)", r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
}

// ── #258 typed-path assertions ──────────────────────────────────────

func stringConfig(key, value string) evaluator.Config {
	return evaluator.Config{
		"f": map[string]any{
			key: map[string]any{
				"t": float64(1), // SettingType.String
				"v": map[string]any{"s": value},
				"i": "vid-" + key,
				"r": []any{},
			},
		},
	}
}

func intConfig(key string, value int) evaluator.Config {
	// encoding/json delivers JSON integers as float64; we model the
	// post-decode shape here too.
	return evaluator.Config{
		"f": map[string]any{
			key: map[string]any{
				"t": float64(2), // SettingType.Int
				"v": map[string]any{"i": float64(value)},
				"i": "vid-" + key,
				"r": []any{},
			},
		},
	}
}

func doubleConfig(key string, value float64) evaluator.Config {
	return evaluator.Config{
		"f": map[string]any{
			key: map[string]any{
				"t": float64(3), // SettingType.Double
				"v": map[string]any{"d": value},
				"i": "vid-" + key,
				"r": []any{},
			},
		},
	}
}

func TestEvaluateTypedString(t *testing.T) {
	r := evaluator.Evaluate(stringConfig("flag", "hello"), "flag", "fallback")
	if r.Value != "hello" {
		t.Errorf("Value = %v; want hello", r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
	if r.VariationID != "vid-flag" {
		t.Errorf("VariationID = %q; want vid-flag", r.VariationID)
	}
}

func TestEvaluateTypedStringEmpty(t *testing.T) {
	// The empty string is a REAL value, not "missing".
	r := evaluator.Evaluate(stringConfig("flag", ""), "flag", "fallback")
	if r.Value != "" {
		t.Errorf("Value = %v; want empty string", r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
}

func TestEvaluateTypedInt(t *testing.T) {
	r := evaluator.Evaluate(intConfig("flag", 5), "flag", -1)
	if r.Value != 5 {
		t.Errorf("Value = %v (%T); want int(5)", r.Value, r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
}

func TestEvaluateTypedIntZero(t *testing.T) {
	// Zero is a REAL value, not "missing".
	r := evaluator.Evaluate(intConfig("flag", 0), "flag", -1)
	if r.Value != 0 {
		t.Errorf("Value = %v (%T); want int(0)", r.Value, r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
}

func TestEvaluateTypedIntNegative(t *testing.T) {
	r := evaluator.Evaluate(intConfig("flag", -3), "flag", 0)
	if r.Value != -3 {
		t.Errorf("Value = %v (%T); want int(-3)", r.Value, r.Value)
	}
}

func TestEvaluateTypedDouble(t *testing.T) {
	r := evaluator.Evaluate(doubleConfig("flag", 0.25), "flag", 1.0)
	if r.Value != 0.25 {
		t.Errorf("Value = %v (%T); want float64(0.25)", r.Value, r.Value)
	}
	if r.Error != "" {
		t.Errorf("Error = %q; want \"\"", r.Error)
	}
}

func TestEvaluateTypedDoublePrecisionSensitive(t *testing.T) {
	r := evaluator.Evaluate(doubleConfig("flag", 0.30000000000000004), "flag", 0.0)
	if r.Value != 0.30000000000000004 {
		t.Errorf("Value = %v; want 0.30000000000000004", r.Value)
	}
}

func TestEvaluateTypedMismatch_StringDefaultAgainstInt(t *testing.T) {
	r := evaluator.Evaluate(intConfig("flag", 5), "flag", "not-a-number")
	if r.Value != "not-a-number" {
		t.Errorf("Value = %v; want \"not-a-number\" default", r.Value)
	}
	if r.Error != "TYPE_MISMATCH" {
		t.Errorf("Error = %q; want TYPE_MISMATCH", r.Error)
	}
}

func TestEvaluateTypedMismatch_IntDefaultAgainstString(t *testing.T) {
	r := evaluator.Evaluate(stringConfig("flag", "hello"), "flag", 0)
	if r.Value != 0 {
		t.Errorf("Value = %v; want int(0) default", r.Value)
	}
	if r.Error != "TYPE_MISMATCH" {
		t.Errorf("Error = %q; want TYPE_MISMATCH", r.Error)
	}
}

func TestEvaluateTypedMismatch_StringDefaultAgainstDouble(t *testing.T) {
	r := evaluator.Evaluate(doubleConfig("flag", 0.25), "flag", "not-a-number")
	if r.Value != "not-a-number" {
		t.Errorf("Value = %v; want \"not-a-number\" default", r.Value)
	}
	if r.Error != "TYPE_MISMATCH" {
		t.Errorf("Error = %q; want TYPE_MISMATCH", r.Error)
	}
}

func TestEvaluateTypedMalformed_StringSlotMissing(t *testing.T) {
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(1),
				"v": map[string]any{"b": true}, // wrong slot
				"i": "vid",
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", "fallback")
	if r.Value != "fallback" {
		t.Errorf("Value = %v; want fallback default", r.Value)
	}
	if r.Error != "MALFORMED_VALUE" {
		t.Errorf("Error = %q; want MALFORMED_VALUE", r.Error)
	}
}

func TestEvaluateTypedMalformed_IntSlotNonInteger(t *testing.T) {
	// JSON's number type doesn't distinguish int from float — we reject
	// non-int-coercible floats as MALFORMED_VALUE.
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(2),
				"v": map[string]any{"i": 1.5},
				"i": "vid",
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", 0)
	if r.Value != 0 {
		t.Errorf("Value = %v; want int(0) default", r.Value)
	}
	if r.Error != "MALFORMED_VALUE" {
		t.Errorf("Error = %q; want MALFORMED_VALUE", r.Error)
	}
}

func TestEvaluateTypedMalformed_DoubleSlotMissing(t *testing.T) {
	cfg := evaluator.Config{
		"f": map[string]any{
			"flag": map[string]any{
				"t": float64(3),
				"v": map[string]any{"s": "no-double-here"},
				"i": "vid",
			},
		},
	}
	r := evaluator.Evaluate(cfg, "flag", 0.0)
	if r.Value != 0.0 {
		t.Errorf("Value = %v; want float64(0) default", r.Value)
	}
	if r.Error != "MALFORMED_VALUE" {
		t.Errorf("Error = %q; want MALFORMED_VALUE", r.Error)
	}
}
