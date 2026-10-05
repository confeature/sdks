// SPDX-License-Identifier: MIT

// Package overrideeval implements synchronous override evaluation.
//
// This is a Go port of:
//   - packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync (TS — canonical)
//   - apps/sdk-python/.../override_eval.py:evaluate_override_sync (Python port)
//
// The 7-branch decision tree is byte-identical across all three runtimes.
// The parity corpus is the canonical gate: drifting between languages
// breaks Constitution Principle II (NON-NEGOTIABLE).
//
// EvaluateSync returns (value, ok):
//   - ok=false → caller falls through to the cache (Branches 1-3).
//   - ok=true  → value is the resolved override result, possibly the
//     supplied default (Branches 4-6: LocalOnly contract — don't fall
//     through). Branch 7 returns the typed override value.
package overrideeval

import "reflect"

// Settings is the shape required from a customer override data source.
// We accept an interface rather than the public confeature.OverrideDataSource
// type to keep internal/overrideeval free of public-package imports
// (Go forbids internal/ → public cycles).
type Settings interface {
	GetOverridesSync() map[string]SettingValue
}

// SettingValue mirrors the public confeature.SettingValue. Defined
// separately to avoid the public→internal import direction; the
// concrete type is converted at the client boundary (see snapshot.go).
type SettingValue struct {
	B *bool
	S *string
	I *int
	D *float64
}

// Behaviour mirrors the public confeature.OverrideBehaviour enum.
// Only the LocalOnly variant is honoured here.
type Behaviour int

const (
	BehaviourLocalOnly Behaviour = iota
	BehaviourLocalOverRemote
	BehaviourRemoteOverLocal
)

// Overrides bundles a sync-capable data source + a behaviour. The
// concrete public confeature.FlagOverrides converts to this at the
// client boundary.
type Overrides struct {
	DataSource Settings
	Behaviour  Behaviour
}

// EvaluateSync walks the 7-branch decision tree.
//
// Algorithm — byte-identical to TS / Python ports:
//
//  1. flagOverrides == nil          → (nil, false)  // fall through
//  2. behaviour != LocalOnly        → (nil, false)  // deferred
//  3. data_source.GetOverridesSync() returns nil → (nil, false)
//  4. key absent                    → (defaultValue, true)  // LocalOnly contract
//  5. all four slots nil            → (defaultValue, true)  // empty override
//  6. type(candidate) != type(default), default != nil → (defaultValue, true)
//  7. happy path                    → (candidate, true)
//
// The TYPE_MISMATCH branch (6) preserves the LocalOnly contract: a
// nil default bypasses the type check (matches configcat-js's
// `defaultValue !== null` ternary).
func EvaluateSync(fo *Overrides, key string, defaultValue any) (any, bool) {
	// Branch 1: no overrides configured → caller falls through.
	if fo == nil {
		return nil, false
	}

	// Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
	if fo.Behaviour != BehaviourLocalOnly {
		return nil, false
	}

	// Branch 3: no synchronous data source or nil map → fall through.
	if fo.DataSource == nil {
		return nil, false
	}
	m := fo.DataSource.GetOverridesSync()
	if m == nil {
		return nil, false
	}

	// From here we are committed to the LocalOnly contract: NEVER fall
	// through — return either the typed override or the supplied default.

	// Branch 4: key absent → return default.
	raw, ok := m[key]
	if !ok {
		return defaultValue, true
	}

	// Branch 5: override slot empty → return default.
	candidate := pickCandidate(raw)
	if candidate == nil {
		return defaultValue, true
	}

	// Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
	// A nil defaultValue intentionally bypasses the check (matches
	// the TS `defaultValue !== null` semantics; nil in Go is the
	// equivalent sentinel).
	if defaultValue != nil {
		if reflect.TypeOf(candidate) != reflect.TypeOf(defaultValue) {
			return defaultValue, true
		}
	}

	// Branch 7: happy path — typed override value.
	return candidate, true
}

// pickCandidate returns the first non-nil slot of a SettingValue.
// Order: B, S, I, D — mirrors the TS `raw.b ?? raw.s ?? raw.i ?? raw.d`
// and the Python explicit-if chain.
func pickCandidate(raw SettingValue) any {
	if raw.B != nil {
		return *raw.B
	}
	if raw.S != nil {
		return *raw.S
	}
	if raw.I != nil {
		return *raw.I
	}
	if raw.D != nil {
		return *raw.D
	}
	return nil
}
