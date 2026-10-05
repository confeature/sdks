// SPDX-License-Identifier: MIT

package confeature_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// Spec 038 root-package unit tests. These complement parity_test.go +
// public_import_test.go + snapshot_overrides_test.go by exercising the
// validation / construction / shutdown surface in isolation.

func newSilentLogger() confeature.Logger {
	// Discard the SDK's log output so test output stays clean. The
	// slog.Logger is wrapped at LogLevelError to also short-circuit
	// the WARNING-grade messages emitted by the validation path.
	return confeature.NewSlogLogger(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		confeature.LogLevelError,
	)
}

func TestNewClientRejectsEmptySDKKey(t *testing.T) {
	_, err := confeature.NewClient("")
	if !errors.Is(err, confeature.ErrInvalidSDKKey) {
		t.Errorf("err = %v; want ErrInvalidSDKKey", err)
	}
}

func TestNewClientRejectsNonPositiveTimeout(t *testing.T) {
	_, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithRequestTimeout(-1),
	)
	if !errors.Is(err, confeature.ErrInvalidOption) {
		t.Errorf("err = %v; want ErrInvalidOption", err)
	}
}

func TestNewClientRejectsFlagOverridesWithNilDataSource(t *testing.T) {
	_, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: nil,
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if !errors.Is(err, confeature.ErrInvalidOption) {
		t.Errorf("err = %v; want ErrInvalidOption", err)
	}
}

func TestNewClientLogsWarningOnInvalidKeyFormat(t *testing.T) {
	// A non-empty but invalid key MUST NOT abort construction — the
	// runtime is lenient (matches configcat-go-sdk).
	client, err := confeature.NewClient(
		"not-a-conformant-key",
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient with malformed key returned %v; want nil", err)
	}
	defer func() { _ = client.Close() }()
}

func TestCloseIdempotent(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Errorf("first Close: %v; want nil", err)
	}
	if err := client.Close(); !errors.Is(err, confeature.ErrClientClosed) {
		t.Errorf("second Close: %v; want ErrClientClosed", err)
	}
}

func TestGetValueAfterCloseReturnsDefault(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_ = client.Close()
	if got := client.GetValue("any.flag", true, nil); got != true {
		t.Errorf("post-Close GetValue: got %v; want true (default)", got)
	}
}

func TestGetValueWithContext(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
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
	ctx := context.Background()
	if got := client.GetValueWithContext(ctx, "k", false, nil); got != true {
		t.Errorf("GetValueWithContext: got %v; want true", got)
	}
}

func TestWithDefaultUserFallback(t *testing.T) {
	// WithDefaultUser kicks in when the caller passes nil. The v1
	// evaluator ignores user, so this test exercises the fallback
	// branch in client.resolveUser rather than its evaluation effect.
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithDefaultUser(&confeature.User{Identifier: "default-id"}),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{"k": true}),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()
	if got := client.GetValue("k", false, nil); got != true {
		t.Errorf("got %v; want true", got)
	}
}

func TestForceRefreshLocalOnlyIsNoOpSuccess(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{}),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()
	r := client.ForceRefresh()
	if !r.Success || r.Error != nil {
		t.Errorf("ForceRefresh: %+v; want {Success: true, Error: nil}", r)
	}
}

func TestForceRefreshAfterCloseReturnsErr(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_ = client.Close()
	r := client.ForceRefreshWithContext(context.Background())
	if r.Success || !errors.Is(r.Error, confeature.ErrClientClosed) {
		t.Errorf("ForceRefresh post-Close: %+v; want Error=ErrClientClosed", r)
	}
}

func TestOverrideBehaviourString(t *testing.T) {
	cases := []struct {
		b    confeature.OverrideBehaviour
		want string
	}{
		{confeature.LocalOnly, "LocalOnly"},
		{confeature.LocalOverRemote, "LocalOverRemote"},
		{confeature.RemoteOverLocal, "RemoteOverLocal"},
		{confeature.OverrideBehaviour(99), "OverrideBehaviour(99)"},
	}
	for _, c := range cases {
		if got := c.b.String(); got != c.want {
			t.Errorf("OverrideBehaviour(%d).String() = %q; want %q",
				int(c.b), got, c.want)
		}
	}
}

func TestLogLevelString(t *testing.T) {
	cases := []struct {
		l    confeature.LogLevel
		want string
	}{
		{confeature.LogLevelOff, "OFF"},
		{confeature.LogLevelError, "ERROR"},
		{confeature.LogLevelWarning, "WARNING"},
		{confeature.LogLevelInfo, "INFO"},
		{confeature.LogLevelDebug, "DEBUG"},
		{confeature.LogLevel(42), "UNKNOWN"},
	}
	for _, c := range cases {
		if got := c.l.String(); got != c.want {
			t.Errorf("LogLevel(%d).String() = %q; want %q", int(c.l), got, c.want)
		}
	}
}

func TestNonLocalOnlyOverrideBehaviourDefers(t *testing.T) {
	// LocalOverRemote / RemoteOverLocal are accepted at the type level
	// for ABI compatibility but log a deferral warning and fall through
	// to the cache (which is empty under ManualPoll → return default).
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(
				map[string]any{"k": true},
			),
			Behaviour: confeature.LocalOverRemote,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()
	// Default should be returned because the override path defers and
	// the cache is empty.
	if got := client.GetValue("k", false, nil); got != false {
		t.Errorf("got %v; want false (deferred → default)", got)
	}
}

func TestMapOverrideDataSourceGetOverridesAsync(t *testing.T) {
	src := confeature.NewMapOverrideDataSource(map[string]any{
		"feature.b": true,
		"feature.s": "hello",
		"feature.i": 42,
		"feature.d": 3.14,
	})
	m, err := src.GetOverrides(context.Background())
	if err != nil {
		t.Fatalf("GetOverrides: %v", err)
	}
	if len(m) != 4 {
		t.Errorf("len(map) = %d; want 4", len(m))
	}
	if m["feature.b"].B == nil || *m["feature.b"].B != true {
		t.Errorf("feature.b slot mismatch: %+v", m["feature.b"])
	}
	if m["feature.s"].S == nil || *m["feature.s"].S != "hello" {
		t.Errorf("feature.s slot mismatch: %+v", m["feature.s"])
	}
	if m["feature.i"].I == nil || *m["feature.i"].I != 42 {
		t.Errorf("feature.i slot mismatch: %+v", m["feature.i"])
	}
	if m["feature.d"].D == nil || *m["feature.d"].D != 3.14 {
		t.Errorf("feature.d slot mismatch: %+v", m["feature.d"])
	}
}

func TestNewMapOverrideDataSourcePanicsOnUnsupportedType(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for unsupported type")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic value = %v (%T); want string", r, r)
		}
		if !strings.Contains(msg, "unsupported override value type") {
			t.Errorf("panic message = %q; want substring 'unsupported override value type'", msg)
		}
	}()
	_ = confeature.NewMapOverrideDataSource(map[string]any{
		"k": []int{1, 2, 3}, // slices are not supported
	})
}

func TestWithSlogLoggerNilFallsBackToDefault(t *testing.T) {
	// Passing nil to WithSlogLogger explicitly resets to the default —
	// covers the nil branch in options.go.
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithSlogLogger(nil, confeature.LogLevelError),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_ = client.Close()
}

func TestWithSlogLoggerWrapsCustomLogger(t *testing.T) {
	custom := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithSlogLogger(custom, confeature.LogLevelDebug),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_ = client.Close()
}

func TestWithLazyLoadAndCacheDirAndBaseURL(t *testing.T) {
	// Smoke test the option setters that aren't exercised elsewhere.
	// :memory: cache dir keeps the test hermetic (no filesystem writes).
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithLazyLoad(60*time.Second),
		confeature.WithCacheDir(":memory:"),
		confeature.WithBaseURL("https://example.invalid"),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestSnapshotIndependentOfClientClose(t *testing.T) {
	// A Snapshot obtained before Close MUST stay usable after Close —
	// spec-036 detached-snapshot semantics.
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
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
	_ = client.Close()
	if got := snap.GetValue("k", false, nil); got != true {
		t.Errorf("post-Close Snapshot.GetValue: got %v; want true", got)
	}
}
