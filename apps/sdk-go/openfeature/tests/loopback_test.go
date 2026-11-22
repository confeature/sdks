// SPDX-License-Identifier: MIT

package consumer_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

const fixtureConfig = `{"f":{
  "enabled":{"t":0,"v":{"b":true},"i":"on"},
  "targeted":{"t":0,"v":{"b":false},"i":"baseline","r":[
    {"c":[{"u":{"a":"Identifier","c":28,"s":"synthetic-beta"}}],"s":{"v":{"b":true},"i":"beta"}}
  ]}
}}`

const refreshedConfig = `{"f":{"enabled":{"t":0,"v":{"b":false},"i":"refreshed"}}}`
const fixturePath = "/configuration-files/" + testSDKKey + "/config_v6.json"
const fixtureDeadline = 3 * time.Second

func TestOfficialClientLoopback(t *testing.T) {
	const child = "CONFEATURE_OPENFEATURE_GO_TEST_CHILD"
	if os.Getenv(child) != "1" {
		// The SDK uses the default HTTP transport. Keep the replacement
		// isolated from other packages and tests in a separate process.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestOfficialClientLoopback$", "-test.v")
		command.Env = append(os.Environ(), child+"=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("loopback subprocess: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	t.Run("manual and concurrent targeting", checkManualPoll)
	t.Run("auto poll", checkAutoPoll)
	t.Run("expired cache offline and reconnect", checkLazyReconnect)
	t.Run("cancelled lazy refresh", checkLazyCancellation)
}

func checkManualPoll(t *testing.T) {
	fixture := loopbackFixture(t, nil)
	evaluations := make(chan *confeature.EvaluationDetails, 16)
	changes := make(chan struct{}, 1)
	native := fixture.client(t, confeature.WithManualPoll(), confeature.WithHooks(&confeature.Hooks{
		OnFlagEvaluated: func(details *confeature.EvaluationDetails) { evaluations <- details },
		OnConfigChanged: func() { changes <- struct{}{} },
	}))
	client := officialClient(t, native)
	got, err := client.BooleanValueDetails(context.Background(), "enabled", false, openfeature.NewTargetlessEvaluationContext(nil))
	if err == nil || got.Value || got.ErrorCode != openfeature.ProviderNotReadyCode {
		t.Fatalf("cold manual evaluation should return its fallback: %+v, %v", got, err)
	}
	fixture.assertRequests(t, 0)
	if result := native.ForceRefresh(); !result.Success {
		t.Fatalf("force refresh: %+v", result)
	}
	waitForSignal(t, changes, "native config change")
	const callers = 8
	checkConcurrentTargeting(t, client, callers)
	for index := 0; index < callers+1; index++ {
		details := waitForSignal(t, evaluations, "native evaluation")
		if details.Data.User != nil {
			t.Error("the native hook received provider evaluation context")
		}
	}
	openfeature.Shutdown()
	if !native.GetBoolValue("enabled", false, nil) {
		t.Fatal("the borrowed native client must survive shutdown")
	}
	fixture.assertRequests(t, 1)
}

func checkConcurrentTargeting(t *testing.T, client *openfeature.Client, callers int) {
	t.Helper()
	var evaluationsDone sync.WaitGroup
	evaluationsDone.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer evaluationsDone.Done()
			identity, expected := "synthetic-other", "baseline"
			if index%2 == 0 {
				identity, expected = "synthetic-beta", "beta"
			}
			eval := openfeature.NewEvaluationContext(identity, nil)
			resolution, err := client.BooleanValueDetails(context.Background(), "targeted", false, eval)
			if err != nil || resolution.Value != (expected == "beta") || resolution.Variant != expected {
				t.Errorf("targeting context %s resolved as %+v, %v", identity, resolution, err)
			}
		}()
	}
	evaluationsDone.Wait()
}

func checkAutoPoll(t *testing.T) {
	fixture := loopbackFixture(t, nil)
	changes := make(chan struct{}, 1)
	native := fixture.client(t, confeature.WithAutoPoll(time.Hour, fixtureDeadline),
		confeature.WithHooks(&confeature.Hooks{OnConfigChanged: func() { changes <- struct{}{} }}))
	client := officialClient(t, native)
	waitForSignal(t, changes, "autopoll config change")
	requireEnabled(t, client, true, "on")
	fixture.assertRequests(t, 1)
}

func checkLazyReconnect(t *testing.T) {
	fixture := loopbackFixture(t, func(w http.ResponseWriter, _ *http.Request, count int32) {
		config := fixtureConfig
		if count > 1 {
			config = refreshedConfig
		}
		_, _ = io.WriteString(w, config)
	})
	native := fixture.client(t, confeature.WithLazyLoad(time.Nanosecond))
	client := officialClient(t, native)
	requireEnabled(t, client, true, "on")
	native.SetOffline()
	requireEnabled(t, client, true, "on")
	fixture.assertRequests(t, 1)
	native.SetOnline()
	requireEnabled(t, client, false, "refreshed")
	fixture.assertRequests(t, 2)
}

func checkLazyCancellation(t *testing.T) {
	requested := make(chan struct{}, 1)
	fixture := loopbackFixture(t, func(_ http.ResponseWriter, request *http.Request, _ int32) {
		requested <- struct{}{}
		<-request.Context().Done()
	})
	client := officialClient(t, fixture.client(t, confeature.WithLazyLoad(time.Hour)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan openfeature.BooleanEvaluationDetails, 1)
	go func() {
		details, _ := client.BooleanValueDetails(ctx, "enabled", true, openfeature.NewTargetlessEvaluationContext(nil))
		result <- details
	}()
	waitForSignal(t, requested, "lazy HTTP request")
	cancel()
	details := waitForSignal(t, result, "cancelled evaluation")
	if !details.Value || details.ErrorCode != openfeature.GeneralCode || details.Variant != "" {
		t.Fatalf("cancelled load did not return its fallback: %+v", details)
	}
	fixture.assertRequests(t, 1)
}

func requireEnabled(t *testing.T, client *openfeature.Client, expected bool, variant string) {
	t.Helper()
	eval := openfeature.NewTargetlessEvaluationContext(nil)
	got, err := client.BooleanValueDetails(context.Background(), "enabled", !expected, eval)
	if err != nil || got.Value != expected || got.Variant != variant {
		t.Fatalf("want %t/%s, got %+v, %v", expected, variant, got, err)
	}
}

type configFixture struct {
	origin   string
	requests atomic.Int32
	blocked  atomic.Int32
}

type fixtureTransport struct {
	fixture *configFixture
	local   *http.Transport
}

func (transport fixtureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet || req.URL.String() != transport.fixture.origin+fixturePath {
		transport.fixture.blocked.Add(1)
		return nil, errors.New("provider fixture rejected a request outside its loopback config URL")
	}
	return transport.local.RoundTrip(req)
}

func loopbackFixture(t *testing.T, respond func(http.ResponseWriter, *http.Request, int32)) *configFixture {
	t.Helper()
	fixture := &configFixture{}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			count := fixture.requests.Add(1)
			w.Header().Set("Content-Type", "application/json")
			if respond != nil {
				respond(w, r, count)
				return
			}
			_, _ = io.WriteString(w, fixtureConfig)
		},
	)}}
	server.Start()
	fixture.origin = server.URL
	dialer := &net.Dialer{Timeout: fixtureDeadline}
	local := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp4", listener.Addr().String())
	}}
	previous := http.DefaultTransport
	http.DefaultTransport = fixtureTransport{fixture: fixture, local: local}
	t.Cleanup(func() {
		http.DefaultTransport = previous
		local.CloseIdleConnections()
		server.Close()
	})
	return fixture
}

func (f *configFixture) client(t *testing.T, options ...confeature.Option) *confeature.Client {
	t.Helper()
	native, err := confeature.NewClient(testSDKKey, append([]confeature.Option{
		confeature.WithBaseURL(f.origin),
		confeature.WithCacheDir(":memory:"),
		confeature.WithRequestTimeout(fixtureDeadline),
	}, options...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = native.Close() })
	return native
}

func (f *configFixture) assertRequests(t *testing.T, expected int32) {
	t.Helper()
	if actual, blocked := f.requests.Load(), f.blocked.Load(); actual != expected || blocked != 0 {
		t.Fatalf("want %d fixture requests and zero blocked requests, got %d and %d", expected, actual, blocked)
	}
}

func waitForSignal[T any](t *testing.T, signal <-chan T, description string) T {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(fixtureDeadline):
		t.Fatalf("timed out waiting for %s", description)
		var zero T
		return zero
	}
}
