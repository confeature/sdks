// SPDX-License-Identifier: MIT

package confeature

import (
	"context"
	"fmt"
)

// OverrideBehaviour selects how flag overrides interact with the remote
// config. Mirrors configcat-go-sdk's enum 1:1.
//
// In v1 only LocalOnly is wired through. LocalOverRemote and
// RemoteOverLocal are accepted at the type level (for ABI compatibility)
// but trigger ErrOverrideBehaviourNotImplemented at evaluation time.
type OverrideBehaviour int

const (
	// LocalOnly: only overrides are consulted; remote config is
	// ignored entirely. The only behaviour wired in v1.
	LocalOnly OverrideBehaviour = iota

	// LocalOverRemote: overrides shadow remote; fall back when key
	// is absent. Deferred — returns ErrOverrideBehaviourNotImplemented.
	LocalOverRemote

	// RemoteOverLocal: remote wins; overrides fill gaps. Deferred —
	// returns ErrOverrideBehaviourNotImplemented.
	RemoteOverLocal
)

// String renders the behaviour for log lines.
func (b OverrideBehaviour) String() string {
	switch b {
	case LocalOnly:
		return "LocalOnly"
	case LocalOverRemote:
		return "LocalOverRemote"
	case RemoteOverLocal:
		return "RemoteOverLocal"
	default:
		return fmt.Sprintf("OverrideBehaviour(%d)", int(b))
	}
}

// SettingValue is one slot of a config_v6.json setting value. Exactly
// one of B, S, I, D is non-nil per setting. Pointer fields with
// omitempty preserve the "absent" semantics of the wire shape.
//
// Note: B is checked BEFORE I when converting Go primitives — a Go
// bool would otherwise be classified as a number. The
// NewMapOverrideDataSource constructor handles this correctly.
type SettingValue struct {
	B *bool    `json:"b,omitempty"`
	S *string  `json:"s,omitempty"`
	I *int     `json:"i,omitempty"`
	D *float64 `json:"d,omitempty"`
}

// OverrideDataSource is the interface implemented by customer override
// providers. The synchronous variant is the load-bearing path for
// Snapshot evaluation (spec-036 correctness).
//
// Customers that only ship the async variant should return nil from
// GetOverridesSync — the override-eval helper treats nil as "no sync
// data" and falls through to the cache.
type OverrideDataSource interface {
	// GetOverridesSync returns the overrides map synchronously, or
	// nil to signal "no sync data" (caller falls through).
	GetOverridesSync() map[string]SettingValue

	// GetOverrides is the async/cancellable variant. The production
	// MapOverrideDataSource returns the same map as the sync method.
	GetOverrides(ctx context.Context) (map[string]SettingValue, error)
}

// FlagOverrides bundles a data source with a behaviour. Pass via
// WithFlagOverrides(FlagOverrides{...}) at NewClient time.
type FlagOverrides struct {
	DataSource OverrideDataSource
	Behaviour  OverrideBehaviour
}

// MapOverrideDataSource is the production-default in-memory implementation
// of OverrideDataSource. It accepts a map[string]any of primitive values
// (bool / string / int / float64) and converts each value to its
// SettingValue slot once at construction time.
type MapOverrideDataSource struct {
	m map[string]SettingValue
}

// NewMapOverrideDataSource constructs a MapOverrideDataSource from a
// primitive-typed map.
//
// Supported value types: bool, string, int (any signed/unsigned width
// up to int64), float32, float64. Other types panic — the customer's
// bug surfaces at construction, not at eval time.
//
// The bool branch is checked first because Go has no implicit numeric
// conversion of bool, but a paranoid reader might worry about future
// generics widening. Explicit ordering also matches the Python SDK's
// _to_setting_value helper.
func NewMapOverrideDataSource(overrides map[string]any) *MapOverrideDataSource {
	out := make(map[string]SettingValue, len(overrides))
	for k, v := range overrides {
		out[k] = toSettingValue(v)
	}
	return &MapOverrideDataSource{m: out}
}

// toSettingValue maps a primitive override value to its SettingValue
// slot. Exposed for tests via the same-package alias in flag_overrides_internal.
func toSettingValue(value any) SettingValue {
	switch v := value.(type) {
	case bool:
		b := v
		return SettingValue{B: &b}
	case string:
		s := v
		return SettingValue{S: &s}
	case int:
		i := v
		return SettingValue{I: &i}
	case int8:
		i := int(v)
		return SettingValue{I: &i}
	case int16:
		i := int(v)
		return SettingValue{I: &i}
	case int32:
		i := int(v)
		return SettingValue{I: &i}
	case int64:
		i := int(v)
		return SettingValue{I: &i}
	case uint8:
		i := int(v)
		return SettingValue{I: &i}
	case uint16:
		i := int(v)
		return SettingValue{I: &i}
	case uint32:
		i := int(v)
		return SettingValue{I: &i}
	case float32:
		d := float64(v)
		return SettingValue{D: &d}
	case float64:
		d := v
		return SettingValue{D: &d}
	default:
		panic(fmt.Sprintf(
			"confeature: unsupported override value type %T; "+
				"supported types are bool, string, int*, float32, float64", value,
		))
	}
}

// GetOverridesSync returns the in-memory map.
func (d *MapOverrideDataSource) GetOverridesSync() map[string]SettingValue {
	return d.m
}

// GetOverrides returns the same in-memory map (no I/O).
func (d *MapOverrideDataSource) GetOverrides(_ context.Context) (map[string]SettingValue, error) {
	return d.m, nil
}

// ConfigOverrideDataSource is the full-config, rule-bearing override source
// (spec 135 / #433, epic #382, US3). It holds a complete parsed config_v6
// blob ({p, f, s}) and routes through the real Go evaluator offline.
//
// Where MapOverrideDataSource emits value-only settings, this source retains
// the WHOLE {p, f, s} config — salt (p.s) + segments (s) + rule-bearing
// settings (f) — so the evaluator can resolve targeting rules / segments /
// prerequisites / percentage options purely from the supplied config, with
// no network fetch. The whole config is retained (never just f) so the
// dropped-salt regression class (INV-4 / spec-129) cannot recur: percentage
// bucketing reads p.s and segment conditions read s.
//
// Additive extension (Principle II): ConfigCat's official Go SDK exposes the
// value-only configcat.LocalMap(...) and the file-based configcat.LocalFile(...).
// This in-memory full-config form is the runtime-agnostic analogue of the file
// source, mirroring the JS federation's ConfigOverrideDataSource /
// createFlagOverridesFromConfig and the sdk-python / sdk-dotnet ports. No
// ConfigCat-named member is renamed or retyped.
//
// GetOverridesSync returns the value-only base envelopes of the f settings so
// Snapshot.GetAllKeys can enumerate the override's flag keys; rule resolution
// itself never goes through that flat map — the override router dispatches on
// the source TYPE so a *ConfigOverrideDataSource always routes through the
// evaluator, never the flat-map path.
type ConfigOverrideDataSource struct {
	// config is the full parsed config_v6 blob ({p, f, s}). Read-only after
	// construction.
	config map[string]any

	// baseValues caches the value-only envelopes (the f settings' v slot)
	// for key enumeration. Built once at construction.
	baseValues map[string]SettingValue
}

// NewConfigOverrideDataSource constructs a ConfigOverrideDataSource from a
// full parsed config_v6 blob ({p, f, s}). The config is typically the
// result of json.Unmarshal into a map[string]any.
//
// The whole config is retained (salt + segments + rule-bearing f), never
// just f (INV-4). The base value envelopes are extracted once for key
// enumeration.
func NewConfigOverrideDataSource(config map[string]any) *ConfigOverrideDataSource {
	baseValues := map[string]SettingValue{}
	if f, ok := config["f"].(map[string]any); ok {
		for key, settingAny := range f {
			setting, ok := settingAny.(map[string]any)
			if !ok {
				continue
			}
			v, ok := setting["v"].(map[string]any)
			if !ok {
				continue
			}
			baseValues[key] = settingValueFromEnvelope(v)
		}
	}
	return &ConfigOverrideDataSource{config: config, baseValues: baseValues}
}

// Config returns the full parsed config_v6 blob ({p, f, s}). Consumed by the
// full-config override router, never the flat-map path.
func (d *ConfigOverrideDataSource) Config() map[string]any {
	return d.config
}

// GetOverridesSync returns the value-only base envelopes of the f settings
// (rules stripped), so key enumeration works. Resolution never goes through
// this map — see the type doc.
func (d *ConfigOverrideDataSource) GetOverridesSync() map[string]SettingValue {
	return d.baseValues
}

// GetOverrides returns the same value-only envelopes (no I/O).
func (d *ConfigOverrideDataSource) GetOverrides(_ context.Context) (map[string]SettingValue, error) {
	return d.baseValues, nil
}

// settingValueFromEnvelope reads a wire-shape value envelope (the setting's
// v slot: {b?, s?, i?, d?}) into a SettingValue. JSON-decoded numbers arrive
// as float64; an i-slot value is narrowed to int to match the evaluator's
// native int widening for SettingType.Int. Used only for key-enumeration
// envelopes — never for resolution.
func settingValueFromEnvelope(v map[string]any) SettingValue {
	var sv SettingValue
	if b, ok := v["b"].(bool); ok {
		bb := b
		sv.B = &bb
	}
	if s, ok := v["s"].(string); ok {
		ss := s
		sv.S = &ss
	}
	if i, ok := v["i"].(float64); ok {
		ii := int(i)
		sv.I = &ii
	}
	if d, ok := v["d"].(float64); ok {
		dd := d
		sv.D = &dd
	}
	return sv
}

// NewFlagOverridesFromConfig builds a FlagOverrides from a complete,
// rule-bearing config_v6 blob ({p, f, s}) evaluated offline through the real
// Go evaluator (spec 135 / #433, epic #382, US3).
//
// With LocalOnly behaviour, GetValue(key, default, user) resolves targeting
// rules / segments / prerequisites / percentage options purely from config —
// no network fetch. The whole config is retained (salt p.s + segments s,
// never just f — INV-4).
//
// Additive convenience factory (Principle II): the in-memory analogue of
// ConfigCat-Go's file-based configcat.LocalFile(...), mirroring the JS
// federation's createFlagOverridesFromConfig and the sdk-python /
// sdk-dotnet ports. No ConfigCat-named member is renamed or retyped.
func NewFlagOverridesFromConfig(config map[string]any, behaviour OverrideBehaviour) FlagOverrides {
	return FlagOverrides{
		DataSource: NewConfigOverrideDataSource(config),
		Behaviour:  behaviour,
	}
}
