// SPDX-License-Identifier: MIT

package confeature_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// Spec 075 (#265) — typed-getter coverage gate.
//
// Drives each of the six evaluator error branches (KEY_NOT_FOUND,
// TYPE_MISMATCH, MALFORMED_VALUE, UNSUPPORTED_TYPE, NO_CONFIG,
// MALFORMED_CONFIG) plus CLIENT_CLOSED through the four typed
// *ValueDetails accessors on *Client and *Snapshot. Each test
// asserts:
//
//   1. The typed Value field equals the supplied default.
//   2. Data.IsDefaultValue is true.
//   3. Data.Error is the matching sentinel (errors.Is).
//   4. Data.Key, Data.User, Data.VariationID, Data.MatchedTargetingRule,
//      Data.MatchedPercentageOption carry the expected v1 values.
//
// FR-014 anchors the matrix. The override path covers the four
// reachable-via-overrides branches (KEY_NOT_FOUND, TYPE_MISMATCH,
// MALFORMED_VALUE via an empty-slot custom data source, NO_CONFIG via
// a no-overrides client); the remaining two evaluator-only branches
// (UNSUPPORTED_TYPE, MALFORMED_CONFIG) are covered by the
// errorFromCode sentinel-mapping test alongside (typed_getters_internal_test.go).

const typedTestKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

func newTypedTestLogger() confeature.Logger {
	return confeature.NewSlogLogger(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		confeature.LogLevelError,
	)
}

// emptySlotDataSource returns a SettingValue with all four pointer
// slots nil, exercising override-eval Branch 5 (the slot is malformed
// — surface as MALFORMED_VALUE on the typed *ValueDetails path).
type emptySlotDataSource struct {
	key string
}

func (e *emptySlotDataSource) GetOverridesSync() map[string]confeature.SettingValue {
	return map[string]confeature.SettingValue{
		e.key: {}, // all pointers nil
	}
}

func (e *emptySlotDataSource) GetOverrides(_ context.Context) (map[string]confeature.SettingValue, error) {
	return e.GetOverridesSync(), nil
}

// ── Happy-path coverage — typed getters resolve typed values ────────

func TestTypedGettersHappyPath(t *testing.T) {
	overrides := map[string]any{
		"feature.b": true,
		"feature.s": "hello",
		"feature.i": 42,
		"feature.d": 3.14,
	}
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	if got := client.GetBoolValue("feature.b", false, nil); got != true {
		t.Errorf("GetBoolValue: got %v; want true", got)
	}
	if got := client.GetStringValue("feature.s", "default", nil); got != "hello" {
		t.Errorf("GetStringValue: got %q; want %q", got, "hello")
	}
	if got := client.GetIntValue("feature.i", 0, nil); got != 42 {
		t.Errorf("GetIntValue: got %d; want 42", got)
	}
	if got := client.GetFloatValue("feature.d", 0.0, nil); got != 3.14 {
		t.Errorf("GetFloatValue: got %v; want 3.14", got)
	}

	// Snapshot mirror.
	snap := client.Snapshot()
	if got := snap.GetBoolValue("feature.b", false, nil); got != true {
		t.Errorf("Snapshot.GetBoolValue: got %v; want true", got)
	}
	if got := snap.GetStringValue("feature.s", "default", nil); got != "hello" {
		t.Errorf("Snapshot.GetStringValue: got %q; want %q", got, "hello")
	}
	if got := snap.GetIntValue("feature.i", 0, nil); got != 42 {
		t.Errorf("Snapshot.GetIntValue: got %d; want 42", got)
	}
	if got := snap.GetFloatValue("feature.d", 0.0, nil); got != 3.14 {
		t.Errorf("Snapshot.GetFloatValue: got %v; want 3.14", got)
	}
}

func TestTypedDetailsHappyPath(t *testing.T) {
	overrides := map[string]any{"feature.b": true}
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	user := &confeature.User{Identifier: "u1"}
	d := client.GetBoolValueDetails("feature.b", false, user)
	if d.Value != true {
		t.Errorf("Value = %v; want true", d.Value)
	}
	if d.Data.IsDefaultValue {
		t.Error("IsDefaultValue = true; want false on happy path")
	}
	if d.Data.Error != nil {
		t.Errorf("Error = %v; want nil on happy path", d.Data.Error)
	}
	if d.Data.Key != "feature.b" {
		t.Errorf("Key = %q; want feature.b", d.Data.Key)
	}
	if d.Data.User != user {
		t.Errorf("User pointer mismatch: got %p, want %p", d.Data.User, user)
	}
	if d.Data.VariationID != "" {
		t.Errorf("VariationID = %q; want empty (v1)", d.Data.VariationID)
	}
	if d.Data.MatchedTargetingRule != nil {
		t.Error("MatchedTargetingRule should be nil in v1")
	}
	if d.Data.MatchedPercentageOption != nil {
		t.Error("MatchedPercentageOption should be nil in v1")
	}
}

// ── KEY_NOT_FOUND — request a key absent from the overrides map ─────

func TestTypedDetailsKeyNotFound(t *testing.T) {
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"only.present": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	// Bool.
	b := client.GetBoolValueDetails("missing.key", true, nil)
	if b.Value != true {
		t.Errorf("bool Value = %v; want true (default)", b.Value)
	}
	if !b.Data.IsDefaultValue {
		t.Error("bool IsDefaultValue = false; want true")
	}
	if !errors.Is(b.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("bool Error = %v; want ErrKeyNotFound", b.Data.Error)
	}

	// String.
	s := client.GetStringValueDetails("missing.key", "def", nil)
	if s.Value != "def" {
		t.Errorf("string Value = %q; want def", s.Value)
	}
	if !errors.Is(s.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("string Error = %v; want ErrKeyNotFound", s.Data.Error)
	}

	// Int.
	i := client.GetIntValueDetails("missing.key", 7, nil)
	if i.Value != 7 {
		t.Errorf("int Value = %d; want 7", i.Value)
	}
	if !errors.Is(i.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("int Error = %v; want ErrKeyNotFound", i.Data.Error)
	}

	// Float.
	f := client.GetFloatValueDetails("missing.key", 1.5, nil)
	if f.Value != 1.5 {
		t.Errorf("float Value = %v; want 1.5", f.Value)
	}
	if !errors.Is(f.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("float Error = %v; want ErrKeyNotFound", f.Data.Error)
	}

	// Snapshot mirror — same matrix.
	snap := client.Snapshot()
	if d := snap.GetBoolValueDetails("missing.key", true, nil); !errors.Is(d.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("snapshot bool Error = %v; want ErrKeyNotFound", d.Data.Error)
	}
	if d := snap.GetStringValueDetails("missing.key", "x", nil); !errors.Is(d.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("snapshot string Error = %v; want ErrKeyNotFound", d.Data.Error)
	}
	if d := snap.GetIntValueDetails("missing.key", 0, nil); !errors.Is(d.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("snapshot int Error = %v; want ErrKeyNotFound", d.Data.Error)
	}
	if d := snap.GetFloatValueDetails("missing.key", 0.0, nil); !errors.Is(d.Data.Error, confeature.ErrKeyNotFound) {
		t.Errorf("snapshot float Error = %v; want ErrKeyNotFound", d.Data.Error)
	}
}

// ── TYPE_MISMATCH — override slot type ≠ default type ───────────────

func TestTypedDetailsTypeMismatch(t *testing.T) {
	// "feature.x" is set as int in the overrides — call each typed
	// getter whose default has a different type. Each MUST return
	// default + ErrTypeMismatch.
	overrides := map[string]any{"feature.x": 99}
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	// bool default vs int slot.
	b := client.GetBoolValueDetails("feature.x", true, nil)
	if b.Value != true {
		t.Errorf("bool Value = %v; want true (default)", b.Value)
	}
	if !errors.Is(b.Data.Error, confeature.ErrTypeMismatch) {
		t.Errorf("bool Error = %v; want ErrTypeMismatch", b.Data.Error)
	}

	// string default vs int slot.
	s := client.GetStringValueDetails("feature.x", "def", nil)
	if s.Value != "def" {
		t.Errorf("string Value = %q; want def", s.Value)
	}
	if !errors.Is(s.Data.Error, confeature.ErrTypeMismatch) {
		t.Errorf("string Error = %v; want ErrTypeMismatch", s.Data.Error)
	}

	// float default vs int slot.
	f := client.GetFloatValueDetails("feature.x", 1.5, nil)
	if f.Value != 1.5 {
		t.Errorf("float Value = %v; want 1.5", f.Value)
	}
	if !errors.Is(f.Data.Error, confeature.ErrTypeMismatch) {
		t.Errorf("float Error = %v; want ErrTypeMismatch", f.Data.Error)
	}

	// int default vs bool slot — flip the mismatch direction.
	client2, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"feature.x": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client2.Close() }()

	i := client2.GetIntValueDetails("feature.x", 7, nil)
	if i.Value != 7 {
		t.Errorf("int Value = %d; want 7", i.Value)
	}
	if !errors.Is(i.Data.Error, confeature.ErrTypeMismatch) {
		t.Errorf("int Error = %v; want ErrTypeMismatch", i.Data.Error)
	}
}

// ── MALFORMED_VALUE — override slot's pointers are all nil ──────────

func TestTypedDetailsMalformedValue(t *testing.T) {
	src := &emptySlotDataSource{key: "k"}
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: src,
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	// Each typed accessor MUST surface ErrMalformedValue when the
	// override slot has no populated pointer.
	cases := []struct {
		name string
		run  func() error
	}{
		{
			name: "bool",
			run: func() error {
				d := client.GetBoolValueDetails("k", true, nil)
				if d.Value != true {
					return errors.New("bool Value != default")
				}
				if !errors.Is(d.Data.Error, confeature.ErrMalformedValue) {
					return d.Data.Error
				}
				return nil
			},
		},
		{
			name: "string",
			run: func() error {
				d := client.GetStringValueDetails("k", "def", nil)
				if d.Value != "def" {
					return errors.New("string Value != default")
				}
				if !errors.Is(d.Data.Error, confeature.ErrMalformedValue) {
					return d.Data.Error
				}
				return nil
			},
		},
		{
			name: "int",
			run: func() error {
				d := client.GetIntValueDetails("k", 7, nil)
				if d.Value != 7 {
					return errors.New("int Value != default")
				}
				if !errors.Is(d.Data.Error, confeature.ErrMalformedValue) {
					return d.Data.Error
				}
				return nil
			},
		},
		{
			name: "float",
			run: func() error {
				d := client.GetFloatValueDetails("k", 1.5, nil)
				if d.Value != 1.5 {
					return errors.New("float Value != default")
				}
				if !errors.Is(d.Data.Error, confeature.ErrMalformedValue) {
					return d.Data.Error
				}
				return nil
			},
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.run(); err != nil {
				t.Errorf("%s: %v", tc.name, err)
			}
		})
	}
}

// ── NO_CONFIG — no overrides, no fetch, evaluator gets nil config ───

func TestTypedDetailsNoConfig(t *testing.T) {
	// No flag-overrides → override-eval is skipped. ManualPoll →
	// no background fetch. The evaluator runs against config=nil
	// and returns NO_CONFIG.
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	b := client.GetBoolValueDetails("k", true, nil)
	if b.Value != true {
		t.Errorf("bool Value = %v; want true (default)", b.Value)
	}
	if !errors.Is(b.Data.Error, confeature.ErrNoConfig) {
		t.Errorf("bool Error = %v; want ErrNoConfig", b.Data.Error)
	}
	if !b.Data.IsDefaultValue {
		t.Error("bool IsDefaultValue = false; want true")
	}

	s := client.GetStringValueDetails("k", "def", nil)
	if !errors.Is(s.Data.Error, confeature.ErrNoConfig) {
		t.Errorf("string Error = %v; want ErrNoConfig", s.Data.Error)
	}

	i := client.GetIntValueDetails("k", 7, nil)
	if !errors.Is(i.Data.Error, confeature.ErrNoConfig) {
		t.Errorf("int Error = %v; want ErrNoConfig", i.Data.Error)
	}

	f := client.GetFloatValueDetails("k", 1.5, nil)
	if !errors.Is(f.Data.Error, confeature.ErrNoConfig) {
		t.Errorf("float Error = %v; want ErrNoConfig", f.Data.Error)
	}

	// Snapshot mirror.
	snap := client.Snapshot()
	if d := snap.GetBoolValueDetails("k", false, nil); !errors.Is(d.Data.Error, confeature.ErrNoConfig) {
		t.Errorf("snapshot bool Error = %v; want ErrNoConfig", d.Data.Error)
	}
}

// ── CLIENT_CLOSED — calls after Close return defaults + ErrClientClosed

func TestTypedDetailsClientClosed(t *testing.T) {
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"k": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_ = client.Close()

	b := client.GetBoolValueDetails("k", false, nil)
	if b.Value != false {
		t.Errorf("post-Close bool Value = %v; want false (default)", b.Value)
	}
	if !errors.Is(b.Data.Error, confeature.ErrClientClosed) {
		t.Errorf("bool Error = %v; want ErrClientClosed", b.Data.Error)
	}
	if !b.Data.IsDefaultValue {
		t.Error("bool IsDefaultValue = false; want true on closed client")
	}

	// Typed getter direct path — returns default silently.
	if got := client.GetBoolValue("k", false, nil); got != false {
		t.Errorf("post-Close GetBoolValue = %v; want false (default)", got)
	}
	if got := client.GetStringValue("k", "def", nil); got != "def" {
		t.Errorf("post-Close GetStringValue = %q; want def", got)
	}
	if got := client.GetIntValue("k", 7, nil); got != 7 {
		t.Errorf("post-Close GetIntValue = %d; want 7", got)
	}
	if got := client.GetFloatValue("k", 1.5, nil); got != 1.5 {
		t.Errorf("post-Close GetFloatValue = %v; want 1.5", got)
	}
}

// ── *WithContext siblings — context propagates and is honoured ──────

func TestTypedGettersWithContext(t *testing.T) {
	overrides := map[string]any{
		"feature.b": true,
		"feature.s": "hello",
		"feature.i": 42,
		"feature.d": 3.14,
	}
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	ctx := context.Background()
	if got := client.GetBoolValueWithContext(ctx, "feature.b", false, nil); got != true {
		t.Errorf("GetBoolValueWithContext: got %v; want true", got)
	}
	if got := client.GetStringValueWithContext(ctx, "feature.s", "x", nil); got != "hello" {
		t.Errorf("GetStringValueWithContext: got %q; want hello", got)
	}
	if got := client.GetIntValueWithContext(ctx, "feature.i", 0, nil); got != 42 {
		t.Errorf("GetIntValueWithContext: got %d; want 42", got)
	}
	if got := client.GetFloatValueWithContext(ctx, "feature.d", 0.0, nil); got != 3.14 {
		t.Errorf("GetFloatValueWithContext: got %v; want 3.14", got)
	}

	// Details *WithContext siblings.
	if d := client.GetBoolValueDetailsWithContext(ctx, "feature.b", false, nil); d.Value != true {
		t.Errorf("GetBoolValueDetailsWithContext Value = %v; want true", d.Value)
	}
	if d := client.GetStringValueDetailsWithContext(ctx, "feature.s", "x", nil); d.Value != "hello" {
		t.Errorf("GetStringValueDetailsWithContext Value = %q; want hello", d.Value)
	}
	if d := client.GetIntValueDetailsWithContext(ctx, "feature.i", 0, nil); d.Value != 42 {
		t.Errorf("GetIntValueDetailsWithContext Value = %d; want 42", d.Value)
	}
	if d := client.GetFloatValueDetailsWithContext(ctx, "feature.d", 0.0, nil); d.Value != 3.14 {
		t.Errorf("GetFloatValueDetailsWithContext Value = %v; want 3.14", d.Value)
	}
}

// ── FetchTime plumbing — zero before fetch, set after cache-restore ─

func TestTypedDetailsFetchTimeZeroBeforeFetch(t *testing.T) {
	// ManualPoll + :memory: cache + no overrides → no fetch ever fires
	// and no cache entry exists. Data.FetchTime MUST be zero.
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newTypedTestLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	d := client.GetBoolValueDetails("k", false, nil)
	if !d.Data.FetchTime.IsZero() {
		t.Errorf("FetchTime = %v; want zero before any fetch", d.Data.FetchTime)
	}
}

// TestSnapshotFetchTimeStableAcrossClose validates spec-036
// immutability: the snapshot captures fetchTime at construction time
// and the zero value persists across Close.
func TestSnapshotFetchTimeStableAcrossClose(t *testing.T) {
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"k": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	snap := client.Snapshot()
	t0 := snap.GetBoolValueDetails("k", false, nil).Data.FetchTime
	_ = client.Close()
	t1 := snap.GetBoolValueDetails("k", false, nil).Data.FetchTime
	if !t0.Equal(t1) {
		t.Errorf("snapshot FetchTime drifted across Close: %v → %v", t0, t1)
	}
}

// ── EvaluationDetailsData.User — pointer passes through verbatim ────

func TestTypedDetailsUserPointerPasses(t *testing.T) {
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"k": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	u := &confeature.User{Identifier: "alice"}
	d := client.GetBoolValueDetails("k", false, u)
	if d.Data.User != u {
		t.Errorf("Data.User = %p; want %p", d.Data.User, u)
	}

	// nil pointer propagates as nil.
	d = client.GetBoolValueDetails("k", false, nil)
	if d.Data.User != nil {
		t.Errorf("Data.User = %v; want nil", d.Data.User)
	}
}

// ── EvaluationDetailsData.Key — echoed verbatim, even on error ──────

func TestTypedDetailsKeyEchoed(t *testing.T) {
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"present": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	// Happy path.
	d := client.GetBoolValueDetails("present", false, nil)
	if d.Data.Key != "present" {
		t.Errorf("happy-path Key = %q; want present", d.Data.Key)
	}
	// Error path.
	d = client.GetBoolValueDetails("absent", false, nil)
	if d.Data.Key != "absent" {
		t.Errorf("error-path Key = %q; want absent", d.Data.Key)
	}
}

// ── Smoke — types compile and zero-value structs deref cleanly ──────

func TestPlaceholderTypesAreUsable(t *testing.T) {
	// Customers MUST be able to declare *TargetingRule / *PercentageOption
	// variables and compile — even though v1 never populates them.
	var tr *confeature.TargetingRule
	var po *confeature.PercentageOption
	if tr != nil {
		t.Error("TargetingRule var: zero value should be nil")
	}
	if po != nil {
		t.Error("PercentageOption var: zero value should be nil")
	}
	// Take their addresses through the struct field to anchor the
	// linker — proves the type is exported and addressable.
	var d confeature.EvaluationDetailsData
	d.MatchedTargetingRule = tr
	d.MatchedPercentageOption = po
	if d.MatchedTargetingRule != nil || d.MatchedPercentageOption != nil {
		t.Error("placeholder fields should stay nil after assignment from nil")
	}
}

// ── Sentinel error visibility ───────────────────────────────────────

func TestSentinelErrorsAreExportedAndDistinct(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"ErrKeyNotFound", confeature.ErrKeyNotFound},
		{"ErrTypeMismatch", confeature.ErrTypeMismatch},
		{"ErrMalformedValue", confeature.ErrMalformedValue},
		{"ErrValueNotBool", confeature.ErrValueNotBool},
		{"ErrUnsupportedType", confeature.ErrUnsupportedType},
		{"ErrNoConfig", confeature.ErrNoConfig},
		{"ErrMalformedConfig", confeature.ErrMalformedConfig},
	}
	for _, tc := range cases {
		if tc.err == nil {
			t.Errorf("%s is nil — sentinel must be a real error", tc.name)
		}
	}
	// Distinct identity.
	for i, a := range cases {
		for j, b := range cases {
			if i == j {
				continue
			}
			if errors.Is(a.err, b.err) {
				t.Errorf("%s and %s are not distinct sentinels", a.name, b.name)
			}
		}
	}
}

// ── Smoke — full pre-fetch happy path uses a non-zero FetchTime when a
// cache entry has been restored. We don't fire a network fetch in
// tests (no network policy), so this test runs on the no-fetch
// timeline only. Documented as covering the zero-time branch only;
// the non-zero branch is covered by parity_test.go's typed corpus
// runs and by integration smoke under pnpm dagger:go.

func TestFetchTimeSmoke(t *testing.T) {
	// The override path doesn't drive Client.fetchTime; the cache /
	// fetch path does. We assert the zero default here and rely on
	// parity_test.go for the populated case.
	client, err := confeature.NewClient(
		typedTestKey,
		confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"k": true},
			),
			Behaviour: confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	d := client.GetBoolValueDetails("k", false, nil)
	if !d.Data.FetchTime.IsZero() {
		// Sanity — :memory: cache + ManualPoll means no fetch and no
		// cache-restore ever happened. FetchTime MUST be zero.
		t.Errorf("FetchTime = %v; want zero (no fetch, no cache restore)", d.Data.FetchTime)
	}
	// A short sleep does not alter the FetchTime (sanity).
	time.Sleep(2 * time.Millisecond)
	d2 := client.GetBoolValueDetails("k", false, nil)
	if !d2.Data.FetchTime.Equal(d.Data.FetchTime) {
		t.Errorf("FetchTime moved without a fetch: %v → %v",
			d.Data.FetchTime, d2.Data.FetchTime)
	}
}
