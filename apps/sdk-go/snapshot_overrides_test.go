// SPDX-License-Identifier: MIT

package confeature_test

import (
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

const testSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

// TestSnapshotHonorsOverridesSynchronously is the spec-036 correctness
// gate for the Go SDK. Spec 036 fixed snapshot to consult flag
// overrides synchronously; sdk-python inherited the fix; sdk-go
// inherits it from day one.
//
// The test constructs a Client with WithFlagOverrides + WithManualPoll
// (no fetch ever happens) and calls Snapshot().GetValue immediately.
// The override map MUST be consulted synchronously — no goroutine
// wait, no waitFor workaround.
func TestSnapshotHonorsOverridesSynchronously(t *testing.T) {
	overrides := map[string]any{
		"feature.dark-mode":   true,
		"feature.beta-toggle": false,
	}
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	snap := client.Snapshot()
	if got := snap.GetValue("feature.dark-mode", false, nil); got != true {
		t.Errorf("dark-mode: got %v; want true (synchronous override)", got)
	}
	if got := snap.GetValue("feature.beta-toggle", true, nil); got != false {
		t.Errorf("beta-toggle: got %v; want false (synchronous override)", got)
	}
	// Missing key under LocalOnly returns the default (Branch 4).
	if got := snap.GetValue("missing.flag", "fallback", nil); got != "fallback" {
		t.Errorf("missing.flag: got %v; want 'fallback'", got)
	}
}

// TestClientGetValueHonorsOverridesSynchronously is the same gate via
// the non-snapshot GetValue path. Both call sites must consult overrides
// FIRST.
func TestClientGetValueHonorsOverridesSynchronously(t *testing.T) {
	overrides := map[string]any{"k": true}
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
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

// TestSnapshotGetAllKeys validates the union behaviour.
func TestSnapshotGetAllKeys(t *testing.T) {
	overrides := map[string]any{"a": true, "b": false}
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(overrides),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()

	keys := client.Snapshot().GetAllKeys()
	if len(keys) != 2 {
		t.Fatalf("keys = %v; want 2 entries", keys)
	}
	if keys[0] != "a" || keys[1] != "b" {
		t.Errorf("keys not sorted: %v", keys)
	}
}
