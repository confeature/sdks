// SPDX-License-Identifier: MIT

package overrideeval_test

import (
	"testing"

	"github.com/confeature/sdks/apps/sdk-go/internal/overrideeval"
)

// staticDS is a deterministic Settings impl for the 7-branch tree tests.
type staticDS struct {
	m map[string]overrideeval.SettingValue
}

func (s staticDS) GetOverridesSync() map[string]overrideeval.SettingValue { return s.m }

func boolPtr(b bool) *bool        { return &b }
func strPtr(s string) *string     { return &s }
func intPtr(i int) *int           { return &i }
func floatPtr(f float64) *float64 { return &f }

func TestBranch1_NilOverrides(t *testing.T) {
	v, ok := overrideeval.EvaluateSync(nil, "key", false)
	if ok {
		t.Errorf("nil overrides must return ok=false; got (%v, %v)", v, ok)
	}
}

func TestBranch2_NonLocalOnly(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {B: boolPtr(true)}}},
		Behaviour:  overrideeval.BehaviourLocalOverRemote,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", false)
	if ok {
		t.Errorf("non-LocalOnly must return ok=false; got (%v, %v)", v, ok)
	}

	fo.Behaviour = overrideeval.BehaviourRemoteOverLocal
	v, ok = overrideeval.EvaluateSync(fo, "k", false)
	if ok {
		t.Errorf("RemoteOverLocal must return ok=false; got (%v, %v)", v, ok)
	}
}

func TestBranch3_NilDataSourceMap(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: nil},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", false)
	if ok {
		t.Errorf("nil sync map must return ok=false; got (%v, %v)", v, ok)
	}

	fo.DataSource = nil
	v, ok = overrideeval.EvaluateSync(fo, "k", false)
	if ok {
		t.Errorf("nil DataSource must return ok=false; got (%v, %v)", v, ok)
	}
}

func TestBranch4_KeyAbsent_ReturnsDefault(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"other": {B: boolPtr(true)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "missing", true)
	if !ok {
		t.Fatal("LocalOnly contract requires ok=true on key absent")
	}
	if v != true {
		t.Errorf("expected default true; got %v", v)
	}
}

func TestBranch5_EmptySlot_ReturnsDefault(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", "default")
	if !ok {
		t.Fatal("LocalOnly contract requires ok=true on empty slot")
	}
	if v != "default" {
		t.Errorf("expected default 'default'; got %v", v)
	}
}

func TestBranch6_TypeMismatch_ReturnsDefault(t *testing.T) {
	// override is bool, default is string → mismatch.
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {B: boolPtr(true)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", "default")
	if !ok {
		t.Fatal("LocalOnly contract requires ok=true on TYPE_MISMATCH")
	}
	if v != "default" {
		t.Errorf("expected default 'default'; got %v", v)
	}
}

func TestBranch6_NilDefault_BypassesTypeCheck(t *testing.T) {
	// nil default intentionally bypasses the type check.
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {B: boolPtr(true)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", nil)
	if !ok {
		t.Fatal("LocalOnly contract requires ok=true with nil default")
	}
	if v != true {
		t.Errorf("expected override true; got %v", v)
	}
}

func TestBranch7_HappyPath_Bool(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {B: boolPtr(true)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", false)
	if !ok {
		t.Fatal("happy path requires ok=true")
	}
	if v != true {
		t.Errorf("expected override true; got %v", v)
	}
}

func TestBranch7_HappyPath_String(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {S: strPtr("hi")}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", "default")
	if !ok || v != "hi" {
		t.Errorf("expected ('hi', true); got (%v, %v)", v, ok)
	}
}

func TestBranch7_HappyPath_Int(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {I: intPtr(42)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", 0)
	if !ok || v != 42 {
		t.Errorf("expected (42, true); got (%v, %v)", v, ok)
	}
}

func TestBranch7_HappyPath_Float(t *testing.T) {
	fo := &overrideeval.Overrides{
		DataSource: staticDS{m: map[string]overrideeval.SettingValue{"k": {D: floatPtr(3.14)}}},
		Behaviour:  overrideeval.BehaviourLocalOnly,
	}
	v, ok := overrideeval.EvaluateSync(fo, "k", 0.0)
	if !ok || v != 3.14 {
		t.Errorf("expected (3.14, true); got (%v, %v)", v, ok)
	}
}
