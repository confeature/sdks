// SPDX-License-Identifier: MIT

package confeature_test

import (
	"context"
	"errors"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// Spec 101 / #267 — slice 13/14 — sdk-go online/offline triplet.
//
// Mirrors configcat-go-sdk's Client.SetOnline / SetOffline / IsOffline
// methods. Conformance lives in api_surface_conformance_test.go; this
// file exercises behaviour.

func buildManualClient(t *testing.T) *confeature.Client {
	t.Helper()
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func buildLocalOnlyClient(t *testing.T) *confeature.Client {
	t.Helper()
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
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
	return client
}

func TestFreshlyConstructedClientIsOnline(t *testing.T) {
	client := buildManualClient(t)
	defer func() { _ = client.Close() }()
	if client.IsOffline() {
		t.Errorf("default state must be online")
	}
}

func TestSetOfflineFlipsTheFlag(t *testing.T) {
	client := buildManualClient(t)
	defer func() { _ = client.Close() }()
	client.SetOffline()
	if !client.IsOffline() {
		t.Errorf("expected IsOffline=true after SetOffline")
	}
}

func TestSetOnlineResetsTheFlag(t *testing.T) {
	client := buildManualClient(t)
	defer func() { _ = client.Close() }()
	client.SetOffline()
	if !client.IsOffline() {
		t.Fatalf("setup: expected IsOffline=true after SetOffline")
	}
	client.SetOnline()
	if client.IsOffline() {
		t.Errorf("expected IsOffline=false after SetOnline")
	}
}

func TestSettersAreIdempotent(t *testing.T) {
	client := buildManualClient(t)
	defer func() { _ = client.Close() }()
	for i := 0; i < 3; i++ {
		client.SetOffline()
	}
	if !client.IsOffline() {
		t.Errorf("idempotent SetOffline: expected true")
	}
	for i := 0; i < 3; i++ {
		client.SetOnline()
	}
	if client.IsOffline() {
		t.Errorf("idempotent SetOnline: expected false")
	}
}

func TestForceRefreshOfflineReturnsErrOffline(t *testing.T) {
	client := buildManualClient(t)
	defer func() { _ = client.Close() }()
	client.SetOffline()
	r := client.ForceRefreshWithContext(context.Background())
	if r.Success {
		t.Errorf("expected Success=false while offline")
	}
	if !errors.Is(r.Error, confeature.ErrOffline) {
		t.Errorf("expected ErrOffline; got %v", r.Error)
	}
}

func TestLocalOnlyClientIsOfflineByDefinition(t *testing.T) {
	client := buildLocalOnlyClient(t)
	defer func() { _ = client.Close() }()
	if !client.IsOffline() {
		t.Errorf("LocalOnly must report IsOffline=true")
	}
}

func TestLocalOnlySetOnlineIsNoOp(t *testing.T) {
	client := buildLocalOnlyClient(t)
	defer func() { _ = client.Close() }()
	client.SetOnline()
	if !client.IsOffline() {
		t.Errorf("LocalOnly stays IsOffline=true after SetOnline")
	}
}

func TestLocalOnlySetOfflineIsSilentNoOp(t *testing.T) {
	client := buildLocalOnlyClient(t)
	defer func() { _ = client.Close() }()
	client.SetOffline()
	if !client.IsOffline() {
		t.Errorf("expected IsOffline=true")
	}
}

func TestClosedClientReportsOffline(t *testing.T) {
	client := buildManualClient(t)
	_ = client.Close()
	if !client.IsOffline() {
		t.Errorf("closed client must report IsOffline=true")
	}
}

func TestClosedClientSettersAreNoOp(t *testing.T) {
	client := buildManualClient(t)
	_ = client.Close()
	// Should not panic.
	client.SetOnline()
	client.SetOffline()
	if !client.IsOffline() {
		t.Errorf("closed client stays IsOffline=true")
	}
}
