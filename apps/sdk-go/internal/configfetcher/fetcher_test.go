// SPDX-License-Identifier: MIT

package configfetcher_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

const testSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

// noopLogger captures error/warning calls + records the args for the
// SDK-key-leak assertion.
type noopLogger struct {
	entries []logEntry
}

type logEntry struct {
	level string
	msg   string
	args  []any
}

func (l *noopLogger) Error(msg string, args ...any) {
	l.entries = append(l.entries, logEntry{level: "ERROR", msg: msg, args: args})
}

func (l *noopLogger) Warning(msg string, args ...any) {
	l.entries = append(l.entries, logEntry{level: "WARNING", msg: msg, args: args})
}

// assertNoSDKKeyLeak fails the test when any log entry stringification
// contains the SDK key, raw or path-escaped. RedactSdkKey is the only
// path that touches the key for display.
func (l *noopLogger) assertNoSDKKeyLeak(t *testing.T, sdkKey string) {
	t.Helper()
	for _, e := range l.entries {
		if line := e.render(); strings.Contains(line, sdkKey) ||
			strings.Contains(line, url.PathEscape(sdkKey)) {
			t.Errorf("log entry leaked raw SDK key: level=%s msg=%q args=%v",
				e.level, e.msg, e.args)
		}
	}
}

// render is everything a real logger could print for the entry: the
// message, then every argument in every verb a handler might use — and,
// for an error, each error of its whole Unwrap chain (single and joined),
// so an error passed to the logger is checked down to its root cause.
func (e logEntry) render() string {
	var sb strings.Builder
	sb.WriteString(e.msg)
	for _, a := range e.args {
		fmt.Fprintf(&sb, " %v %+v %#v", a, a, a)
		if err, ok := a.(error); ok {
			sb.WriteString(" " + errorChain(err))
		}
	}
	return sb.String()
}

// errorChain renders err and every error it wraps.
func errorChain(err error) string {
	if err == nil {
		return ""
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s | %+v | %#v", err.Error(), err, err)
	switch u := err.(type) {
	case interface{ Unwrap() error }:
		sb.WriteString(" <- " + errorChain(u.Unwrap()))
	case interface{ Unwrap() []error }:
		for _, inner := range u.Unwrap() {
			sb.WriteString(" <- " + errorChain(inner))
		}
	}
	return sb.String()
}

func TestFetch_OK(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("User-Agent"); !strings.HasPrefix(got, "confeature-go-sdk/") {
			t.Errorf("missing/invalid User-Agent: %q", got)
		}
		if got := r.Header.Get("If-None-Match"); got != "" {
			t.Errorf("unexpected If-None-Match on first fetch: %q", got)
		}
		w.Header().Set("ETag", `W/"v1"`)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"p":{"u":"x","r":0,"s":"v1"},"f":{"feat":{"t":0,"v":{"b":true},"i":"v","r":[]}},"s":[]}`))
	}))
	defer server.Close()

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", time.Second, logger)
	r := f.Fetch(context.Background(), "")
	if r.Status != configfetcher.StatusFetched {
		t.Fatalf("Status = %v; want %v (err=%q)", r.Status, configfetcher.StatusFetched, r.Error)
	}
	if r.ETag != `W/"v1"` {
		t.Errorf("ETag = %q; want %q", r.ETag, `W/"v1"`)
	}
	if _, ok := r.Body["f"]; !ok {
		t.Errorf("Body missing `f` key: %v", r.Body)
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_NotModified(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != `W/"v1"` {
			t.Errorf("If-None-Match = %q; want %q", got, `W/"v1"`)
		}
		w.Header().Set("ETag", `W/"v1"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", time.Second, logger)
	r := f.Fetch(context.Background(), `W/"v1"`)
	if r.Status != configfetcher.StatusNotModified {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusNotModified)
	}
	if r.Body != nil {
		t.Errorf("Body must be nil on 304; got %v", r.Body)
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", time.Second, logger)
	r := f.Fetch(context.Background(), "")
	if r.Status != configfetcher.StatusFailed {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusFailed)
	}
	if r.Error == "" {
		t.Errorf("Error must be populated on failure")
	}
	if !strings.Contains(r.Error, "500") {
		t.Errorf("Error should mention HTTP 500; got %q", r.Error)
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_MalformedJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`not-json-at-all`))
	}))
	defer server.Close()

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", time.Second, logger)
	r := f.Fetch(context.Background(), "")
	if r.Status != configfetcher.StatusFailed {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusFailed)
	}
	if r.Error != "MALFORMED_JSON" {
		t.Errorf("Error = %q; want MALFORMED_JSON", r.Error)
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_ContextCanceled(t *testing.T) {
	// Server sleeps indefinitely so we can cancel from the client.
	blocker := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-blocker:
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	defer server.Close()
	defer close(blocker)

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", 5*time.Second, logger)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	r := f.Fetch(ctx, "")
	if r.Status != configfetcher.StatusFailed {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusFailed)
	}
	if r.Error != "context_canceled" {
		t.Errorf("Error = %q; want %q (the documented reason)", r.Error, "context_canceled")
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_CallerDeadline(t *testing.T) {
	blocker := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-blocker:
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	defer server.Close()
	defer close(blocker)

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", 5*time.Second, logger)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	r := f.Fetch(ctx, "")
	if r.Status != configfetcher.StatusFailed {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusFailed)
	}
	if r.Error != "context_deadline_exceeded" {
		t.Errorf("Error = %q; want %q (the documented reason)", r.Error, "context_deadline_exceeded")
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

func TestFetch_Timeout(t *testing.T) {
	blocker := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-blocker:
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	defer server.Close()
	defer close(blocker)

	logger := &noopLogger{}
	f := configfetcher.New(server.URL, testSDKKey, "test", 30*time.Millisecond, logger)
	r := f.Fetch(context.Background(), "")
	if r.Status != configfetcher.StatusFailed {
		t.Fatalf("Status = %v; want %v", r.Status, configfetcher.StatusFailed)
	}
	logger.assertNoSDKKeyLeak(t, testSDKKey)
}

// newShapeSDKKey is a ConfigCat-shaped key (#802), taken from
// sdk-key-shapes.json. It travels RAW: its two `/` stay path separators.
const newShapeSDKKey = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

// keyShape is one entry of packages/test-fixtures-sdk-parity/fixtures/
// sdk-key-shapes.json — the ONE list of well-shaped and malformed keys.
type keyShape struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

func loadKeyShapes(t *testing.T) (valid, invalid []keyShape) {
	t.Helper()
	raw, err := os.ReadFile(testutil.SdkKeyShapesPath())
	if err != nil {
		t.Fatalf("read sdk-key-shapes.json: %v", err)
	}
	var shapes struct {
		Valid   []keyShape `json:"valid"`
		Invalid []keyShape `json:"invalid"`
	}
	if err := json.Unmarshal(raw, &shapes); err != nil {
		t.Fatalf("parse sdk-key-shapes.json: %v", err)
	}
	if len(shapes.Valid) == 0 || len(shapes.Invalid) == 0 {
		t.Fatalf("sdk-key-shapes.json: want valid and invalid keys, got %d / %d",
			len(shapes.Valid), len(shapes.Invalid))
	}
	return shapes.Valid, shapes.Invalid
}

// parsedPath is the path of a URL as sent — still percent-encoded, query
// excluded — so these pins survive the version carrier's query (#807).
func parsedPath(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u.EscapedPath()
}

// TestURL_WellShapedKeyTravelsRaw pins FR-001 (#803) for every well-shaped
// key in the shared list: the key's own bytes, its `/` kept as path
// separators — exactly what configcat-go-sdk sends
// (config_fetcher.go:410, `baseURL+"/configuration-files/"+f.sdkKey+"/"…`).
// No `%2F`, no `/v2/`, no hash of the key.
func TestURL_WellShapedKeyTravelsRaw(t *testing.T) {
	valid, _ := loadKeyShapes(t)
	for _, shape := range valid {
		shape := shape
		t.Run(shape.Name, func(t *testing.T) {
			f := configfetcher.New("https://cdn.example.com/", shape.Key, "test", time.Second, &noopLogger{})
			got, ok := f.URL()
			if !ok {
				t.Fatalf("URL() refused a well-shaped key")
			}
			want := "/configuration-files/" + shape.Key + "/config_v6.json"
			if path := parsedPath(t, got); path != want {
				t.Errorf("path = %q; want %q", path, want)
			}
			if !strings.HasPrefix(got, "https://cdn.example.com/configuration-files/") {
				t.Errorf("URL = %q; want the base URL, then /configuration-files/", got)
			}
		})
	}
}

// TestURL_MalformedKeyIsOneEscapedSegment: a key failing the shape check
// is escaped into ONE segment, so no `/`, `?` or `#` in it can leave it.
func TestURL_MalformedKeyIsOneEscapedSegment(t *testing.T) {
	_, invalid := loadKeyShapes(t)
	extra := []keyShape{{Name: "query and fragment", Key: "bad?key=1#frag/../x"}}
	for _, shape := range append(invalid, extra...) {
		shape := shape
		if shape.Key == "" {
			continue // refused, see TestFetch_RefusesKeysThatCannotBeOneSegment
		}
		t.Run(shape.Name, func(t *testing.T) {
			f := configfetcher.New("https://cdn.example.com", shape.Key, "test", time.Second, &noopLogger{})
			got, ok := f.URL()
			if !ok {
				t.Fatalf("URL() refused %q; only \"\", \".\" and \"..\" are refused", shape.Key)
			}
			want := "/configuration-files/" + url.PathEscape(shape.Key) + "/config_v6.json"
			if path := parsedPath(t, got); path != want {
				t.Errorf("path = %q; want %q", path, want)
			}
			if u, _ := url.Parse(got); u.RawQuery != "" || u.Fragment != "" {
				t.Errorf("URL = %q: the key leaked into the query or fragment", got)
			}
		})
	}
}

// TestFetch_SendsConfigCatShapedKeyRawOnTheWire checks what net/http
// actually sends, not just the string URL() returns: three raw segments,
// a stock ConfigCat SDK's bytes, which the CDN routes at eval.ts:116.
func TestFetch_SendsConfigCatShapedKeyRawOnTheWire(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = wirePath(r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"f":{}}`))
	}))
	defer server.Close()

	f := configfetcher.New(server.URL, newShapeSDKKey, "test", time.Second, &noopLogger{})
	if r := f.Fetch(context.Background(), ""); r.Status != configfetcher.StatusFetched {
		t.Fatalf("Status = %v; want fetched (err=%q)", r.Status, r.Error)
	}
	const want = "/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/config_v6.json"
	if path != want {
		t.Errorf("request path = %q; want %q", path, want)
	}
}

// wirePath is the request target's path EXACTLY as it came over the wire
// (the request line, query excluded) — not r.URL.EscapedPath(), which
// re-derives an encoding and could hide a client that sent other bytes.
func wirePath(r *http.Request) string {
	path, _, _ := strings.Cut(r.RequestURI, "?")
	return path
}

// TestFetch_SendsMalformedKeyAsGoPathEscapeOnTheWire pins FR-001's escape
// for a malformed key to a LITERAL — real `go run` output of
// url.PathEscape, the corpus's request-path-malformed-key — on the bytes
// net/http actually puts in the request line.
func TestFetch_SendsMalformedKeyAsGoPathEscapeOnTheWire(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = wirePath(r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"f":{}}`))
	}))
	defer server.Close()

	f := configfetcher.New(server.URL, "bad key$&+:=@,;!'()*~/x?y#z%..", "test", time.Second, &noopLogger{})
	if r := f.Fetch(context.Background(), ""); r.Status != configfetcher.StatusFetched {
		t.Fatalf("Status = %v; want fetched (err=%q)", r.Status, r.Error)
	}
	const want = "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25../config_v6.json"
	if path != want {
		t.Errorf("request path = %q; want %q", path, want)
	}
}

// TestFetch_InvalidBaseURLIsAFixedCode (common item 3): a base URL
// url.Parse rejects ends as invalid_request; url.Parse's error quotes the
// whole URL, key included, and must reach neither a log nor the result.
func TestFetch_InvalidBaseURLIsAFixedCode(t *testing.T) {
	for _, base := range []string{"http://[::1", "http://cdn.example.com:port", "http://cdn\x7f.example.com\n"} {
		for _, key := range []string{newShapeSDKKey, testSDKKey} {
			base, key := base, key
			t.Run(fmt.Sprintf("%q/%s", base, key[:16]), func(t *testing.T) {
				logger := &noopLogger{}
				f := configfetcher.New(base, key, "test", time.Second, logger)
				r := f.Fetch(context.Background(), "")
				if r.Status != configfetcher.StatusFailed || r.Error != "invalid_request" {
					t.Errorf("result = %+v; want failed with invalid_request", r)
				}
				if len(logger.entries) == 0 {
					t.Errorf("an invalid base URL must be logged")
				}
				assertKeyFree(t, key, r, logger)
			})
		}
	}
}

// TestFetch_RedirectNeverHandsTheKeyToAnotherHost: net/http sets a
// redirected request's Referer to the previous URL, which carries the
// key, so a CDN redirecting to another host would give that host the key.
// Host A redirects twice (to itself, then to host B); B must see no
// Referer and no part of the key in its request line or any header.
func TestFetch_RedirectNeverHandsTheKeyToAnotherHost(t *testing.T) {
	for _, key := range []string{newShapeSDKKey, testSDKKey} {
		key := key
		t.Run(key[:16], func(t *testing.T) {
			var seen *http.Request
			hostB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = r.Clone(context.Background())
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"f":{}}`))
			}))
			defer hostB.Close()
			hostA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("hop") == "" {
					http.Redirect(w, r, r.URL.Path+"?hop=1", http.StatusFound)
					return
				}
				http.Redirect(w, r, hostB.URL+"/moved/config_v6.json", http.StatusFound)
			}))
			defer hostA.Close()

			logger := &noopLogger{}
			f := configfetcher.New(hostA.URL, key, "test", time.Second, logger)
			if r := f.Fetch(context.Background(), `"etag-1"`); r.Status != configfetcher.StatusFetched {
				t.Fatalf("Status = %v; want fetched (err=%q)", r.Status, r.Error)
			}
			if seen == nil {
				t.Fatalf("host B received no request")
			}
			if ref, ok := seen.Header["Referer"]; ok {
				t.Errorf("host B received Referer %q", ref)
			}
			var sb strings.Builder
			sb.WriteString(seen.RequestURI + "\n")
			for name, values := range seen.Header {
				sb.WriteString(name + ": " + strings.Join(values, ", ") + "\n")
			}
			for _, secret := range secretsOf(key) {
				if strings.Contains(sb.String(), secret) {
					t.Errorf("host B's request carries %q:\n%s", secret, sb.String())
				}
			}
		})
	}
}

// TestFetch_RefusesKeysThatCannotBeOneSegment: no escaper keeps "", "."
// or ".." inside its segment (they collapse or climb the path), so the
// fetcher sends NOTHING, logs a redacted INVALID_SDK_KEY and fails.
func TestFetch_RefusesKeysThatCannotBeOneSegment(t *testing.T) {
	for _, key := range []string{"", ".", ".."} {
		key := key
		t.Run(fmt.Sprintf("%q", key), func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()

			logger := &noopLogger{}
			f := configfetcher.New(server.URL, key, "test", time.Second, logger)
			if _, ok := f.URL(); ok {
				t.Errorf("URL() accepted %q", key)
			}
			r := f.Fetch(context.Background(), "")
			if r.Status != configfetcher.StatusFailed || r.Error != "INVALID_SDK_KEY" {
				t.Errorf("result = %+v; want failed with INVALID_SDK_KEY", r)
			}
			if requests != 0 {
				t.Errorf("sent %d requests; want none", requests)
			}
			if len(logger.entries) != 1 || !strings.Contains(logger.entries[0].msg, "INVALID_SDK_KEY") {
				t.Errorf("want one INVALID_SDK_KEY log line; got %+v", logger.entries)
			}
		})
	}
}

// knownReasons is the fixed, key-free vocabulary of FetchResult.Error for
// a transport or body failure (FR-002). A library message is never one.
var knownReasons = map[string]bool{
	"context_canceled":          true,
	"context_deadline_exceeded": true,
	"timeout":                   true,
	"too_many_redirects":        true,
	"body_read_failed":          true,
	"network_error":             true,
}

// secretsOf is everything that identifies key: the key, its escaped form,
// and — for a ConfigCat-shaped key — each 22-character part on its own.
func secretsOf(key string) []string {
	secrets := []string{key, url.PathEscape(key)}
	parts := strings.Split(key, "/")
	if len(parts) == 3 {
		secrets = append(secrets, parts[1], parts[2])
	}
	return secrets
}

// assertKeyFree fails when any secret of key reaches a log line (message
// or any argument, whatever its type) or the result's error.
func assertKeyFree(t *testing.T, key string, r configfetcher.FetchResult, logger *noopLogger) {
	t.Helper()
	for _, secret := range secretsOf(key) {
		if strings.Contains(r.Error, secret) {
			t.Errorf("FetchResult.Error leaks %q: %q", secret, r.Error)
		}
		for _, e := range logger.entries {
			if line := e.render(); strings.Contains(line, secret) {
				t.Errorf("log line leaks %q: %q", secret, line)
			}
		}
	}
}

// TestFetch_ForcedFailuresNeverLeakKey (FR-004): the key now travels in
// the URL, and net/http quotes the URL in every transport error. A
// timeout, a mid-body reset and a redirect loop — each also a closed
// port — must report a fixed reason and log no part of the key.
func TestFetch_ForcedFailuresNeverLeakKey(t *testing.T) {
	failures := map[string]http.HandlerFunc{
		"timeout": func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		},
		"mid-body reset": func(w http.ResponseWriter, _ *http.Request) {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n{\"f\":{"))
			_ = conn.Close()
		},
		"redirect loop": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, r.URL.String(), http.StatusFound)
		},
	}
	for name, handler := range failures {
		for _, key := range []string{newShapeSDKKey, testSDKKey} {
			name, handler, key := name, handler, key
			t.Run(name+"/"+key[:16], func(t *testing.T) {
				server := httptest.NewServer(handler)
				defer server.Close()
				logger := &noopLogger{}
				f := configfetcher.New(server.URL, key, "test", 100*time.Millisecond, logger)
				r := f.Fetch(context.Background(), "")
				if r.Status != configfetcher.StatusFailed {
					t.Fatalf("Status = %v; want failed", r.Status)
				}
				if !knownReasons[r.Error] {
					t.Errorf("Error = %q; want a fixed reason code", r.Error)
				}
				if len(logger.entries) == 0 {
					t.Errorf("a %s must be logged", name)
				}
				assertKeyFree(t, key, r, logger)
			})
		}
	}
}

// TestFetch_TransportErrorNeverLeaksKey: a closed port, the plainest
// transport failure, for both key shapes.
func TestFetch_TransportErrorNeverLeaksKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := server.URL
	server.Close()

	for _, key := range []string{newShapeSDKKey, testSDKKey} {
		key := key
		t.Run(key[:16], func(t *testing.T) {
			logger := &noopLogger{}
			f := configfetcher.New(closedURL, key, "test", time.Second, logger)
			r := f.Fetch(context.Background(), "")
			if r.Status != configfetcher.StatusFailed {
				t.Fatalf("Status = %v; want failed", r.Status)
			}
			if r.Error != "network_error" {
				t.Errorf("Error = %q; want network_error", r.Error)
			}
			if len(logger.entries) == 0 {
				t.Fatalf("a transport failure must be logged")
			}
			assertKeyFree(t, key, r, logger)
		})
	}
}
