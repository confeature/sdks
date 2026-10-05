// SPDX-License-Identifier: MIT

package confeature_test

import (
	"context"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// TestNewMapOverrideDataSourceCoversAllPrimitiveTypes exercises every
// branch of the unexported `toSettingValue` dispatch table through the
// public NewMapOverrideDataSource entry point. The result map slot
// chosen for each key proves the dispatch landed on the right arm.
func TestNewMapOverrideDataSourceCoversAllPrimitiveTypes(t *testing.T) {
	src := confeature.NewMapOverrideDataSource(map[string]any{
		"k.bool":    true,
		"k.string":  "hello",
		"k.int":     int(7),
		"k.int8":    int8(8),
		"k.int16":   int16(16),
		"k.int32":   int32(32),
		"k.int64":   int64(64),
		"k.uint8":   uint8(8),
		"k.uint16":  uint16(16),
		"k.uint32":  uint32(32),
		"k.float32": float32(1.5),
		"k.float64": float64(2.5),
	})
	m, err := src.GetOverrides(context.Background())
	if err != nil {
		t.Fatalf("GetOverrides: %v", err)
	}

	// Bool slot.
	if got := m["k.bool"]; got.B == nil || *got.B != true {
		t.Errorf("k.bool: slot=%+v", got)
	}
	// String slot.
	if got := m["k.string"]; got.S == nil || *got.S != "hello" {
		t.Errorf("k.string: slot=%+v", got)
	}
	// All int* and uint* widths land in the I slot.
	for _, key := range []string{
		"k.int", "k.int8", "k.int16", "k.int32", "k.int64",
		"k.uint8", "k.uint16", "k.uint32",
	} {
		if got := m[key]; got.I == nil {
			t.Errorf("%s: I slot is nil; slot=%+v", key, got)
		}
	}
	// float32 widens to float64 in the D slot.
	if got := m["k.float32"]; got.D == nil {
		t.Errorf("k.float32: D slot is nil; slot=%+v", got)
	}
	if got := m["k.float64"]; got.D == nil || *got.D != 2.5 {
		t.Errorf("k.float64: slot=%+v", got)
	}
}
