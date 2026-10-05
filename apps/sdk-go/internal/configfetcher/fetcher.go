// SPDX-License-Identifier: MIT

// Package configfetcher is the net/http wrapper that pulls
// config_v6.json from a Confeature CDN.
//
// Responsibilities:
//   - User-Agent: "confeature-go-sdk/<Version>" (FR-006).
//   - If-None-Match support for 304 reuse (FR-005).
//   - Configurable request timeout (default 30s, FR-007).
//   - Per-call cancellation via context (research §R3).
//   - SDK key redaction in EVERY log line + error (FR-008): the raw
//     key is NEVER interpolated; sdkkey.RedactSdkKey is the only path.
//     The request URL carries the key (ConfigCat's wire protocol), so a
//     failure is reported as a fixed reason code, never a library message
//     (#803 FR-002).
package configfetcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/sdkkey"
)

// DefaultBaseURL is the production CDN base URL.
const DefaultBaseURL = "https://cdn-global.confeature.io"

// FetchStatus enumerates the three possible outcomes of a fetch call.
type FetchStatus string

const (
	StatusFetched     FetchStatus = "fetched"
	StatusNotModified FetchStatus = "not_modified"
	StatusFailed      FetchStatus = "failed"
)

// FetchResult is the outcome of one Fetch call.
type FetchResult struct {
	Status FetchStatus
	// Body is populated only when Status=="fetched". It is the parsed
	// config_v6.json (a map[string]any consumable by the evaluator).
	Body map[string]any
	// ETag is populated when present in the response (200 or 304).
	ETag string
	// Error is populated when Status=="failed": a fixed, key-free reason
	// code — "HTTP <status>", "MALFORMED_JSON", "INVALID_SDK_KEY",
	// "invalid_request" or one of classifyError's codes. Never a library
	// message.
	Error string
}

// Logger is the minimal logging surface the fetcher needs. The public
// confeature.Logger satisfies this interface; defined locally so
// internal/configfetcher stays free of public-package imports.
type Logger interface {
	Error(msg string, args ...any)
	Warning(msg string, args ...any)
}

// Fetcher wraps an *http.Client with ConfigCat-compatible URL +
// header conventions. One Fetcher per Client; closed via the
// http.Client's idle-conn closer.
type Fetcher struct {
	httpClient *http.Client
	sdkKey     string
	baseURL    string
	userAgent  string
	logger     Logger
}

// New constructs a Fetcher.
//
//   - baseURL: customer-supplied CDN URL. Empty → DefaultBaseURL.
//   - sdkKey: required (non-empty enforced upstream).
//   - version: stamped into the User-Agent.
//   - timeout: per-request timeout. ≤ 0 falls back to 30s.
//   - logger: never nil (use confeature.NewDefaultLogger() upstream).
func New(baseURL, sdkKey, version string, timeout time.Duration, logger Logger) *Fetcher {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Fetcher{
		httpClient: &http.Client{
			Timeout:       timeout,
			CheckRedirect: stopRedirectLoop,
		},
		sdkKey:    sdkKey,
		baseURL:   baseURL,
		userAgent: "confeature-go-sdk/" + version,
		logger:    logger,
	}
}

// maxRedirects matches net/http's default redirect policy.
const maxRedirects = 10

// errTooManyRedirects replaces net/http's default "stopped after 10
// redirects" so a redirect loop classifies by identity, not by wording.
var errTooManyRedirects = errors.New("too many redirects")

// stopRedirectLoop is net/http's default redirect policy with a sentinel
// error classifyError can recognise.
//
// SECURITY: before calling CheckRedirect, net/http sets the redirected
// request's Referer to the previous URL — which carries the SDK key — so a
// redirect to another host would hand that host the key. The header is
// dropped on EVERY redirect; nothing else the SDK sends carries the key.
func stopRedirectLoop(req *http.Request, via []*http.Request) error {
	req.Header.Del("Referer")
	if len(via) >= maxRedirects {
		return errTooManyRedirects
	}
	return nil
}

// URL is the full CDN URL the fetcher targets — ConfigCat's
// `<base>/configuration-files/<sdkKey>/config_v6.json` — and the ONE place
// it is built (#803 FR-001), so the version carrier (#807) lands here only.
//
//   - A well-shaped key (sdkkey.IsValidConfeatureKeyFormat) travels RAW:
//     its `/`-separated parts each path-escaped (a no-op for a valid key),
//     exactly configcat-go-sdk's bytes (config_fetcher.go:410). A
//     ConfigCat-shaped key is three segments, the CDN's eval.ts:116 route.
//   - Any other key is escaped into ONE segment (runtime is lenient), so a
//     `/`, `?` or `#` in it cannot leave its segment (eval.ts:123).
//   - "", "." and ".." cannot be one segment — no escaper keeps them in
//     place — so ok is false and the fetcher must not request anything.
func (f *Fetcher) URL() (string, bool) {
	var keyPath string
	if sdkkey.IsValidConfeatureKeyFormat(f.sdkKey) {
		parts := strings.Split(f.sdkKey, "/")
		for i, part := range parts {
			parts[i] = url.PathEscape(part)
		}
		keyPath = strings.Join(parts, "/")
	} else {
		if f.sdkKey == "" || f.sdkKey == "." || f.sdkKey == ".." {
			return "", false
		}
		keyPath = url.PathEscape(f.sdkKey)
	}
	return f.baseURL + "/configuration-files/" + keyPath + "/config_v6.json", true
}

// Fetch issues a single GET. Never panics; failures land in
// FetchResult.Status=="failed" with a redacted Error message.
//
// ctx controls cancellation + per-call deadline. A cancelled ctx
// returns Status="failed" with Error="context_canceled" (or
// "context_deadline_exceeded").
func (f *Fetcher) Fetch(ctx context.Context, prevETag string) FetchResult {
	configURL, ok := f.URL()
	if !ok {
		f.logger.Error(
			"ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path segment; not fetching",
			"sdkKey", sdkkey.RedactSdkKey(f.sdkKey),
		)
		return FetchResult{Status: StatusFailed, Error: "INVALID_SDK_KEY"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, configURL, nil)
	if err != nil {
		// Only a malformed base URL gets here; url.Parse's message quotes
		// the whole URL, key included, so it is never passed on.
		return f.fail("invalid_request")
	}
	req.Header.Set("User-Agent", f.userAgent)
	req.Header.Set("Accept", "application/json")
	if prevETag != "" {
		req.Header.Set("If-None-Match", prevETag)
	}

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return f.fail(classifyError(err, "network_error"))
	}
	defer func() {
		// Best-effort drain to allow connection re-use.
		_ = resp.Body.Close()
	}()

	switch resp.StatusCode {
	case http.StatusNotModified:
		return FetchResult{
			Status: StatusNotModified,
			ETag:   resp.Header.Get("ETag"),
		}
	case http.StatusOK:
		// Read the body FIRST so a transport/body-read failure (e.g. a
		// connection reset mid-response) classifies as a fetch failure,
		// NOT a parse failure — a truncated body is a network error, not a
		// JSON-shape error. Mirrors the JS shared fetcher's read-then-parse
		// split (response.text() catch → fetchFailed; JSON.parse catch →
		// parseFailed). The wire-cases `network-reset` case (#490) pins this.
		raw, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return f.fail(classifyError(readErr, "body_read_failed"))
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			f.logger.Error(
				"ConfigFetcher: fetch returned non-JSON body",
				"sdkKey", sdkkey.RedactSdkKey(f.sdkKey),
				"reason", "MALFORMED_JSON",
			)
			return FetchResult{Status: StatusFailed, Error: "MALFORMED_JSON"}
		}
		// Shape validation: a valid config_v6.json carries the
		// {p, f, s} top-level shape. sdk-node + sdk-python tightened
		// the same check so the corpus-wide
		// `wire-cases.json::wrong-shape-200` case surfaces the same
		// `parseFailed` everywhere (epic #146 / issue #148). A 200
		// with a body that doesn't match the contract is a stronger
		// signal of CDN drift than a 5xx and deserves its own typed
		// error class. Probing the `f` key alone is sufficient — it
		// is the only mandatory top-level key in the schema.
		if _, ok := body["f"]; !ok {
			f.logger.Error(
				"ConfigFetcher: fetch returned JSON without 'f' key",
				"sdkKey", sdkkey.RedactSdkKey(f.sdkKey),
			)
			return FetchResult{Status: StatusFailed, Error: "MALFORMED_JSON"}
		}
		return FetchResult{
			Status: StatusFetched,
			Body:   body,
			ETag:   resp.Header.Get("ETag"),
		}
	default:
		reason := fmt.Sprintf("HTTP %d", resp.StatusCode)
		f.logger.Error(
			"ConfigFetcher: fetch failed",
			"sdkKey", sdkkey.RedactSdkKey(f.sdkKey),
			"reason", reason,
		)
		return FetchResult{Status: StatusFailed, Error: reason}
	}
}

// Close releases any idle HTTP connections held by the underlying client.
// Best-effort; never errors.
func (f *Fetcher) Close() {
	f.httpClient.CloseIdleConnections()
}

// fail logs a fixed reason code and returns it as a failed FetchResult.
func (f *Fetcher) fail(reason string) FetchResult {
	f.logger.Error(
		"ConfigFetcher: fetch raised",
		"sdkKey", sdkkey.RedactSdkKey(f.sdkKey),
		"reason", reason,
	)
	return FetchResult{Status: StatusFailed, Error: reason}
}

// classifyError reduces a transport or body-read error to a FIXED, key-free
// reason code (#803 FR-002); fallback names the stage that failed.
//
// SECURITY: the request URL carries the SDK key (ConfigCat's wire
// protocol), and net/http quotes URLs in its errors — the request URL in
// every *url.Error, a redirect's Location in its cause. No error text is
// ever passed on: only its identity picks the code.
func classifyError(err error, fallback string) string {
	// net/http wraps a context error in *url.Error, so compare through the
	// chain — `==` never matches what Do actually returns.
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "context_deadline_exceeded"
	case errors.Is(err, errTooManyRedirects):
		return "too_many_redirects"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	return fallback
}
