// SPDX-License-Identifier: MIT

package confeature

import (
	"sort"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
	"github.com/confeature/sdks/apps/sdk-go/internal/overrideeval"
)

// Snapshot is an immutable view of the last successfully-fetched
// config plus a reference to the FlagOverrides bundle. All methods are
// synchronous and safe to call after Client.Close.
//
// Snapshot.GetValue consults overrides FIRST via the 7-branch decision
// tree (spec-036 correctness inherited from day one for the Go SDK).
type Snapshot struct {
	config        map[string]any
	flagOverrides *FlagOverrides
	defaultUser   *User

	// fetchTime is captured from Client.fetchTime at Snapshot()-time
	// and stays stable across later fetches (spec-036 immutability).
	// Zero time.Time when the snapshot was created before any fetch.
	// Read by Get<T>ValueDetails on *Snapshot.
	fetchTime time.Time
}

// GetValue resolves key against the snapshot. Honours overrides
// synchronously before falling through to the cached config.
//
// On a TYPE_MISMATCH / UNSUPPORTED_TYPE / KEY_NOT_FOUND in the cache
// path, returns the supplied defaultValue.
//
// Deprecated: use GetBoolValue / GetStringValue / GetIntValue /
// GetFloatValue (or their *ValueDetails siblings) for type safety
// and a ConfigCat-Go-SDK-conforming surface. GetValue is kept for
// backward compatibility and existing callers; new code should
// prefer the typed accessors.
func (s *Snapshot) GetValue(key string, defaultValue any, user *User) any {
	v, _ := s.evaluate(key, defaultValue, user)
	return v
}

// evaluate is the shared resolver used by GetValue and the typed
// getters / details accessors on *Snapshot. Returns the resolved
// value plus the diagnostic envelope.
func (s *Snapshot) evaluate(
	key string, defaultValue any, user *User,
) (value any, info evalInfo) {
	// Override path FIRST — spec-036 correctness.
	if s.flagOverrides != nil && s.flagOverrides.DataSource != nil {
		// Full-config override source (spec 135 / #433): route the FULL
		// {p, f, s} config through the real evaluator so targeting rules /
		// segments resolve offline. The flat-map source is unchanged.
		if src, isFull := fullConfigSource(s.flagOverrides); isFull {
			effectiveUser := user
			if effectiveUser == nil {
				effectiveUser = s.defaultUser
			}
			r := evaluator.EvaluateForUser(
				src.Config(), key, defaultValue, toEvalUser(effectiveUser),
			)
			info.ErrorCode = r.Error
			info.VariationID = r.VariationID
			info.IsDefault = r.Error != ""
			info.MatchedTargetingRule = r.MatchedTargetingRule
			info.MatchedPercentageOption = r.MatchedPercentageOption
			return r.Value, info
		}
		if v, ok := overrideeval.EvaluateSync(
			s.overrideInternal(),
			key,
			defaultValue,
		); ok {
			info.ErrorCode = classifyOverrideOutcome(
				s.overrideInternal(), key, defaultValue, v,
			)
			info.IsDefault = info.ErrorCode != ""
			return v, info
		}
	}
	if user == nil {
		user = s.defaultUser
	}
	r := evaluator.EvaluateForUser(s.config, key, defaultValue, toEvalUser(user))
	info.ErrorCode = r.Error
	info.VariationID = r.VariationID
	info.IsDefault = r.Error != ""
	info.MatchedTargetingRule = r.MatchedTargetingRule
	info.MatchedPercentageOption = r.MatchedPercentageOption
	return r.Value, info
}

// ── Typed getters (FR-001..FR-004) on *Snapshot ──────────────────────

// GetBoolValue resolves key as a bool against the snapshot. Returns
// defaultValue on any failure branch. Mirrors configcat-go-sdk v9's
// (*Snapshot) typed surface (FR-009: user is *User).
func (s *Snapshot) GetBoolValue(key string, defaultValue bool, user *User) bool {
	v, _ := s.evaluate(key, defaultValue, user)
	if b, ok := v.(bool); ok {
		return b
	}
	return defaultValue
}

// GetStringValue resolves key as a string against the snapshot.
func (s *Snapshot) GetStringValue(key string, defaultValue string, user *User) string {
	v, _ := s.evaluate(key, defaultValue, user)
	if str, ok := v.(string); ok {
		return str
	}
	return defaultValue
}

// GetIntValue resolves key as an int against the snapshot.
func (s *Snapshot) GetIntValue(key string, defaultValue int, user *User) int {
	v, _ := s.evaluate(key, defaultValue, user)
	if i, ok := v.(int); ok {
		return i
	}
	return defaultValue
}

// GetFloatValue resolves key as a float64 against the snapshot.
func (s *Snapshot) GetFloatValue(key string, defaultValue float64, user *User) float64 {
	v, _ := s.evaluate(key, defaultValue, user)
	if f, ok := v.(float64); ok {
		return f
	}
	return defaultValue
}

// ── Typed value-details accessors on *Snapshot (FR-005, FR-006) ──────

// GetBoolValueDetails returns the typed value + EvaluationDetailsData
// for a boolean-typed flag. Snapshot's FetchTime is captured at
// Snapshot()-time and is stable across later fetches.
func (s *Snapshot) GetBoolValueDetails(
	key string, defaultValue bool, user *User,
) BoolEvaluationDetails {
	v, info := s.evaluate(key, defaultValue, user)
	value := defaultValue
	if b, ok := v.(bool); ok {
		value = b
	} else if !info.IsDefault && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return BoolEvaluationDetails{
		Value: value,
		Data:  s.buildDetailsData(key, user, info),
	}
}

// GetStringValueDetails returns the typed value + EvaluationDetailsData
// for a string-typed flag.
func (s *Snapshot) GetStringValueDetails(
	key string, defaultValue string, user *User,
) StringEvaluationDetails {
	v, info := s.evaluate(key, defaultValue, user)
	value := defaultValue
	if str, ok := v.(string); ok {
		value = str
	} else if !info.IsDefault && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return StringEvaluationDetails{
		Value: value,
		Data:  s.buildDetailsData(key, user, info),
	}
}

// GetIntValueDetails returns the typed value + EvaluationDetailsData
// for an int-typed flag.
func (s *Snapshot) GetIntValueDetails(
	key string, defaultValue int, user *User,
) IntEvaluationDetails {
	v, info := s.evaluate(key, defaultValue, user)
	value := defaultValue
	if i, ok := v.(int); ok {
		value = i
	} else if !info.IsDefault && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return IntEvaluationDetails{
		Value: value,
		Data:  s.buildDetailsData(key, user, info),
	}
}

// GetFloatValueDetails returns the typed value + EvaluationDetailsData
// for a float64-typed flag.
func (s *Snapshot) GetFloatValueDetails(
	key string, defaultValue float64, user *User,
) FloatEvaluationDetails {
	v, info := s.evaluate(key, defaultValue, user)
	value := defaultValue
	if f, ok := v.(float64); ok {
		value = f
	} else if !info.IsDefault && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return FloatEvaluationDetails{
		Value: value,
		Data:  s.buildDetailsData(key, user, info),
	}
}

// buildDetailsData assembles EvaluationDetailsData for a *Snapshot.
// FetchTime is the snapshot-captured timestamp (immutable for the
// life of the snapshot — spec-036). v1 leaves MatchedTargetingRule /
// MatchedPercentageOption nil (FR-007) and VariationID empty.
func (s *Snapshot) buildDetailsData(
	key string, user *User, info evalInfo,
) EvaluationDetailsData {
	var matchedRule *TargetingRule
	if info.MatchedTargetingRule != nil {
		matchedRule = &TargetingRule{}
	}
	var matchedOption *PercentageOption
	if info.MatchedPercentageOption != nil {
		matchedOption = &PercentageOption{}
	}
	return EvaluationDetailsData{
		Key:                     key,
		VariationID:             info.VariationID,
		User:                    user,
		IsDefaultValue:          info.IsDefault,
		Error:                   errorFromCode(info.ErrorCode),
		FetchTime:               s.fetchTime,
		MatchedTargetingRule:    matchedRule,
		MatchedPercentageOption: matchedOption,
	}
}

// GetAllKeys returns the union of keys in the cached config + the
// override map. Sorted ascending for deterministic test output.
func (s *Snapshot) GetAllKeys() []string {
	seen := make(map[string]struct{})
	if s.config != nil {
		if f, ok := s.config["f"].(map[string]any); ok {
			for k := range f {
				seen[k] = struct{}{}
			}
		}
	}
	if s.flagOverrides != nil && s.flagOverrides.DataSource != nil {
		for k := range s.flagOverrides.DataSource.GetOverridesSync() {
			seen[k] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// overrideInternal mirrors Client.overrideInternal — duplicated here
// to keep Snapshot independent of *Client (Snapshot is intentionally
// detachable from its source client).
func (s *Snapshot) overrideInternal() *overrideeval.Overrides {
	if s.flagOverrides == nil || s.flagOverrides.DataSource == nil {
		return nil
	}
	return &overrideeval.Overrides{
		DataSource: snapshotDataSourceAdapter{s.flagOverrides.DataSource},
		Behaviour:  overrideeval.Behaviour(s.flagOverrides.Behaviour),
	}
}

type snapshotDataSourceAdapter struct {
	src OverrideDataSource
}

func (a snapshotDataSourceAdapter) GetOverridesSync() map[string]overrideeval.SettingValue {
	m := a.src.GetOverridesSync()
	if m == nil {
		return nil
	}
	out := make(map[string]overrideeval.SettingValue, len(m))
	for k, v := range m {
		out[k] = overrideeval.SettingValue{
			B: v.B,
			S: v.S,
			I: v.I,
			D: v.D,
		}
	}
	return out
}
