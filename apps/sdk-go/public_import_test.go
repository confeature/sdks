// SPDX-License-Identifier: MIT

package confeature_test

import (
	"reflect"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// TestPublicImport is the spec 038 US3 public-import smoke gate. It
// validates that the package compiles, constructs, exposes the
// advertised method set, and shuts down cleanly via the *public* import
// path `github.com/confeature/sdks/apps/sdk-go` (no internal/* leakage).
//
// The test deliberately avoids any network call (WithManualPoll +
// short timeout). It runs in well under 200ms — see the SC-013 budget
// captured in spec.md.
func TestPublicImport(t *testing.T) {
	client, err := confeature.NewClient(
		"confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		confeature.WithManualPoll(),
		confeature.WithRequestTimeout(5*time.Second),
	)
	if err != nil {
		t.Fatalf("NewClient via public import: %v", err)
	}

	// Verify the advertised method set is reachable through the public
	// surface. We use reflection so an accidental rename surfaces here
	// rather than at customer-build time.
	wantMethods := []string{
		"GetValue",
		"GetValueWithContext",
		"GetBoolValue",
		"GetStringValue",
		"GetIntValue",
		"GetFloatValue",
		"GetBoolValueDetails",
		"GetStringValueDetails",
		"GetIntValueDetails",
		"GetFloatValueDetails",
		"GetBoolValueWithContext",
		"GetStringValueWithContext",
		"GetIntValueWithContext",
		"GetFloatValueWithContext",
		"GetBoolValueDetailsWithContext",
		"GetStringValueDetailsWithContext",
		"GetIntValueDetailsWithContext",
		"GetFloatValueDetailsWithContext",
		"Snapshot",
		"ForceRefresh",
		"ForceRefreshWithContext",
		"Close",
	}
	clientType := reflect.TypeOf(client)
	for _, name := range wantMethods {
		if _, ok := clientType.MethodByName(name); !ok {
			t.Errorf("public surface missing method %q on *confeature.Client", name)
		}
	}

	// Smoke-call each (no network — overrides not configured but
	// ManualPoll means no background fetch will ever run).
	_ = client.GetValue("flag", false, nil)
	if snap := client.Snapshot(); snap == nil {
		t.Error("Snapshot returned nil")
	}

	if err := client.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	// Idempotent close: second call returns ErrClientClosed.
	if err := client.Close(); err == nil {
		t.Error("second Close should return ErrClientClosed; got nil")
	}

	// Verify Version is set + non-empty.
	if confeature.Version == "" {
		t.Error("confeature.Version is empty; expected semver string")
	}
}
