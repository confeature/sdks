// SPDX-License-Identifier: MIT

package confeature_test

// Wire-protocol fixture suite (Go consumer).
//
// Drives sdk-go's `internal/configfetcher.Fetcher` against each case in
// `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
// corpus is the language-agnostic contract; this file is the Go consumer
// that maps the fetcher's typed `FetchStatus` + stringly-typed
// `FetchResult.Error` onto the corpus's normalised
// `{fetched, notModified, failed}` x
// `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.
//
// See epic #146 (contract testing framework) + #148 slice 4 (this suite)
// + spec 112.
//
// Layer choice: this drives the fetcher directly (NOT the public Client),
// matching what sdk-node / sdk-browser-js / sdk-bun / sdk-deno / sdk-python
// already do — the wire-cases corpus by name tests wire behaviour, and
// the fetcher is sdk-go's wire layer. Driving the public Client would
// add poll-service indirection that the corpus does not assert.
//
// The expectation rules live in wire_case_assertions_test.go, shared with
// the live suite (wire_cases_live_test.go, #921): this file supplies only
// the hermetic transport.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
)

// wireTestSDKKey configures the fetcher for a case that pins no
// given.sdkKey. It is a well-shaped legacy key, so its FR-001 path is the
// key verbatim.
const wireTestSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

// TestWireCorpus_UnknownFieldFails proves the strict decode fails closed:
// a `given` or `expected` field this consumer does not read is an error,
// never a silently skipped expectation (#803 FR-003).
func TestWireCorpus_UnknownFieldFails(t *testing.T) {
	for _, raw := range []string{
		`{"cases":[{"id":"x","given":{"previousEtag":null,"newKnob":1},"expected":{"outcome":"fetched"}}]}`,
		`{"cases":[{"id":"x","given":{"previousEtag":null},"expected":{"outcome":"fetched","requestQuery":"?a"}}]}`,
	} {
		var corpus wireCorpus
		if err := json.Unmarshal([]byte(raw), &corpus); err == nil {
			t.Errorf("decoding %s succeeded; want an unknown-field error", raw)
		}
	}
	var corpus wireCorpus
	known := `{"cases":[{"id":"x","given":{"previousEtag":null,"sdkKey":"k","baseUrl":"b"},` +
		`"expected":{"outcome":"fetched","requestPath":"/p","requestUrlPrefix":"b"}}]}`
	if err := json.Unmarshal([]byte(known), &corpus); err != nil {
		t.Errorf("decoding known fields failed: %v", err)
	}
}

// TestWireCases is the spec-112 / epic-#146 / issue-#148 wire-protocol
// contract gate for sdk-go. It MUST stay green across ALL corpus cases
// (14 as of #490, incl. the timeout + network-reset behaviour cases) —
// any drift implies a regression of the wire layer that other SDKs
// already classify correctly. Constitution Principle II (NON-NEGOTIABLE):
// fix the SDK, never mutate the corpus.
func TestWireCases(t *testing.T) {
	corpus := loadWireCorpus(t)

	for _, c := range corpus.Cases {
		c := c // capture per-iteration
		t.Run(c.ID, func(t *testing.T) {
			body := resolveBody(t, c.Server)

			behavior := c.Server.Behavior
			if behavior == "" {
				behavior = "respond"
			}

			// Capture the inbound request so we can assert request-side
			// invariants (URL shape, If-None-Match echo). The behaviour
			// adapter (#490) maps server.behavior onto the mock transport.
			// The handler goroutine writes it and the test goroutine reads
			// it; on the timeout case the client returns while the handler
			// still runs, so nothing else orders the two — hence the mutex.
			var (
				capturedMu  sync.Mutex
				capturedReq *http.Request
			)
			server := httptest.NewServer(http.HandlerFunc(
				func(w http.ResponseWriter, r *http.Request) {
					capturedMu.Lock()
					capturedReq = r.Clone(context.Background())
					capturedMu.Unlock()
					switch behavior {
					case "respond":
						for k, v := range c.Server.Headers {
							w.Header().Set(k, v)
						}
						w.WriteHeader(c.Server.Status)
						if body != nil {
							_, _ = w.Write(body)
						}
					case "timeout":
						// Hang until the client's timeout cancels the request:
						// the fetcher's http.Client.Timeout fires → a
						// "Client.Timeout exceeded" error → timeout class.
						<-r.Context().Done()
					case "close-mid-response":
						// Drop the connection mid-body: announce a larger
						// Content-Length than we send, then slam the socket
						// shut. The client's body read returns unexpected EOF
						// → fetchFailed (a transport failure, NOT parseFailed:
						// a truncated body is not a JSON-shape error).
						hj, ok := w.(http.Hijacker)
						if !ok {
							t.Fatalf("ResponseWriter does not support hijacking")
						}
						conn, _, err := hj.Hijack()
						if err != nil {
							t.Fatalf("hijack: %v", err)
						}
						var sb strings.Builder
						sb.WriteString("HTTP/1.1 200 OK\r\n")
						for k, v := range c.Server.Headers {
							sb.WriteString(k + ": " + v + "\r\n")
						}
						// Promise 4096 bytes, send a handful, then close →
						// the client sees a truncated body (unexpected EOF).
						sb.WriteString("Content-Length: 4096\r\n\r\n")
						sb.WriteString(`{"p":{"s":"partial`)
						_, _ = conn.Write([]byte(sb.String()))
						_ = conn.Close()
					default:
						// Unrecognised behaviour — FAIL loudly, never fall
						// through to the respond path (FR-008 guard).
						t.Fatalf("wire-cases: unsupported server.behavior %q — no adapter", behavior)
					}
				},
			))
			defer server.Close()

			// The timeout case needs a short deadline so the suite stays
			// fast; every other behaviour keeps the standard 1s budget.
			requestTimeout := time.Second
			if behavior == "timeout" {
				requestTimeout = 100 * time.Millisecond
			}
			sdkKey := sdkKeyFor(c, wireTestSDKKey)
			fetcher := configfetcher.New(
				server.URL,
				sdkKey,
				"0.0.0-wire-test",
				requestTimeout,
				silentLogger{},
			)
			defer fetcher.Close()

			prevETag := ""
			if c.Given.PreviousEtag != nil {
				prevETag = *c.Given.PreviousEtag
			}
			result := fetcher.Fetch(context.Background(), prevETag)

			capturedMu.Lock()
			req := capturedReq
			capturedMu.Unlock()
			if req == nil {
				t.Fatalf("fetcher MUST issue exactly one HTTP request")
			}
			// The path EXACTLY as it came over the wire — the request line's
			// target, query excluded; not req.URL.EscapedPath(), which
			// re-derives an encoding and could mask a client that sent other
			// bytes.
			path, _, _ := strings.Cut(req.RequestURI, "?")
			sent := sentRequest{Path: path, URL: req.RequestURI}
			if values := req.Header.Values("If-None-Match"); len(values) > 0 {
				sent.IfNoneMatch = &values[0]
			}
			assertWireCase(t, c, sdkKey, sent, result)
		})
	}
}
