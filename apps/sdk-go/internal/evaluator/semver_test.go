// SPDX-License-Identifier: MIT

package evaluator

import "testing"

func TestParseSemVer_Valid(t *testing.T) {
	cases := []string{
		"1.0.0",
		"1.0.0-alpha",
		"v2.3.4",
		"1.0.0+build",
		"  1.2.3  ",
		"1.0.0-alpha.1",
		"1.0.0-0.3.7",
		"1.0.0-x.7.z.92+exp.sha.5114f85",
	}
	for _, c := range cases {
		if parseSemVer(c) == nil {
			t.Errorf("parseSemVer(%q) = nil; want a parsed version", c)
		}
	}
}

func TestParseSemVer_Invalid(t *testing.T) {
	cases := []string{
		"not-a-version",
		"1.0",
		"01.0.0",
		"1.0.0.0",
		"",
		"a.b.c",
	}
	for _, c := range cases {
		if v := parseSemVer(c); v != nil {
			t.Errorf("parseSemVer(%q) = %+v; want nil", c, v)
		}
	}
}

func TestParseSemVer_TooLong(t *testing.T) {
	long := "1.0.0-"
	for i := 0; i < 300; i++ {
		long += "a"
	}
	if parseSemVer(long) != nil {
		t.Errorf("parseSemVer(>256 chars) should be nil")
	}
}

func TestSemVer_Compare(t *testing.T) {
	cmp := func(a, b string) int {
		va, vb := parseSemVer(a), parseSemVer(b)
		if va == nil || vb == nil {
			t.Fatalf("unexpected nil parse for %q / %q", a, b)
		}
		return va.compare(vb)
	}

	cases := []struct {
		a, b string
		want int // sign
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "2.0.0", -1},
		{"2.0.0", "1.0.0", 1},
		{"1.1.0", "1.0.0", 1},
		{"1.0.1", "1.0.0", 1},
		// A version WITHOUT a pre-release ranks HIGHER than one WITH.
		{"1.0.0", "1.0.0-alpha", 1},
		{"1.0.0-alpha", "1.0.0", -1},
		// numeric < alphanumeric.
		{"1.0.0-1", "1.0.0-alpha", -1},
		// numeric vs numeric numerically (not lexically: 2 < 10).
		{"1.0.0-2", "1.0.0-10", -1},
		// alphanumeric ASCII-lexical.
		{"1.0.0-alpha", "1.0.0-beta", -1},
		// more fields rank higher when prefix is equal.
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		// build metadata is ignored.
		{"1.0.0+build1", "1.0.0+build2", 0},
		// leading-v parses the same.
		{"v1.2.3", "1.2.3", 0},
		// spec §11 ordering example.
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0-alpha.beta", "1.0.0-beta", -1},
		{"1.0.0-beta", "1.0.0-beta.2", -1},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1},
		{"1.0.0-beta.11", "1.0.0-rc.1", -1},
		{"1.0.0-rc.1", "1.0.0", -1},
	}
	sign := func(n int) int {
		switch {
		case n < 0:
			return -1
		case n > 0:
			return 1
		default:
			return 0
		}
	}
	for _, c := range cases {
		if got := sign(cmp(c.a, c.b)); got != c.want {
			t.Errorf("compare(%q, %q) sign = %d; want %d", c.a, c.b, got, c.want)
		}
	}
}
