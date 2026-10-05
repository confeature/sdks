// SPDX-License-Identifier: MIT

package sdkkey_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/confeature/sdks/apps/sdk-go/internal/sdkkey"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// TestCrossLanguageCacheKey is the cross-language gate for spec 038 US2.
//
// It consumes the same packages/test-fixtures-sdk-parity/fixtures/
// cache-key-fixtures.json that the Python SDK validates against. The
// fixture is the recorded output of TS's deriveCacheKey for 5+
// canonical inputs (ASCII, ConfigCat-style, single-char, empty, emoji).
//
// Failure mode: the test name surfaces the diverging input via the
// redacted key, and the message shows the first 12 characters of the
// expected vs actual cache key so the operator can spot where the
// drift starts.
func TestCrossLanguageCacheKey(t *testing.T) {
	raw, err := os.ReadFile(testutil.CacheKeyFixturesPath())
	if err != nil {
		t.Fatalf("read cache-key-fixtures.json: %v", err)
	}
	var fixtures []struct {
		SDKKey           string `json:"sdkKey"`
		ExpectedCacheKey string `json:"expectedCacheKey"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("parse cache-key-fixtures.json: %v", err)
	}
	if len(fixtures) < 5 {
		t.Fatalf("expected ≥ 5 cache-key fixtures, got %d", len(fixtures))
	}
	for _, fx := range fixtures {
		fx := fx
		// Name the subtest by the redacted key so a failure
		// surfaces the failing case clearly without leaking the
		// raw SDK key.
		t.Run(sdkkey.RedactSdkKey(fx.SDKKey), func(t *testing.T) {
			got := sdkkey.DeriveCacheKey(fx.SDKKey)
			if got != fx.ExpectedCacheKey {
				t.Errorf(
					"cross-language cache-key drift\n"+
						"  input (redacted): %s\n"+
						"  expected: %s\n"+
						"  got:      %s",
					sdkkey.RedactSdkKey(fx.SDKKey),
					fx.ExpectedCacheKey,
					got,
				)
			}
		})
	}
}

// TestRedactSdkKey covers the three documented branches of RedactSdkKey.
func TestRedactSdkKey(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty → full mask",
			in:   "",
			want: "[redacted]",
		},
		{
			name: "short → full mask",
			in:   "short",
			want: "[redacted]",
		},
		{
			name: "exactly 15 chars → full mask (< 16)",
			in:   "abcde-fghij-klm",
			want: "[redacted]",
		},
		{
			// 82-char key → visible = floor(82/10) = 8. Matches the
			// TS reference: Math.max(4, Math.floor(82 * 0.1)) = 8.
			name: "long Confeature key → head/tail masked",
			in:   "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			want: "confeatu…[redacted]…BBBBBBBB",
		},
		{
			// 61-char ConfigCat-shaped key (#802) → visible = 6: the head
			// stays inside `configcat-sdk-1/`, the tail shows 6 secret
			// chars instead of the legacy key's 8. The `/` is plain text.
			name: "ConfigCat-shaped key → head/tail masked",
			in:   "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02",
			want: "config…[redacted]…tRea02",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := sdkkey.RedactSdkKey(tc.in)
			if got != tc.want {
				t.Errorf("RedactSdkKey(%q) = %q; want %q", tc.in, got, tc.want)
			}
			// The raw key (when non-empty + >= 16 chars) MUST NOT
			// be a substring of the redacted output.
			if tc.in != "" && len(tc.in) >= 16 && strings.Contains(got, tc.in) {
				t.Errorf("RedactSdkKey leaked raw key in output: %q", got)
			}
		})
	}
}

// sdkKeyShapes mirrors packages/test-fixtures-sdk-parity/fixtures/
// sdk-key-shapes.json — the ONE accept/reject list every Confeature SDK
// validator is tested from (#802). No per-SDK list: a shape added there
// reaches this suite with no edit here.
type sdkKeyShapes struct {
	Valid   []sdkKeyShape `json:"valid"`
	Invalid []sdkKeyShape `json:"invalid"`
}

type sdkKeyShape struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

func loadSdkKeyShapes(t *testing.T) sdkKeyShapes {
	t.Helper()
	raw, err := os.ReadFile(testutil.SdkKeyShapesPath())
	if err != nil {
		t.Fatalf("read sdk-key-shapes.json: %v", err)
	}
	var shapes sdkKeyShapes
	if err := json.Unmarshal(raw, &shapes); err != nil {
		t.Fatalf("parse sdk-key-shapes.json: %v", err)
	}
	// Fail closed: an empty or renamed list must not pass by checking nothing.
	if len(shapes.Valid) == 0 || len(shapes.Invalid) == 0 {
		t.Fatalf("sdk-key-shapes.json: want valid and invalid cases, got %d / %d",
			len(shapes.Valid), len(shapes.Invalid))
	}
	return shapes
}

// TestIsValidConfeatureKeyFormat runs the lenient validator against the
// shared list: both shapes (ConfigCat's `configcat-sdk-1/<22>/<22>`,
// minted since #802, and the legacy `confeature-sdk-1-<32>-<32>`) are
// accepted, every malformed case is rejected.
func TestIsValidConfeatureKeyFormat(t *testing.T) {
	shapes := loadSdkKeyShapes(t)
	for _, tc := range shapes.Valid {
		tc := tc
		t.Run("accepts "+tc.Name, func(t *testing.T) {
			if !sdkkey.IsValidConfeatureKeyFormat(tc.Key) {
				t.Errorf("IsValidConfeatureKeyFormat(%q) = false; want true", tc.Key)
			}
		})
	}
	for _, tc := range shapes.Invalid {
		tc := tc
		t.Run("rejects "+tc.Name, func(t *testing.T) {
			if sdkkey.IsValidConfeatureKeyFormat(tc.Key) {
				t.Errorf("IsValidConfeatureKeyFormat(%q) = true; want false", tc.Key)
			}
		})
	}
}

// TestRedactSdkKeyNeverShowsMoreSecret pins FR-005 (#802) for every valid
// shape: the head the redactor keeps lies inside the key's non-secret
// prefix, and the tail shows at most 8 secret characters — the legacy
// key's count, which a ConfigCat-shaped key lowers to 6.
func TestRedactSdkKeyNeverShowsMoreSecret(t *testing.T) {
	const prefixMark = "sdk-1" // both shapes' non-secret prefix ends with it + one separator
	for _, tc := range loadSdkKeyShapes(t).Valid {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			got := sdkkey.RedactSdkKey(tc.Key)
			head, tail, ok := strings.Cut(got, "…[redacted]…")
			if !ok {
				t.Fatalf("RedactSdkKey(%q) = %q; want head…[redacted]…tail", tc.Key, got)
			}
			nonSecret := len(tc.Key[:strings.Index(tc.Key, prefixMark)+len(prefixMark)+1])
			if len(head) > nonSecret {
				t.Errorf("head %q reaches past the %d-char non-secret prefix", head, nonSecret)
			}
			if len(tail) > 8 {
				t.Errorf("tail %q shows %d secret chars; want <= 8", tail, len(tail))
			}
		})
	}
}

// TestDeriveCacheKeyShape sanity-checks the format envelope.
func TestDeriveCacheKeyShape(t *testing.T) {
	const key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	got := sdkkey.DeriveCacheKey(key)
	if !strings.HasPrefix(got, "confeature:cache:v1:") {
		t.Errorf("DeriveCacheKey: missing envelope prefix: %q", got)
	}
	suffix := strings.TrimPrefix(got, "confeature:cache:v1:")
	if len(suffix) != 32 {
		t.Errorf("DeriveCacheKey: suffix length = %d; want 32 (chars: %q)", len(suffix), suffix)
	}
}
