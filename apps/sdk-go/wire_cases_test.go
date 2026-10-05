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

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// wireTestSDKKey configures the fetcher for a case that pins no
// given.sdkKey. It is a well-shaped legacy key, so its FR-001 path is the
// key verbatim.
const wireTestSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

// wireCorpus mirrors the JSON Schema of wire-cases.json. A case's `given`
// and `expected` blocks are decoded STRICTLY (decodeStrict): a field this
// consumer does not read fails the suite (#803 FR-003), so the next
// expectation added to the corpus cannot be skipped silently — which is how
// the native suites ignored `requestUrlPrefix` and #803 went unseen.
type wireCorpus struct {
	Cases []wireCase `json:"cases"`
}

type wireCase struct {
	ID          string       `json:"id"`
	Description string       `json:"description"`
	Given       wireGiven    `json:"given"`
	Server      wireServer   `json:"server"`
	Expected    wireExpected `json:"expected"`
}

type wireGiven struct {
	PreviousEtag *string `json:"previousEtag"`
	// BaseURL is the customer-configured CDN base (custom-base-url case);
	// empty means the case runs against the mock server only.
	BaseURL string `json:"baseUrl"`
	// SdkKey, when set, is the key the fetcher MUST be configured with
	// (taken from sdk-key-shapes.json); nil means wireTestSDKKey.
	SdkKey *string `json:"sdkKey"`
}

// decodeStrict decodes data into v, failing on any field v does not declare.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// UnmarshalJSON rejects a `given` field this consumer does not read.
func (g *wireGiven) UnmarshalJSON(data []byte) error {
	type plain wireGiven
	return decodeStrict(data, (*plain)(g))
}

type wireServer struct {
	// Behavior selects how the mock transport acts (#490): "respond"
	// (default, absent) delivers status+headers+body; "timeout" hangs
	// past the client timeout; "close-mid-response" drops the connection
	// mid-body. An unrecognised value FAILS the case loudly (never falls
	// through to respond).
	Behavior string            `json:"behavior"`
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	BodyRef  *string           `json:"bodyRef"`
	Body     *string           `json:"body"`
}

type wireExpected struct {
	RequestHeaderIfNoneMatch wireOptional `json:"requestHeaderIfNoneMatch"`
	Outcome                  string       `json:"outcome"`
	ResultingEtag            *string      `json:"resultingEtag"`
	ErrorClass               string       `json:"errorClass"`
	HasConfig                *bool        `json:"hasConfig"`
	// RequestURLPrefix is what the request URL built from Given.BaseURL
	// must start with.
	RequestURLPrefix string `json:"requestUrlPrefix"`
	// RequestPath is the exact parsed path (query excluded) the request
	// must carry (#803 FR-001) — its single home is the corpus.
	RequestPath string `json:"requestPath"`
}

// UnmarshalJSON rejects an `expected` field this consumer does not read.
func (e *wireExpected) UnmarshalJSON(data []byte) error {
	type plain wireExpected
	return decodeStrict(data, (*plain)(e))
}

// wireOptional captures the three-state semantics the corpus uses for
// expected.requestHeaderIfNoneMatch: absent (don't assert), explicit
// null (header MUST NOT be sent), explicit string (header MUST equal).
type wireOptional struct {
	Present bool
	IsNull  bool
	Value   string
}

func (w *wireOptional) UnmarshalJSON(data []byte) error {
	w.Present = true
	if string(data) == "null" {
		w.IsNull = true
		return nil
	}
	return json.Unmarshal(data, &w.Value)
}

// goErrorToClass maps the fetcher's fixed reason codes (`FetchResult.Error`)
// onto the corpus's normalised error-class vocabulary:
//
//   - "MALFORMED_JSON"                       -> parseFailed (JSON.parse failure or wrong shape)
//   - "HTTP 403" / "HTTP 404"                -> invalidSdkKey (per ConfigCat only 403/404
//     are invalid-SDK-key statuses; 401 is a generic retryable failure)
//   - "INVALID_SDK_KEY"                      -> invalidSdkKey (refused before any request)
//   - "HTTP <other-non-2xx>"                 -> fetchFailed
//   - "context_deadline_exceeded", "timeout" -> timeout
//   - the other transport/body codes         -> fetchFailed
//
// A reason outside that list maps to "unmapped:<reason>", which matches no
// corpus class — so it FAILS, like sdk-python's `python_error_to_class`.
// Folding the unknown into fetchFailed would let any unexpected failure
// pass every fetchFailed case.
func goErrorToClass(reason string) string {
	switch reason {
	case "MALFORMED_JSON":
		return "parseFailed"
	case "HTTP 403", "HTTP 404", "INVALID_SDK_KEY":
		return "invalidSdkKey"
	case "context_deadline_exceeded", "timeout":
		return "timeout"
	case "context_canceled", "too_many_redirects", "body_read_failed", "network_error",
		"invalid_request":
		return "fetchFailed"
	}
	if strings.HasPrefix(reason, "HTTP ") {
		return "fetchFailed"
	}
	return "unmapped:" + reason
}

// silentLogger drops every log entry. The fetcher's existing unit
// suite (apps/sdk-go/internal/configfetcher/fetcher_test.go) already
// asserts the no-SDK-key-leak invariant — this consumer focuses
// purely on wire classification.
type silentLogger struct{}

func (silentLogger) Error(string, ...any)   {}
func (silentLogger) Warning(string, ...any) {}

// resolveBody loads the response body for a case. `bodyRef` points to a
// sibling fixture JSON under packages/test-fixtures-sdk-parity/fixtures;
// `body` is a raw string (used for malformed-payload cases). Either may
// be nil (e.g. 304 has no body).
func resolveBody(t *testing.T, server wireServer) []byte {
	t.Helper()
	if server.BodyRef != nil {
		path := filepath.Join(
			testutil.WorkspaceRoot(),
			"packages", "test-fixtures-sdk-parity", "fixtures",
			*server.BodyRef,
		)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read bodyRef %q: %v", *server.BodyRef, err)
		}
		return raw
	}
	if server.Body != nil {
		return []byte(*server.Body)
	}
	return nil
}

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

func loadWireCorpus(t *testing.T) wireCorpus {
	t.Helper()
	path := filepath.Join(
		testutil.WorkspaceRoot(),
		"packages", "test-fixtures-sdk-parity", "fixtures", "wire-cases.json",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read wire-cases.json %s: %v", path, err)
	}
	var corpus wireCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("unmarshal wire-cases.json: %v", err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatalf("wire-cases.json carries no cases")
	}
	return corpus
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
			sdkKey := wireTestSDKKey
			if c.Given.SdkKey != nil {
				sdkKey = *c.Given.SdkKey
			}
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

			// ---- Request-side assertions --------------------------------
			capturedMu.Lock()
			req := capturedReq
			capturedMu.Unlock()
			if req == nil {
				t.Fatalf("fetcher MUST issue exactly one HTTP request")
			}
			// The path EXACTLY as it came over the wire — the request
			// line's target, query excluded; not req.URL.EscapedPath(),
			// which re-derives an encoding and could mask a client that
			// sent other bytes — compared byte for byte: the corpus's
			// requestPath when the case pins one, else ConfigCat's
			// <base>/configuration-files/<sdkKey>/config_v6.json for the
			// default key — a legacy key, which FR-001 sends verbatim.
			wantPath := c.Expected.RequestPath
			if wantPath == "" {
				wantPath = "/configuration-files/" + sdkKey + "/config_v6.json"
			}
			if got, _, _ := strings.Cut(req.RequestURI, "?"); got != wantPath {
				t.Errorf("URL path = %q; want %q", got, wantPath)
			}
			if strings.Contains(req.URL.String(), "/v2/") {
				t.Errorf("URL %q carries the legacy /v2/ prefix", req.URL)
			}
			// A custom base must lead the request URL (custom-base-url).
			if (c.Given.BaseURL == "") != (c.Expected.RequestURLPrefix == "") {
				t.Fatalf("given.baseUrl and expected.requestUrlPrefix come together")
			}
			if c.Given.BaseURL != "" {
				custom := configfetcher.New(c.Given.BaseURL, sdkKey, "0.0.0-wire-test",
					requestTimeout, silentLogger{})
				defer custom.Close()
				if got, ok := custom.URL(); !ok || !strings.HasPrefix(got, c.Expected.RequestURLPrefix) {
					t.Errorf("URL = %q (ok=%v); want prefix %q", got, ok, c.Expected.RequestURLPrefix)
				}
			}

			// If-None-Match header round-trip
			if c.Expected.RequestHeaderIfNoneMatch.Present {
				got := req.Header.Get("If-None-Match")
				switch {
				case c.Expected.RequestHeaderIfNoneMatch.IsNull:
					if got != "" {
						t.Errorf("If-None-Match should be absent; got %q", got)
					}
				default:
					if got != c.Expected.RequestHeaderIfNoneMatch.Value {
						t.Errorf("If-None-Match = %q; want %q",
							got, c.Expected.RequestHeaderIfNoneMatch.Value)
					}
				}
			}

			// ---- Outcome assertions -------------------------------------
			switch c.Expected.Outcome {
			case "fetched":
				if result.Status != configfetcher.StatusFetched {
					t.Fatalf("Status = %v; want fetched (error=%q)",
						result.Status, result.Error)
				}
				if c.Expected.ResultingEtag != nil && result.ETag != *c.Expected.ResultingEtag {
					t.Errorf("ETag = %q; want %q", result.ETag, *c.Expected.ResultingEtag)
				}
				if result.Body == nil {
					t.Errorf("Body must be populated on fetched outcome")
				}
			case "notModified":
				if result.Status != configfetcher.StatusNotModified {
					t.Fatalf("Status = %v; want not_modified (error=%q)",
						result.Status, result.Error)
				}
				if c.Expected.ResultingEtag != nil && result.ETag != *c.Expected.ResultingEtag {
					t.Errorf("ETag = %q; want %q", result.ETag, *c.Expected.ResultingEtag)
				}
				if result.Body != nil {
					t.Errorf("Body must be nil on not_modified; got %v", result.Body)
				}
			case "failed":
				if result.Status != configfetcher.StatusFailed {
					t.Fatalf("Status = %v; want failed", result.Status)
				}
				mapped := goErrorToClass(result.Error)
				if mapped != c.Expected.ErrorClass {
					t.Errorf("errorClass = %q (mapped from raw=%q); want %q",
						mapped, result.Error, c.Expected.ErrorClass)
				}
			default:
				t.Fatalf("unknown outcome %q in corpus", c.Expected.Outcome)
			}
		})
	}
}
