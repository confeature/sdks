// SPDX-License-Identifier: MIT

package confeature

import (
	"errors"
	"fmt"
	"time"
)

// This file lands the typed-result envelope surface mandated by spec
// 075 (issue #265 — P1 MUST-FIX under constitution v1.2.0 §II). The
// types mirror configcat-go-sdk v9.1.0's eval_details.go 1:1 EXCEPT
// for two documented divergences:
//
//   - EvaluationDetailsData.User is *User (Confeature's
//     struct-pointer convention) instead of upstream's User
//     (interface{}). nil-pointer expresses "no targeting context"
//     identically to upstream's nil-interface. Same observable
//     behaviour on the v1 corpus (no targeting rules). See FR-009 +
//     api_surface_conformance_test.go DIVERGENCE-BY-DESIGN.
//
//   - MatchedTargetingRule and MatchedPercentageOption are typed
//     pointers to Confeature-namespace placeholder structs (always
//     nil in v1 — Confeature ships no targeting rules in the v1
//     corpus). See FR-007 + the placeholder doc comments below.
//
// The exported sentinel errors below are the stable customer-facing
// surface for Data.Error; the package-private errorFromCode helper is
// the single bridge from the internal evaluator's string error code
// to the sentinel. ErrClientClosed (errors.go:15) is reused for the
// closed-client branch.

// ── 1. Typed result envelopes (FR-005, FR-006) ───────────────────────

// EvaluationDetails carries an untyped evaluated value (Value is any)
// plus the EvaluationDetailsData metadata block. This is the shape
// handed to Hooks.OnFlagEvaluated — mirroring configcat-go-sdk v9's
// EvaluationDetails (whose Value is interface{}) 1:1. The four typed
// *EvaluationDetails siblings below are the typed-getter return shapes.
type EvaluationDetails struct {
	Data  EvaluationDetailsData
	Value any
}

// BoolEvaluationDetails carries the evaluated bool value and the
// associated EvaluationDetailsData. Returned by
// Client.GetBoolValueDetails (+ context-aware sibling) and
// Snapshot.GetBoolValueDetails.
//
// Mirrors configcat-go-sdk v9's BoolEvaluationDetails 1:1 — both
// fields, both names, both types.
type BoolEvaluationDetails struct {
	Data  EvaluationDetailsData
	Value bool
}

// IntEvaluationDetails is the int-typed sibling. Mirrors
// configcat-go-sdk v9's IntEvaluationDetails.
type IntEvaluationDetails struct {
	Data  EvaluationDetailsData
	Value int
}

// StringEvaluationDetails is the string-typed sibling. Mirrors
// configcat-go-sdk v9's StringEvaluationDetails.
type StringEvaluationDetails struct {
	Data  EvaluationDetailsData
	Value string
}

// FloatEvaluationDetails is the float64-typed sibling. Mirrors
// configcat-go-sdk v9's FloatEvaluationDetails.
type FloatEvaluationDetails struct {
	Data  EvaluationDetailsData
	Value float64
}

// ── 2. Shared metadata block (FR-006, FR-007) ────────────────────────

// EvaluationDetailsData is the metadata block carried by every typed
// *EvaluationDetails struct. Mirrors configcat-go-sdk v9's
// EvaluationDetailsData 1:1 EXCEPT:
//
//   - User is *User (Confeature's struct-pointer convention) instead
//     of upstream's User interface{}. See FR-009.
//   - MatchedTargetingRule / MatchedPercentageOption are typed
//     pointers to Confeature-namespace placeholder structs. v1
//     always populates these as nil. See FR-007 + the placeholder
//     doc comments below.
type EvaluationDetailsData struct {
	// Key is the flag key the consumer asked for. Echoed verbatim,
	// even when KEY_NOT_FOUND (Error is non-nil in that case).
	Key string

	// VariationID is the optional analytics-dedup id from setting.i.
	// Empty in v1 — Confeature has no variation IDs in the v1 corpus.
	// Always "" until a future spec wires variations.
	VariationID string

	// User is the *User pointer passed to the typed getter verbatim;
	// nil propagates as nil. Confeature substitutes *User for
	// upstream's User interface{} — see FR-009.
	User *User

	// IsDefaultValue is true when the typed accessor returned the
	// supplied defaultValue for any reason (missing key, type
	// mismatch, no config loaded, malformed config, malformed value,
	// unsupported type, closed client). Mirrors upstream semantics.
	IsDefaultValue bool

	// Error is a non-nil Go error on every fail branch; nil on the
	// happy path. Errors are stable sentinels (ErrKeyNotFound,
	// ErrTypeMismatch, ErrMalformedValue, ErrUnsupportedType,
	// ErrNoConfig, ErrMalformedConfig, ErrValueNotBool,
	// ErrClientClosed); customers test via
	// errors.Is(details.Data.Error, confeature.Err...).
	Error error

	// FetchTime is the wall-clock time at which the active config
	// was last fetched from the CDN. Zero time.Time when no config
	// has loaded yet (first-call-pre-fetch case). Populated from
	// Client.fetchTime (live client) or Snapshot.fetchTime (snapshot
	// capture).
	FetchTime time.Time

	// MatchedTargetingRule is the v1 nil-always placeholder pointer.
	// See TargetingRule below. Future spec populates.
	MatchedTargetingRule *TargetingRule

	// MatchedPercentageOption is the v1 nil-always placeholder
	// pointer. See PercentageOption below. Future spec populates.
	MatchedPercentageOption *PercentageOption
}

// ── 3. Placeholder targeting-rule types (D3, FR-007) ─────────────────

// TargetingRule is a v1 placeholder for the matched targeting rule.
// Confeature's v1 evaluator does not produce targeting-rule matches;
// EvaluationDetailsData.MatchedTargetingRule is always nil.
//
// A future spec lands targeting rules and adds fields here that
// match the v1 fields of configcat-go-sdk's TargetingRule
// (ServedValue, Conditions, PercentageOptions). The empty placeholder
// is exported so customers can declare *TargetingRule variables and
// compile.
//
// FR-007 — shape conformance, always nil in v1.
type TargetingRule struct{}

// PercentageOption is a v1 placeholder for the matched percentage
// option. Confeature's v1 evaluator does not produce
// percentage-option matches;
// EvaluationDetailsData.MatchedPercentageOption is always nil.
//
// A future spec lands percentage routing and adds fields here that
// match the v1 fields of configcat-go-sdk's PercentageOption (Value,
// Percentage, VariationID). The empty placeholder is exported so
// customers can declare *PercentageOption variables and compile.
//
// FR-007 — shape conformance, always nil in v1.
type PercentageOption struct{}

// ── 4. Stable sentinel errors (D4, FR-006, FR-014) ───────────────────

// Sentinel errors surfaced on EvaluationDetailsData.Error. Customers
// test via errors.Is(details.Data.Error, confeature.Err*). The
// existing ErrClientClosed (errors.go:15) is reused for the
// closed-client branch — not redeclared here.
var (
	// ErrKeyNotFound is surfaced on EvaluationDetailsData.Error when
	// the requested key is absent from the loaded config and the
	// override map. Mirrors evaluator.Result.Error = "KEY_NOT_FOUND".
	ErrKeyNotFound = errors.New("confeature: KEY_NOT_FOUND")

	// ErrTypeMismatch is surfaced when the supplied defaultValue's
	// Go type does not match the cached setting's SettingType.
	// Mirrors evaluator.Result.Error = "TYPE_MISMATCH".
	ErrTypeMismatch = errors.New("confeature: TYPE_MISMATCH")

	// ErrMalformedValue is surfaced when the cached setting's value
	// slot is missing or has the wrong wire shape (e.g. setting.v.s
	// missing). Mirrors evaluator.Result.Error = "MALFORMED_VALUE".
	ErrMalformedValue = errors.New("confeature: MALFORMED_VALUE")

	// ErrValueNotBool is surfaced when a boolean setting's v.b slot
	// is missing or non-bool. Mirrors evaluator.Result.Error =
	// "VALUE_NOT_BOOL".
	ErrValueNotBool = errors.New("confeature: VALUE_NOT_BOOL")

	// ErrUnsupportedType is surfaced when the cached setting's
	// SettingType discriminator is not 0/1/2/3. Mirrors
	// evaluator.Result.Error = "UNSUPPORTED_TYPE".
	ErrUnsupportedType = errors.New("confeature: UNSUPPORTED_TYPE")

	// ErrNoConfig is surfaced when no config has loaded yet (first
	// call before the poll service fires). Mirrors
	// evaluator.Result.Error = "NO_CONFIG".
	ErrNoConfig = errors.New("confeature: NO_CONFIG")

	// ErrMalformedConfig is surfaced when the loaded config has the
	// wrong wire shape (missing f, non-map settings, missing t).
	// Mirrors evaluator.Result.Error = "MALFORMED_CONFIG".
	ErrMalformedConfig = errors.New("confeature: MALFORMED_CONFIG")
)

// errorFromCode maps the internal evaluator's string error code to a
// stable exported sentinel. Returns nil for the empty string (happy
// path). Unknown codes are wrapped via fmt.Errorf so customers can
// still surface them via Data.Error without losing the message.
func errorFromCode(code string) error {
	switch code {
	case "":
		return nil
	case "KEY_NOT_FOUND":
		return ErrKeyNotFound
	case "TYPE_MISMATCH":
		return ErrTypeMismatch
	case "MALFORMED_VALUE":
		return ErrMalformedValue
	case "VALUE_NOT_BOOL":
		return ErrValueNotBool
	case "UNSUPPORTED_TYPE":
		return ErrUnsupportedType
	case "NO_CONFIG":
		return ErrNoConfig
	case "MALFORMED_CONFIG":
		return ErrMalformedConfig
	default:
		return fmt.Errorf("confeature: %s", code)
	}
}
