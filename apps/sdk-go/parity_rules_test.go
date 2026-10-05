// SPDX-License-Identifier: MIT

package confeature_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// Targeting-rule parity (spec 135 / #433, epic #382, US3) — the CORPUS_RULES
// corpus injected through the full-config offline override.
//
// Unlike the flat parity-corpus / parity-corpus-typed corpora (which feed a
// value-only overridesMap via MapOverrideDataSource), the rule corpus carries
// the WHOLE {p, f, s} config and is injected via NewFlagOverridesFromConfig +
// LocalOnly. The SDK then resolves targeting rules / segments / % options
// offline through the real Go evaluator, exactly as it would against a
// CDN-served config — no network round-trip (INV-4: the full salt + segments
// travel with the config, never just f).
//
// Runner contract (mirrors apps/sdk-node/tests/parity/parity-rules.test.ts and
// the sdk-python / sdk-dotnet ports): every tuple branches on the config's
// injectionMode. A "full-config" tuple is capability-probed against
// NewFlagOverridesFromConfig — if the SDK exposes it, build the override and
// assert the PUBLIC GetValue returns tuple.expected; if it does NOT, SKIP with
// a reason and NEVER fall back to the flat-map path (SC-004: no "full-config"
// tuple is ever resolved on the map path).
//
// sdk-go HAS adopted the full-config path (NewFlagOverridesFromConfig is a
// compile-time symbol), so every loaded rule tuple runs and passes; no skips.
//
// Constitution invariant (Principle II NON-NEGOTIABLE): every loaded tuple MUST
// pass. A real drift means investigating the evaluator / override router —
// NEVER mutating the corpus. A genuine Go targeting-rule engine gap (not an
// override-wiring bug) is a discrete #382 follow-up — STOP and file it, never a
// workaround.

type parityRuleConfigRecord struct {
	ID            string         `json:"id"`
	Description   string         `json:"description"`
	InjectionMode string         `json:"injectionMode"`
	Config        map[string]any `json:"config"`
}

func loadParityRulesCorpus(t *testing.T) []parityTuple {
	t.Helper()
	path := testutil.ParityCorpusRulesPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rules parity corpus %s: %v", path, err)
	}
	var tuples []parityTuple
	if err := json.Unmarshal(raw, &tuples); err != nil {
		t.Fatalf("unmarshal rules parity corpus: %v", err)
	}
	return tuples
}

func loadParityRulesConfigs(t *testing.T) map[string]parityRuleConfigRecord {
	t.Helper()
	path := testutil.ParityConfigsRulesPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rules parity configs %s: %v", path, err)
	}
	var records []parityRuleConfigRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("unmarshal rules parity configs: %v", err)
	}
	out := make(map[string]parityRuleConfigRecord, len(records))
	for _, r := range records {
		out[r.ID] = r
	}
	return out
}

// TestParityCorpusRules is the spec 135 US3 targeting-rule parity gate. Every
// loaded tuple MUST stay green — any drift implies a Principle II violation or a
// real Go targeting-rule engine gap (the latter is a discrete #382 follow-up).
func TestParityCorpusRules(t *testing.T) {
	tuples := loadParityRulesCorpus(t)
	configsByID := loadParityRulesConfigs(t)

	// Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
	// foundational #383 tuples are never removed) and grows with every
	// comparator spec, so we assert only that the fixture actually loaded — not
	// a hardcoded total that re-trips on every growth. Per-tuple correctness is
	// covered by the per-tuple subtests below, and JSON↔TS sync is owned by the
	// central `check:exports` gate, so this guard is purely a non-empty smoke
	// and never needs a per-spec bump.
	if len(tuples) < 8 {
		t.Fatalf("rules corpus is non-empty (append-only floor: at least the 8 "+
			"foundational rule tuples), got %d — looks empty/truncated, regenerate "+
			"via `pnpm run export:corpus` in packages/test-fixtures-sdk-parity/",
			len(tuples))
	}

	for _, tuple := range tuples {
		tuple := tuple // capture per-iteration
		t.Run(tuple.Description, func(t *testing.T) {
			cfg, ok := configsByID[tuple.ConfigID]
			if !ok {
				t.Fatalf("rules corpus references unknown configId=%q; "+
					"regenerate fixtures via `pnpm run export:corpus`",
					tuple.ConfigID)
			}

			// Branch on injectionMode. The rule corpus is full-config only;
			// a flat-map tuple here would be a corpus regression, never a
			// silent flat-map fallback (SC-004).
			if cfg.InjectionMode != "full-config" {
				t.Fatalf("rules corpus tuple %q has unexpected injectionMode=%q; "+
					"expected \"full-config\" — never resolve a rule tuple on the "+
					"flat-map path (SC-004)", tuple.Description, cfg.InjectionMode)
			}

			// Full-config injection via the PUBLIC factory + LocalOnly. The
			// whole {p, f, s} config travels into the override source (salt +
			// segments + rule-bearing f — INV-4).
			client, err := confeature.NewClient(
				parityTestSDKKey,
				confeature.WithManualPoll(),
				confeature.WithFlagOverrides(
					confeature.NewFlagOverridesFromConfig(cfg.Config, confeature.LocalOnly),
				),
			)
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			defer func() { _ = client.Close() }()

			// Rehydrate JSON-decoded floats to native Go ints for
			// SettingType.Int (t = 2) settings. encoding/json decodes every
			// JSON number to float64, but the evaluator (mirroring
			// configcat/go-sdk v9) requires a Go int default for an int
			// setting — a float64 default surfaces TYPE_MISMATCH and the raw
			// default is returned verbatim. The corpus stays byte-identical
			// (Principle II); only the Go view of defaultValue / expected is
			// normalised against the per-key SettingType, exactly as the typed
			// driver (TestParityCorpusTyped) already does.
			settingTypes := settingTypesFromConfig(cfg.Config)
			defaultValue := tuple.DefaultValue
			expected := tuple.Expected
			if st, hasType := settingTypes[tuple.Key]; hasType {
				defaultValue = normaliseForSettingType(defaultValue, st)
				expected = normaliseForSettingType(expected, st)
			}

			// Assert via the PUBLIC value API — proves targeting-rule
			// conformance end-to-end, not just the internal evaluator.
			actual := client.GetValue(
				tuple.Key,
				defaultValue,
				makeParityUser(tuple.User),
			)

			if !reflect.DeepEqual(actual, expected) {
				t.Errorf("Targeting-rule parity drift on %q\n"+
					"  expected: %v (%T)\n"+
					"  actual:   %v (%T)\n"+
					"Constitution Principle II NON-NEGOTIABLE — investigate the "+
					"evaluator / override router, do NOT mutate the corpus. If this "+
					"is a real Go targeting-rule engine gap (not an override-wiring "+
					"bug), STOP and file a discrete #382 follow-up — never a corpus "+
					"or test workaround.",
					tuple.Description,
					expected, expected,
					actual, actual)
			}

			// variationId assertion (spec 152 / #475 US2). For the 14 tuples
			// that carry an expectedVariationId, ALSO drive the PUBLIC typed
			// Get<T>ValueDetails accessor and assert Data.VariationID matches.
			// The variationId travels with the resolved value through the
			// full-config override path (client.go evaluateWithContext →
			// info.VariationID = r.VariationID), proving the override→details
			// propagation end-to-end (#395 gap class). Value-only tuples (no
			// expectedVariationId) keep the GetValue assertion above and skip
			// this block.
			if tuple.ExpectedVariationID != "" {
				st := settingTypes[tuple.Key]
				detVal, detVID := getValueDetailsForSettingType(
					client, st, tuple.Key, defaultValue, makeParityUser(tuple.User),
				)

				if detVID != tuple.ExpectedVariationID {
					t.Errorf("variationId parity drift on %q\n"+
						"  expected variationId: %q\n"+
						"  actual variationId:   %q\n"+
						"Spec 152 / #475 US2 — the PUBLIC Get<T>ValueDetails accessor "+
						"MUST surface the setting.i / rule s.i / percentage-option i "+
						"through the full-config override path. A genuine divergence is "+
						"an override→details wiring bug (#395 class) or an evaluator "+
						"gap (#382) — STOP and investigate, never mutate the corpus.",
						tuple.Description, tuple.ExpectedVariationID, detVID)
				}

				// The details accessor must resolve the SAME value as GetValue.
				// For the decimal (t=3 double) tuples this is a numeric float64
				// comparison; ints/strings/bools compare by their native Go
				// type. expected is already SettingType-normalised above, so
				// reflect.DeepEqual is an exact numeric/typed match.
				if !reflect.DeepEqual(detVal, expected) {
					t.Errorf("Get<T>ValueDetails value drift on %q\n"+
						"  expected: %v (%T)\n"+
						"  details:  %v (%T)\n"+
						"The typed details accessor must resolve to the same value as "+
						"the untyped GetValue path (spec 152 US2).",
						tuple.Description, expected, expected, detVal, detVal)
				}
			}
		})
	}
}

// getValueDetailsForSettingType dispatches to the PUBLIC typed
// Get<T>ValueDetails accessor matching the wire SettingType discriminator
// (0=bool, 1=string, 2=int, 3=double) and returns the resolved value plus
// its Data.VariationID. The defaultValue is already SettingType-normalised
// by the caller (float64→int for t=2), so it threads straight into the
// type-matched accessor without re-coercion. Mirrors the public details
// surface ConfigCat's go-sdk exposes (GetBoolValueDetails / … ), per
// Principle II — the assertion runs against the customer-facing API, not
// an internal evaluator probe.
func getValueDetailsForSettingType(
	client *confeature.Client, settingType int,
	key string, defaultValue any, user *confeature.User,
) (value any, variationID string) {
	switch settingType {
	case 0: // SettingType.Bool
		d, _ := defaultValue.(bool)
		det := client.GetBoolValueDetails(key, d, user)
		return det.Value, det.Data.VariationID
	case 1: // SettingType.String
		d, _ := defaultValue.(string)
		det := client.GetStringValueDetails(key, d, user)
		return det.Value, det.Data.VariationID
	case 2: // SettingType.Int (whole)
		d, _ := defaultValue.(int)
		det := client.GetIntValueDetails(key, d, user)
		return det.Value, det.Data.VariationID
	case 3: // SettingType.Double (decimal)
		d, _ := defaultValue.(float64)
		det := client.GetFloatValueDetails(key, d, user)
		return det.Value, det.Data.VariationID
	default:
		return nil, ""
	}
}
