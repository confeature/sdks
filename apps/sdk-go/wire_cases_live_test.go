// SPDX-License-Identifier: MIT

package confeature_test

// sdk-go live wire-cases (#921, after sdk-python's #783).
//
// sdk-go's own `internal/configfetcher.Fetcher` — its real net/http stack —
// against a RUNNING live-contract harness serving the reference origin of
// the CDN read path. Every seeded wire-case is replayed and judged by
// assertWireCase, the SAME rules the hermetic suite (wire_cases_test.go)
// applies to an httptest server. Nothing is hand-built here and no admin
// write is made:
//
//   - the case set comes from the running harness (`GET /admin/state` ->
//     `keys`), never recomputed from the corpus and the seeds directory —
//     `http-403` among them, an unseeded key answered by the Worker itself;
//   - the request each case sent is read back from the harness
//     (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
//     asserted on the wire, and each fetch must add exactly one entry;
//   - a timeout case is ended by the SDK's OWN deadline (the fetcher's
//     timeout, a quarter of the harness's hold);
//   - US4: one unseeded key reaches the Worker's own unknown-key answer.
//
// Run it through the harness wrapper, the one agreed boot (the manifest's
// `liveSuite.runner`):
//
//	node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
//	  --exec -- bash -c 'cd apps/sdk-go && go test -count=1 -run "^TestWireCasesLive$" -v .'
//
// GATING (fail closed): skipped only when CONFEATURE_LIVE is unset — the
// hermetic `go test ./...`. When it is set without LIVE_HARNESS_URL, or the
// harness does not answer, the test FAILS; it never skips.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
)

const liveSDKVersion = "0.0.0-live-wire"

// harnessState is the part of `GET /admin/state` this suite reads.
type harnessState struct {
	Keys   []string                   `json:"keys"`
	Faults map[string]json.RawMessage `json:"faults"`
}

// harnessRequest is one entry of the harness's request log.
type harnessRequest struct {
	URL         string  `json:"url"`
	IfNoneMatch *string `json:"ifNoneMatch"`
}

// liveHarness is the running harness the suite reads from.
type liveHarness struct {
	base   string
	client *http.Client
}

// getJSON decodes the harness's answer to GET path?query into v.
func (h liveHarness) getJSON(path string, query url.Values, v any) error {
	target := h.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	resp, err := h.client.Get(target)
	if err != nil {
		return fmt.Errorf("harness %s: %w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("harness %s: read body: %w", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("harness %s answered %d: %s", path, resp.StatusCode, raw)
	}
	return json.Unmarshal(raw, v)
}

// requestsFor returns the requests the harness logged for sdkKey, oldest first.
func (h liveHarness) requestsFor(t *testing.T, sdkKey string) []harnessRequest {
	t.Helper()
	var body struct {
		OK       bool             `json:"ok"`
		Error    string           `json:"error"`
		Requests []harnessRequest `json:"requests"`
	}
	if err := h.getJSON("/admin/requests", url.Values{"sdkKey": {sdkKey}}, &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK {
		t.Fatalf("harness refused /admin/requests: %s", body.Error)
	}
	return body.Requests
}

// holdFor is the harness's hold for a timeout case — the SDK's deadline is
// derived from it (#783 A8) — or 0 for any other behaviour.
func holdFor(t *testing.T, c wireCase, state harnessState) time.Duration {
	t.Helper()
	if c.Server.Behavior != "timeout" {
		return 0
	}
	var fault struct {
		MS int `json:"ms"`
	}
	if raw, ok := state.Faults[c.ID]; ok {
		// A non-object fault leaves MS at 0, which fails just below.
		if err := json.Unmarshal(raw, &fault); err != nil {
			t.Logf("%s: fault %s is not an object: %v", c.ID, raw, err)
		}
	}
	if fault.MS <= 0 {
		t.Fatalf("%s is seeded without a timeout fault", c.ID)
	}
	return time.Duration(fault.MS) * time.Millisecond
}

// TestWireCasesLive replays every seeded wire-case against the harness.
func TestWireCasesLive(t *testing.T) {
	if os.Getenv("CONFEATURE_LIVE") != "1" {
		t.Skip("hermetic run: CONFEATURE_LIVE is not set")
	}
	base := strings.TrimRight(os.Getenv("LIVE_HARNESS_URL"), "/")
	if base == "" {
		t.Fatal("CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " +
			"`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping")
	}
	harness := liveHarness{base: base, client: &http.Client{Timeout: 10 * time.Second}}
	var state harnessState
	if err := harness.getJSON("/admin/state", nil, &state); err != nil {
		t.Fatal(err)
	}
	caseIDs := append([]string(nil), state.Keys...)
	sort.Strings(caseIDs)
	corpus := map[string]wireCase{}
	for _, c := range loadWireCorpus(t).Cases {
		corpus[c.ID] = c
	}

	t.Run("seeded-set", func(t *testing.T) {
		if len(caseIDs) == 0 {
			t.Fatal("the harness reports no seeded case — an empty run checks nothing")
		}
		for _, id := range caseIDs {
			if _, ok := corpus[id]; !ok {
				t.Errorf("seeded key %q is missing from the corpus", id)
			}
		}
	})

	for _, id := range caseIDs {
		c, ok := corpus[id]
		if !ok {
			continue // reported by seeded-set
		}
		t.Run(id, func(t *testing.T) {
			hold := holdFor(t, c, state)
			deadline := 10 * time.Second
			if hold > 0 {
				deadline = hold / 4
			}
			// The harness seeds each case under its id; a case that pins
			// given.sdkKey is configured with that key instead (#803 FR-003).
			sdkKey := sdkKeyFor(c, id)
			loggedBefore := len(harness.requestsFor(t, sdkKey))
			fetcher := configfetcher.New(base, sdkKey, liveSDKVersion, deadline, silentLogger{})
			prevETag := ""
			if c.Given.PreviousEtag != nil {
				prevETag = *c.Given.PreviousEtag
			}
			started := time.Now()
			result := fetcher.Fetch(context.Background(), prevETag)
			elapsed := time.Since(started)
			fetcher.Close()

			log := harness.requestsFor(t, sdkKey)
			// Exactly one request per fetch: a retrying SDK, or a request
			// logged by an earlier run, must not stand in for the one under test.
			if sent := len(log) - loggedBefore; sent != 1 {
				t.Fatalf("one fetch sent %d requests", sent)
			}
			// The SDK's own deadline ended the fetch, not the harness releasing it.
			if hold > 0 && elapsed >= hold {
				t.Errorf("took %v, the harness holds for %v", elapsed, hold)
			}
			last := log[len(log)-1]
			path, _, _ := strings.Cut(last.URL, "?")
			assertWireCase(t, c, sdkKey, sentRequest{Path: path, URL: last.URL, IfNoneMatch: last.IfNoneMatch}, result)
		})
	}

	// US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
	// 403 since #785, classed like a 404 as invalidSdkKey.
	t.Run("unseeded-key", func(t *testing.T) {
		fetcher := configfetcher.New(base, "never-seeded-921", liveSDKVersion, 10*time.Second, silentLogger{})
		defer fetcher.Close()
		result := fetcher.Fetch(context.Background(), "")
		if result.Status != configfetcher.StatusFailed {
			t.Fatalf("Status = %v; want failed", result.Status)
		}
		if class := goErrorToClass(result.Error); class != "invalidSdkKey" {
			t.Errorf("errorClass = %q (raw=%q); want invalidSdkKey", class, result.Error)
		}
	})
}
