// SPDX-License-Identifier: MIT

package confeature_test

// What a `wire-cases.json` case means for sdk-go — ONE implementation,
// shared by the hermetic suite (wire_cases_test.go, an httptest server)
// AND the live suite (wire_cases_live_test.go, real HTTP against the
// live-contract harness, #921), so both are judged by the same rules.
// The request is passed in SDK-neutral form (sentRequest): the hermetic
// suite reads it from the captured *http.Request, the live suite from the
// harness's `GET /admin/requests`.
//
// Mirrors sdk-python's `_wire_case_assertions.py` (#783, decision row 6)
// and sdk-ruby's `wire_case_assertions.rb` (#920).

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// wireCorpus mirrors the JSON Schema of wire-cases.json. A case's `given`
// and `expected` blocks are decoded STRICTLY (decodeStrict): a field this
// consumer does not read fails the suite (#803 FR-003), so the next
// expectation added to the corpus cannot be skipped silently — which is how
// the native suites ignored `requestUrlPrefix` and #803 went unseen.
type wireCorpus struct {
	Cases []wireCase `json:"cases"`
	// Pending is filled by loadWireCorpus, never decoded.
	Pending []pendingCase `json:"-"`
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
	// (taken from sdk-key-shapes.json); nil means the suite's default key.
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

// sentRequest is the one request a fetch put on the wire, in the form both
// suites can supply.
type sentRequest struct {
	// Path is the request target exactly as sent, query excluded.
	Path string
	// URL is the request target as sent, query included.
	URL string
	// IfNoneMatch is the header's value, or nil when it was not sent.
	IfNoneMatch *string
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
// asserts the no-SDK-key-leak invariant — the wire suites focus
// purely on wire classification.
type silentLogger struct{}

func (silentLogger) Error(string, ...any)   {}
func (silentLogger) Warning(string, ...any) {}

func fixturesDir() string {
	return filepath.Join(testutil.WorkspaceRoot(), "packages", "test-fixtures-sdk-parity", "fixtures")
}

// resolveBody loads the response body for a case. `bodyRef` points to a
// sibling fixture JSON under packages/test-fixtures-sdk-parity/fixtures;
// `body` is a raw string (used for malformed-payload cases). Either may
// be nil (e.g. 304 has no body).
func resolveBody(t *testing.T, server wireServer) []byte {
	t.Helper()
	if server.BodyRef != nil {
		raw, err := os.ReadFile(filepath.Join(fixturesDir(), *server.BodyRef))
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

func loadWireCorpus(t *testing.T) wireCorpus {
	t.Helper()
	path := filepath.Join(fixturesDir(), "wire-cases.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read wire-cases.json %s: %v", path, err)
	}
	// Leniently first, so a case this reader cannot read yet can be told
	// apart from the rest by its id; then every case strictly.
	var lenient struct {
		Cases []json.RawMessage `json:"cases"`
	}
	if err := json.Unmarshal(raw, &lenient); err != nil {
		t.Fatalf("unmarshal wire-cases.json: %v", err)
	}
	pending := loadPendingCases(t)
	var corpus wireCorpus
	for _, rawCase := range lenient.Cases {
		var head struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(rawCase, &head); err != nil {
			t.Fatalf("unmarshal a wire case: %v", err)
		}
		var c wireCase
		decodeErr := json.Unmarshal(rawCase, &c)
		if ticket, ok := pending[head.ID]; ok {
			// The proof that the entry is still true: this reader still
			// cannot read the case. The day it can, the entry must go.
			if decodeErr == nil {
				t.Fatalf("%s is pending for sdk-go (%s) but this reader reads every field of it — "+
					"remove it from wire-cases-pending.json and run it", head.ID, ticket)
			}
			corpus.Pending = append(corpus.Pending, pendingCase{ID: head.ID, Ticket: ticket, Reason: decodeErr.Error()})
			delete(pending, head.ID)
			continue
		}
		if decodeErr != nil {
			t.Fatalf("unmarshal wire case %s: %v", head.ID, decodeErr)
		}
		corpus.Cases = append(corpus.Cases, c)
	}
	for id := range pending {
		t.Fatalf("wire-cases-pending.json lists %s for sdk-go, but the corpus has no such case", id)
	}
	if len(corpus.Cases) == 0 {
		t.Fatalf("wire-cases.json carries no cases")
	}
	return corpus
}

// pendingCase is a corpus case sdk-go cannot read yet (1.4, #994), skipped
// BY NAME through wire-cases-pending.json, never silently.
type pendingCase struct {
	ID, Ticket, Reason string
}

// loadPendingCases is sdk-go's entry of wire-cases-pending.json: case id ->
// ticket. An absent entry is the empty set — the reader runs every case.
func loadPendingCases(t *testing.T) map[string]string {
	t.Helper()
	path := filepath.Join(fixturesDir(), "wire-cases-pending.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read wire-cases-pending.json %s: %v", path, err)
	}
	var manifest struct {
		Pending map[string]struct {
			Ticket string   `json:"ticket"`
			Cases  []string `json:"cases"`
		} `json:"pending"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("unmarshal wire-cases-pending.json: %v", err)
	}
	out := map[string]string{}
	entry := manifest.Pending["sdk-go"]
	for _, id := range entry.Cases {
		out[id] = entry.Ticket
	}
	return out
}

// sdkKeyFor is the key a suite configures its fetcher with: the corpus's
// given.sdkKey when the case pins one, else the suite's own default (the
// live suite's default is the case id, the key the harness seeds).
func sdkKeyFor(c wireCase, defaultKey string) string {
	if c.Given.SdkKey != nil {
		return *c.Given.SdkKey
	}
	return defaultKey
}

// requestPathFor is the exact path a case's request must carry (#803
// FR-001): the corpus's requestPath when the case pins one, else
// ConfigCat's /configuration-files/<sdkKey>/config_v6.json with the key
// verbatim — which is how a suite proves the SDK sent the key it was
// configured with. Both default keys (a legacy-shaped key offline, a case
// id live) are sent verbatim.
func requestPathFor(c wireCase, sdkKey string) string {
	if c.Expected.RequestPath != "" {
		return c.Expected.RequestPath
	}
	return "/configuration-files/" + sdkKey + "/config_v6.json"
}

// assertWireCase judges one fetch of case c — the request it sent and the
// result it returned — by the corpus's expectations.
func assertWireCase(t *testing.T, c wireCase, sdkKey string, sent sentRequest, result configfetcher.FetchResult) {
	t.Helper()
	assertRequest(t, c, sdkKey, sent)
	assertOutcome(t, c, result)
}

// assertRequest checks the request side: the exact path as sent (compared
// byte for byte), no legacy /v2/ prefix, a custom base leading the URL,
// and the If-None-Match round-trip.
func assertRequest(t *testing.T, c wireCase, sdkKey string, sent sentRequest) {
	t.Helper()
	if want := requestPathFor(c, sdkKey); sent.Path != want {
		t.Errorf("URL path = %q; want %q", sent.Path, want)
	}
	if strings.Contains(sent.URL, "/v2/") {
		t.Errorf("URL %q carries the legacy /v2/ prefix", sent.URL)
	}
	// A custom base must lead the request URL (custom-base-url). Checked on
	// the fetcher's URL() — the one function forming the URL Fetch GETs —
	// because the case's host is not routable from a test.
	if (c.Given.BaseURL == "") != (c.Expected.RequestURLPrefix == "") {
		t.Fatalf("given.baseUrl and expected.requestUrlPrefix come together")
	}
	if c.Given.BaseURL != "" {
		custom := configfetcher.New(c.Given.BaseURL, sdkKey, "0.0.0-wire-test", time.Second, silentLogger{})
		defer custom.Close()
		if got, ok := custom.URL(); !ok || !strings.HasPrefix(got, c.Expected.RequestURLPrefix) {
			t.Errorf("URL = %q (ok=%v); want prefix %q", got, ok, c.Expected.RequestURLPrefix)
		}
	}

	want := c.Expected.RequestHeaderIfNoneMatch
	switch {
	case !want.Present:
	case want.IsNull:
		if sent.IfNoneMatch != nil {
			t.Errorf("If-None-Match should be absent; got %q", *sent.IfNoneMatch)
		}
	case sent.IfNoneMatch == nil:
		t.Errorf("If-None-Match absent; want %q", want.Value)
	case *sent.IfNoneMatch != want.Value:
		t.Errorf("If-None-Match = %q; want %q", *sent.IfNoneMatch, want.Value)
	}
}

// assertOutcome maps the fetcher's typed status and reason code onto the
// corpus's {fetched, notModified, failed} x errorClass vocabulary, and
// checks hasConfig: the round-trip did / did not yield a config body.
func assertOutcome(t *testing.T, c wireCase, result configfetcher.FetchResult) {
	t.Helper()
	switch c.Expected.Outcome {
	case "fetched":
		if result.Status != configfetcher.StatusFetched {
			t.Fatalf("Status = %v; want fetched (error=%q)", result.Status, result.Error)
		}
		if c.Expected.ResultingEtag != nil && result.ETag != *c.Expected.ResultingEtag {
			t.Errorf("ETag = %q; want %q", result.ETag, *c.Expected.ResultingEtag)
		}
		if result.Body == nil {
			t.Errorf("Body must be populated on fetched outcome")
		}
	case "notModified":
		if result.Status != configfetcher.StatusNotModified {
			t.Fatalf("Status = %v; want not_modified (error=%q)", result.Status, result.Error)
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
		if mapped := goErrorToClass(result.Error); mapped != c.Expected.ErrorClass {
			t.Errorf("errorClass = %q (mapped from raw=%q); want %q",
				mapped, result.Error, c.Expected.ErrorClass)
		}
	default:
		t.Fatalf("unknown outcome %q in corpus", c.Expected.Outcome)
	}
	if c.Expected.HasConfig != nil && (result.Body != nil) != *c.Expected.HasConfig {
		t.Errorf("hasConfig = %v; want %v", result.Body != nil, *c.Expected.HasConfig)
	}
}
