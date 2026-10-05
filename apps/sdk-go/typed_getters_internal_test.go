// SPDX-License-Identifier: MIT

package confeature

import (
	"errors"
	"testing"
)

// Spec 075 FR-014 — `errorFromCode` covers every evaluator error code,
// including the two branches that cannot be reached through the
// public flag-overrides path (UNSUPPORTED_TYPE / MALFORMED_CONFIG —
// only the wire-config path emits them). The mapping itself is the
// guarantee customers get: any evaluator code → a stable sentinel,
// matchable via errors.Is.

func TestErrorFromCodeCoversEveryEvaluatorBranch(t *testing.T) {
	cases := []struct {
		code     string
		sentinel error
	}{
		{"", nil},
		{"KEY_NOT_FOUND", ErrKeyNotFound},
		{"TYPE_MISMATCH", ErrTypeMismatch},
		{"MALFORMED_VALUE", ErrMalformedValue},
		{"VALUE_NOT_BOOL", ErrValueNotBool},
		{"UNSUPPORTED_TYPE", ErrUnsupportedType},
		{"NO_CONFIG", ErrNoConfig},
		{"MALFORMED_CONFIG", ErrMalformedConfig},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.code, func(t *testing.T) {
			got := errorFromCode(tc.code)
			if tc.sentinel == nil {
				if got != nil {
					t.Errorf("errorFromCode(%q) = %v; want nil", tc.code, got)
				}
				return
			}
			if !errors.Is(got, tc.sentinel) {
				t.Errorf("errorFromCode(%q) = %v; want %v", tc.code, got, tc.sentinel)
			}
		})
	}
}

func TestErrorFromCodeUnknownCodeWraps(t *testing.T) {
	got := errorFromCode("MYSTERY")
	if got == nil {
		t.Fatal("errorFromCode unknown code returned nil; want wrapped error")
	}
	if got.Error() != "confeature: MYSTERY" {
		t.Errorf("errorFromCode unknown code = %q; want %q",
			got.Error(), "confeature: MYSTERY")
	}
}
