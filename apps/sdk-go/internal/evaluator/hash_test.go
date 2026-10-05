// SPDX-License-Identifier: MIT

package evaluator

import "testing"

// Vectors cross-checked against the TS reference (packages/sdk-shared/src/hash.ts)
// via node:crypto, which produces byte-identical digests to the vendored pure-JS
// implementation (and to Go's crypto/sha1 + crypto/sha256).

func TestSHA1Hex(t *testing.T) {
	got := sha1Hex([]byte("abc"))
	want := "a9993e364706816aba3e25717850c26c9cd0d89d"
	if got != want {
		t.Errorf("sha1Hex(abc) = %q; want %q", got, want)
	}
}

func TestSHA256Hex(t *testing.T) {
	got := sha256Hex([]byte("abc"))
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Errorf("sha256Hex(abc) = %q; want %q", got, want)
	}
}

func TestHashComparisonValue(t *testing.T) {
	// sha256("test" + "salt" + "ctx").
	got := hashComparisonValue("test", "salt", "ctx")
	want := "095fb07c29838662c88aa58ebe3049dbfd17420f534333dd1722204081231f8a"
	if got != want {
		t.Errorf("hashComparisonValue = %q; want %q", got, want)
	}
}

func TestHashComparisonValueSliceMatchesValue(t *testing.T) {
	// For a slice equal to the full ASCII text bytes, the slice hash must equal
	// the value hash (same concatenation order).
	value := "test"
	slice := hashComparisonValueSlice([]byte(value), "salt", "ctx")
	full := hashComparisonValue(value, "salt", "ctx")
	if slice != full {
		t.Errorf("slice hash %q != value hash %q", slice, full)
	}
}

func TestPercentageBucket(t *testing.T) {
	cases := []struct {
		key, attr string
		want      int
	}{
		{"flagKey", "user1", 67},
		{"myKey", "12345", 83},
		{"", "", 62},
	}
	for _, c := range cases {
		if got := percentageBucket(c.key, c.attr); got != c.want {
			t.Errorf("percentageBucket(%q, %q) = %d; want %d", c.key, c.attr, got, c.want)
		}
	}
}

func TestPercentageBucketRange(t *testing.T) {
	// Every bucket must land in [0, 99].
	for _, attr := range []string{"a", "b", "c", "d", "e", "long-identifier-value-123"} {
		b := percentageBucket("key", attr)
		if b < 0 || b > 99 {
			t.Errorf("percentageBucket out of range: %d", b)
		}
	}
}
