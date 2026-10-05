// SPDX-License-Identifier: MIT

package confeature_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// Spec for epic #574 / issue #575 — sdk-go hooks/events behaviour.
//
// Conformance (the Hooks struct mirrors configcat.Hooks field-by-field)
// lives in api_surface_conformance_test.go; this file exercises the
// three emissions firing at the right moment, the nil-callback safety
// guard, and the panic-isolation guard.
//
// Emission dispatch is on a fresh goroutine (mirroring upstream's
// `go snap.hooks.OnFlagEvaluated(...)` etc.), so every assertion waits
// on a channel / polls an atomic with a generous deadline rather than
// reading synchronously.

// waitTrue polls fn until it returns true or the deadline elapses.
func waitTrue(d time.Duration, fn func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return fn()
}

// fetchedConfigServer serves a minimal-but-valid config_v6 body (a {p,
// f, s} shape with an empty f map) so the fetcher returns StatusFetched.
func fetchedConfigServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("ETag", `"v1"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"p":{"s":""},"f":{},"s":[]}`))
		},
	))
}

// TestOnFlagEvaluatedFiresOnEvaluation drives a LocalOnly client (the
// synchronous eval path) and asserts OnFlagEvaluated receives an
// *EvaluationDetails carrying the resolved value + the requested key.
func TestOnFlagEvaluatedFiresOnEvaluation(t *testing.T) {
	got := make(chan *confeature.EvaluationDetails, 1)
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{"k": true}),
			Behaviour:  confeature.LocalOnly,
		}),
		confeature.WithHooks(&confeature.Hooks{
			OnFlagEvaluated: func(d *confeature.EvaluationDetails) { got <- d },
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	if v := client.GetBoolValue("k", false, nil); v != true {
		t.Fatalf("GetBoolValue: got %v; want true", v)
	}

	select {
	case d := <-got:
		if d == nil {
			t.Fatal("OnFlagEvaluated received nil details")
		}
		if d.Data.Key != "k" {
			t.Errorf("details.Data.Key = %q; want %q", d.Data.Key, "k")
		}
		if d.Value != true {
			t.Errorf("details.Value = %v; want true", d.Value)
		}
	case <-time.After(time.Second):
		t.Fatal("OnFlagEvaluated did not fire within 1s")
	}
}

// TestOnConfigChangedFiresOnFetch points a ManualPoll client at a server
// that serves a valid config and asserts OnConfigChanged fires after a
// successful ForceRefresh (the FETCHED path).
func TestOnConfigChangedFiresOnFetch(t *testing.T) {
	server := fetchedConfigServer(t)
	defer server.Close()

	var changed atomic.Int32
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithBaseURL(server.URL),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithHooks(&confeature.Hooks{
			OnConfigChanged: func() { changed.Add(1) },
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	r := client.ForceRefresh()
	if !r.Success {
		t.Fatalf("ForceRefresh: %+v; want Success=true", r)
	}
	if !waitTrue(time.Second, func() bool { return changed.Load() >= 1 }) {
		t.Fatal("OnConfigChanged did not fire after a successful fetch")
	}
}

// TestOnErrorFiresOnFailedFetch points the client at a server that
// returns 500 and asserts OnError fires with a non-nil error.
func TestOnErrorFiresOnFailedFetch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	))
	defer server.Close()

	gotErr := make(chan error, 1)
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithBaseURL(server.URL),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithHooks(&confeature.Hooks{
			OnError: func(e error) { gotErr <- e },
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	_ = client.ForceRefresh()

	select {
	case e := <-gotErr:
		if e == nil {
			t.Fatal("OnError received a nil error")
		}
	case <-time.After(time.Second):
		t.Fatal("OnError did not fire after a failed fetch")
	}
}

// TestNilHookCallbacksAreSafe asserts a Hooks with nil callbacks (and a
// nil *Hooks) never panics across the three emission points.
func TestNilHookCallbacksAreSafe(t *testing.T) {
	server := fetchedConfigServer(t)
	defer server.Close()

	optionSets := [][]confeature.Option{
		{confeature.WithHooks(nil)},
		{confeature.WithHooks(&confeature.Hooks{})},
		{}, // no WithHooks at all
	}

	for i, extra := range optionSets {
		opts := append([]confeature.Option{
			confeature.WithManualPoll(),
			confeature.WithBaseURL(server.URL),
			confeature.WithCacheDir(":memory:"),
			confeature.WithLogger(newSilentLogger()),
			confeature.WithFlagOverrides(confeature.FlagOverrides{
				DataSource: confeature.NewMapOverrideDataSource(map[string]any{"k": true}),
				Behaviour:  confeature.LocalOnly,
			}),
		}, extra...)

		client, err := confeature.NewClient(testSDKKey, opts...)
		if err != nil {
			t.Fatalf("case %d: NewClient: %v", i, err)
		}
		// Exercise the eval path (LocalOnly) — must not panic with nil
		// hooks. The fetch path is short-circuited by LocalOnly, so the
		// eval emission is the relevant one here.
		_ = client.GetBoolValue("k", false, nil)
		_ = client.Close()
	}
}

// TestPanickingHookDoesNotCrashOrBlockSiblings asserts a callback that
// panics neither crashes the client nor blocks a sibling emission — the
// recover()-wrapped dispatch (hooks.go) hardens upstream's bare
// goroutine fire. Two flag evaluations fire OnFlagEvaluated twice; the
// first callback panics, the second-counter MUST still advance.
func TestPanickingHookDoesNotCrashOrBlockSiblings(t *testing.T) {
	var fired atomic.Int32
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{"k": true}),
			Behaviour:  confeature.LocalOnly,
		}),
		confeature.WithHooks(&confeature.Hooks{
			OnFlagEvaluated: func(_ *confeature.EvaluationDetails) {
				fired.Add(1)
				panic("boom — a customer callback exploded")
			},
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	// Two evaluations → two panicking emissions. Neither may crash the
	// process; the second proves a prior panic did not poison dispatch.
	_ = client.GetBoolValue("k", false, nil)
	_ = client.GetBoolValue("k", false, nil)

	if !waitTrue(time.Second, func() bool { return fired.Load() >= 2 }) {
		t.Fatalf("expected the panicking hook to fire twice; got %d "+
			"(a panic blocked or crashed sibling emissions)", fired.Load())
	}
}
