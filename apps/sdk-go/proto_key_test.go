// SPDX-License-Identifier: MIT

package confeature_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as
// an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
// settings into a plain object; these tests hold the Go SDK to keeping it
// from the served bytes and from a local override.
const protoServed = `{"p":{"u":"","r":0,"s":"salt"},` +
	`"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}`

func TestProtoKeyServedFlagReturnsItsServedValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(protoServed))
	}))
	defer server.Close()
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithBaseURL(server.URL),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newSilentLogger()),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()
	client.ForceRefresh()
	if got := client.GetValue("__proto__", false, nil); got != true {
		t.Errorf("GetValue(__proto__): got %v; want true (served)", got)
	}
}

func TestProtoKeyLocalOnlyOverrideReturnsTheOverride(t *testing.T) {
	client, err := confeature.NewClient(
		testSDKKey,
		confeature.WithManualPoll(),
		confeature.WithLogger(newSilentLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{"__proto__": true}),
			Behaviour:  confeature.LocalOnly,
		}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer func() { _ = client.Close() }()
	if got := client.GetValue("__proto__", false, nil); got != true {
		t.Errorf("GetValue(__proto__): got %v; want true (override)", got)
	}
}
