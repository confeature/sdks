// SPDX-License-Identifier: MIT

package confeature_test

import (
	"reflect"
	"strings"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	configcat "github.com/configcat/go-sdk/v9"
)

// Spec 071 US3 + spec 075 — API-surface conformance test for sdk-go.
//
// Pins the official ConfigCat Go SDK (github.com/configcat/go-sdk/v9
// v9.1.0) as a test-scope dependency and asserts that the Confeature
// *Client surface is a conforming superset of the configcat *Client
// core evaluation surface — a consumer migrating from configcat needs
// to change the import path + the SDK key only for the conforming
// methods (any rename / removal of a conforming method fails this
// test).
//
// Mechanism: reflection-based method-set comparison. We use
// reflect.TypeOf((*T)(nil)).MethodByName(...) to assert presence /
// absence by name; no client instantiation, no network call.
//
// Spec 075 (issue #265 CLOSED) landed the four typed getters
// (GetBoolValue / GetStringValue / GetIntValue / GetFloatValue) and
// their *ValueDetails siblings, plus eight *WithContext additive
// siblings. The eight typed methods are now in `conformingMethods`;
// the *WithContext extensions are tracked in
// `additiveConfeatureExtensions` with the polarity-flipped
// drift-guard (Confeature MUST have; upstream MUST NOT).
//
// DIVERGENCE-BY-DESIGN — FR-009 (#265): the typed getters accept
// user *User (Confeature's struct-pointer convention), NOT user
// User (upstream's interface{} convention). nil-pointer expresses
// "no targeting context" identically to upstream's nil-interface;
// same observable behaviour on the v1 corpus (no targeting rules).
//
// DIVERGENCE-BY-DESIGN — ADDITIVE (#265 D2 YES): Confeature ships
// *WithContext siblings for every typed getter + typed details
// accessor. Upstream does NOT have them. Constitution v1.2.0 §II
// explicitly permits Confeature's surface to be a strict superset
// of upstream's.
//
// KNOWN DIVERGENCE (#264) — other ConfigCat methods absent on
// *confeature.Client: GetAllValueDetails, GetKeyValueForVariationID,
// GetAllKeys, GetAllValues, SetOffline / SetOnline / IsOffline, Ready,
// RefreshIfOlder, RefreshWithContext. The Snapshot(user User) shape
// diverges by design (Confeature's Snapshot() takes no user — the
// public-surface design is anchored to spec-036 correctness;
// per-call user is the GetValue argument). These are documented as
// DIVERGENCE-BY-DESIGN where applicable.

// ── 1. Sanity guard — the official SDK is on the test classpath ──────

func TestConfigCatSDKIsOnTheTestClasspath(t *testing.T) {
	// Reference a configcat symbol so the import isn't dead code; if
	// the dev dep ever drops out, this file fails to compile.
	var _ *configcat.Client
	// Build a trivial Client value to anchor the package at runtime.
	if reflect.TypeOf((*configcat.Client)(nil)).Kind() != reflect.Ptr {
		t.Fatal("configcat.Client did not resolve to *Client — dev dep wiring drifted")
	}
}

// ── 2. Core conformance — methods present on BOTH SDKs ───────────────

// conformingMethods are reachable on *confeature.Client and form the
// migration-safe surface. The eight typed methods (#265 CLOSED via
// spec 075) carry FR-009's *User divergence — name + arity match
// upstream, the user-arg type is *User instead of User interface{}.
// A rename or removal on Confeature's side fails this test.
var conformingMethods = []string{
	// Confeature additions (upstream has no GetValue / GetValueWithContext).
	"GetValue",
	"GetValueWithContext",

	// Typed getters — spec 075 (#265). Mirror configcat-go-sdk v9
	// signatures 1:1 except FR-009 (*User vs User interface{}).
	"GetBoolValue",          // ConfigCat: GetBoolValue(key, def, user User) bool. Confeature: GetBoolValue(key, def, user *User) bool — *User per FR-009.
	"GetStringValue",        // FR-009.
	"GetIntValue",           // FR-009.
	"GetFloatValue",         // FR-009.
	"GetBoolValueDetails",   // BoolEvaluationDetails return — mirrors upstream 1:1.
	"GetStringValueDetails", // StringEvaluationDetails return — mirrors upstream 1:1.
	"GetIntValueDetails",    // IntEvaluationDetails return — mirrors upstream 1:1.
	"GetFloatValueDetails",  // FloatEvaluationDetails return — mirrors upstream 1:1.

	// Lifecycle / refresh / snapshot.
	"Snapshot",                // Confeature: Snapshot(). ConfigCat: Snapshot(user). Shape differs (see DIVERGENCE-BY-DESIGN below).
	"ForceRefresh",            // Confeature: returns RefreshResult. ConfigCat: Refresh(ctx) returns error.
	"ForceRefreshWithContext", // Confeature: context-aware. ConfigCat: RefreshWithContext.
	"Close",                   // Both.

	// Spec 101 / #267 slice 13/14 — online/offline triplet landed.
	"SetOnline",
	"SetOffline",
	"IsOffline",
}

// additiveConfeatureExtensions are Confeature-only extensions
// (constitution v1.2.0 §II permits a strict superset of upstream).
// The polarity-flipped drift-guard
// TestAdditiveConfeatureExtensionsAbsentOnConfigCat asserts each
// MUST exist on *confeature.Client AND MUST NOT exist on
// *configcat.Client.
//
// Eight *WithContext siblings for the typed surface (D2 YES — spec
// 075). Confeature already ships GetValueWithContext (the untyped
// sibling, pre-existing) as a deliberate addition; the typed
// surface mirrors that ergonomic.
var additiveConfeatureExtensions = []string{
	"GetBoolValueWithContext",
	"GetStringValueWithContext",
	"GetIntValueWithContext",
	"GetFloatValueWithContext",
	"GetBoolValueDetailsWithContext",
	"GetStringValueDetailsWithContext",
	"GetIntValueDetailsWithContext",
	"GetFloatValueDetailsWithContext",
}

// confeatureOnly captures the conforming-on-Confeature method set we
// assert as actually-present on *confeature.Client. We DO NOT assert
// the same names on *configcat.Client — the spelling diverges (Refresh
// vs ForceRefresh, etc.). The cross-surface drift-guard lives in the
// KNOWN DIVERGENCE tables below.
func TestConfeatureClientCarriesCoreSurface(t *testing.T) {
	clientType := reflect.TypeOf((*confeature.Client)(nil))
	for _, name := range conformingMethods {
		if _, ok := clientType.MethodByName(name); !ok {
			t.Errorf("*confeature.Client missing core method %q "+
				"— public-surface regression vs the API contract",
				name)
		}
	}
}

// ── 3. ADDITIVE DIVERGENCE — Confeature *WithContext siblings ────────
//
// Spec 075 D2 YES: Confeature ships eight *WithContext typed siblings
// upstream lacks. The drift-guard below asserts each MUST be present
// on *confeature.Client AND MUST NOT be present on *configcat.Client
// (polarity flipped vs the `knownDivergences264` drift-guard below).
// If upstream EVER ships these, the additive divergence collapses —
// move the name out of additiveConfeatureExtensions and into
// conformingMethods.

func TestAdditiveConfeatureExtensionsAbsentOnConfigCat(t *testing.T) {
	confeatureType := reflect.TypeOf((*confeature.Client)(nil))
	configcatType := reflect.TypeOf((*configcat.Client)(nil))

	if len(additiveConfeatureExtensions) == 0 {
		t.Fatal("additiveConfeatureExtensions is empty — was spec 075 " +
			"D2 (`*WithContext` typed siblings) ever shipped?")
	}

	for _, name := range additiveConfeatureExtensions {
		// Side A: the method MUST exist on *confeature.Client.
		if _, ok := confeatureType.MethodByName(name); !ok {
			t.Errorf("*confeature.Client missing additive extension "+
				"%q — was the spec 075 D2 surface removed? If so, "+
				"remove the name from additiveConfeatureExtensions",
				name)
		}
		// Side B: the method MUST NOT exist on *configcat.Client.
		// If upstream ever ships it, the additive divergence collapses
		// — move the name from additiveConfeatureExtensions to
		// conformingMethods.
		if _, ok := configcatType.MethodByName(name); ok {
			t.Errorf("ConfigCat gained method %q — the additive "+
				"divergence has collapsed; move the name from "+
				"additiveConfeatureExtensions to conformingMethods",
				name)
		}
	}

	t.Logf("ADDITIVE DIVERGENCE: %d Confeature-only *WithContext "+
		"siblings present on *confeature.Client (D2 YES, spec 075).",
		len(additiveConfeatureExtensions))
}

// ── 4. KNOWN DIVERGENCE (#264) — other absent-on-Confeature methods ──

var knownDivergences264 = map[string]string{
	"GetAllValueDetails":        "#264",
	"GetKeyValueForVariationID": "#264",
	"GetAllKeys":                "#264",
	"GetAllValues":              "#264",
	// NOTE: `SetOffline` / `SetOnline` / `IsOffline` moved out under
	// spec 101 / #267 slice 13/14 (all three landed on *confeature.Client).
	"Ready":              "#264 — readiness channel",
	"RefreshIfOlder":     "#264 — conditional refresh",
	"RefreshWithContext": "#264 — ConfigCat alias (Confeature exposes ForceRefreshWithContext)",
	"Refresh":            "DIVERGENCE-BY-DESIGN — Confeature spells this ForceRefresh",
}

func TestKnownDivergences264AreAbsentOnConfeatureClient(t *testing.T) {
	confeatureType := reflect.TypeOf((*confeature.Client)(nil))
	configcatType := reflect.TypeOf((*configcat.Client)(nil))

	for name, note := range knownDivergences264 {
		// Drift-guard side A: the method MUST exist on the ConfigCat
		// reference (or it is a documented ConfigCat-side rename and
		// we drop it from the list).
		if _, ok := configcatType.MethodByName(name); !ok {
			t.Errorf("ConfigCat reference removed method %q (%s) — "+
				"re-evaluate the divergence list", name, note)
		}
		// Drift-guard side B: the method MUST NOT yet exist on
		// *confeature.Client. When the #264 follow-on closes the gap,
		// the entry moves out of this table.
		if _, ok := confeatureType.MethodByName(name); ok {
			// `Refresh` is a special case — DIVERGENCE-BY-DESIGN,
			// not a candidate for gap-closure. Surface a clear hint.
			if name == "Refresh" {
				t.Errorf("*confeature.Client gained method %q — this is "+
					"DIVERGENCE-BY-DESIGN (Confeature spells this "+
					"ForceRefresh). If the rename was intentional, "+
					"update the design", name)
				continue
			}
			t.Errorf("*confeature.Client gained method %q (%s) — "+
				"if the #264 follow-on shipped, remove this entry "+
				"from knownDivergences264", name, note)
		}
	}

	t.Logf("KNOWN DIVERGENCE (#264): %d methods absent on "+
		"*confeature.Client — follow-on scope.",
		len(knownDivergences264))
}

// ── 5. Snapshot shape — DIVERGENCE-BY-DESIGN ─────────────────────────
//
// Confeature: Snapshot() *Snapshot (no user arg).
// ConfigCat:  Snapshot(user User) *Snapshot.
//
// The Confeature design takes the user at GetValue time — the
// Snapshot is the immutable view of the last-fetched config + the
// FlagOverrides bundle. This is documented as DIVERGENCE-BY-DESIGN
// in spec 036 (synchronous override correctness).

func TestSnapshotShapeDiverges(t *testing.T) {
	confeatureMethod, ok := reflect.TypeOf((*confeature.Client)(nil)).MethodByName("Snapshot")
	if !ok {
		t.Fatal("*confeature.Client missing Snapshot — core surface regression")
	}
	configcatMethod, ok := reflect.TypeOf((*configcat.Client)(nil)).MethodByName("Snapshot")
	if !ok {
		t.Fatal("ConfigCat reference removed Snapshot — re-evaluate the parity target")
	}

	// Confeature: receiver only → NumIn() == 1.
	if confeatureMethod.Type.NumIn() != 1 {
		t.Errorf("*confeature.Client.Snapshot expected 1 argument (receiver), got %d",
			confeatureMethod.Type.NumIn())
	}
	// ConfigCat: receiver + user → NumIn() == 2.
	if configcatMethod.Type.NumIn() != 2 {
		t.Errorf("*configcat.Client.Snapshot expected 2 arguments "+
			"(receiver + user), got %d — re-evaluate divergence",
			configcatMethod.Type.NumIn())
	}

	t.Logf("DIVERGENCE-BY-DESIGN: Confeature Snapshot() takes no user " +
		"(spec 036 — synchronous override correctness); ConfigCat " +
		"Snapshot(user User) takes a user.")
}

// ── 6. Constructor / builder shape ───────────────────────────────────
//
// Both SDKs ship a top-level `NewClient`. Confeature accepts
// (sdkKey, ...Option); ConfigCat accepts (sdkKey). ConfigCat also
// ships NewCustomClient(cfg Config). Confeature's variadic-options
// shape is DIVERGENCE-BY-DESIGN — the option helpers (WithManualPoll,
// WithFlagOverrides, etc.) are the Confeature-canonical surface.

func TestNewClientShapeIsCompileTimeAnchored(t *testing.T) {
	// Compile-time anchoring — these symbols must exist or the file
	// fails to compile.
	_ = confeature.NewClient
	_ = configcat.NewClient
	_ = configcat.NewCustomClient

	// Smoke-call only the Confeature side (ConfigCat instantiation
	// starts a background poll loop we'd then have to clean up).
	c, err := confeature.NewClient(
		"confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		confeature.WithManualPoll(),
	)
	if err != nil {
		t.Fatalf("confeature.NewClient: %v", err)
	}
	defer func() { _ = c.Close() }()

	// Sanity: NewClient returns a non-nil pointer whose type name
	// matches the conforming surface.
	if c == nil {
		t.Fatal("NewClient returned nil client")
	}
	if got := reflect.TypeOf(c).String(); !strings.HasSuffix(got, "*confeature.Client") {
		t.Errorf("unexpected client type %q — public-surface drift", got)
	}
}

// ── 7. Snapshot typed surface (FR-011) ───────────────────────────────
//
// Spec 075 FR-011 mandates the four typed getters + four typed
// *ValueDetails accessors also land on *confeature.Snapshot. Upstream's
// *Snapshot does NOT carry typed getters (it has only the untyped
// `GetValue(key) interface{}`), so spec 075's typed surface on
// *Snapshot is an ADDITIVE Confeature divergence — but it MUST exist
// on Confeature's side for the typed migration story to hold.

var conformingSnapshotMethods = []string{
	"GetBoolValue",
	"GetStringValue",
	"GetIntValue",
	"GetFloatValue",
	"GetBoolValueDetails",
	"GetStringValueDetails",
	"GetIntValueDetails",
	"GetFloatValueDetails",
}

func TestConfeatureSnapshotCarriesTypedSurface(t *testing.T) {
	snapshotType := reflect.TypeOf((*confeature.Snapshot)(nil))
	for _, name := range conformingSnapshotMethods {
		if _, ok := snapshotType.MethodByName(name); !ok {
			t.Errorf("*confeature.Snapshot missing typed method %q — "+
				"FR-011 regression (spec 075)", name)
		}
	}
	t.Logf("FR-011 OK: %d typed methods present on *confeature.Snapshot.",
		len(conformingSnapshotMethods))
}

// ── 8. Hooks surface (epic #574 / #575) — CONFORMING ─────────────────
//
// configcat-go-sdk v9 exposes the events surface as `Config.Hooks
// *Hooks`, where Hooks is a three-field struct of single func values:
//
//	type Hooks struct {
//	    OnFlagEvaluated func(details *EvaluationDetails)
//	    OnError         func(err error)
//	    OnConfigChanged func()
//	}
//
// Confeature MUST expose a conforming Hooks type with the same three
// fields, names, and signatures (Principle II). Because Confeature's
// constructor is option-based (no public Config struct), the field is
// attached via WithHooks(*Hooks) — the functional-options analogue of
// upstream's Config.Hooks field; that option's presence is anchored at
// compile time below.
//
// Upstream Go has NO OnClientReady hook (an idiom difference vs the
// JS / Dart SDKs); this test asserts Confeature's Hooks carries EXACTLY
// the upstream field set — no missing field, and no extra field that
// would imply an invented surface.

var conformingHookFields = []string{
	"OnFlagEvaluated",
	"OnError",
	"OnConfigChanged",
}

func TestConfeatureHooksConformsToConfigCatHooks(t *testing.T) {
	// WithHooks is the option-based attachment point — anchored at
	// compile time so a rename / removal fails the build, not just
	// this test.
	_ = confeature.WithHooks

	confeatureHooks := reflect.TypeOf(confeature.Hooks{})
	configcatHooks := reflect.TypeOf(configcat.Hooks{})

	// Side A: every upstream field MUST exist on Confeature's Hooks
	// with a matching signature (presence + arity + in/out types).
	for _, name := range conformingHookFields {
		upField, ok := configcatHooks.FieldByName(name)
		if !ok {
			t.Errorf("ConfigCat reference removed Hooks field %q — "+
				"re-evaluate the parity target", name)
			continue
		}
		cfField, ok := confeatureHooks.FieldByName(name)
		if !ok {
			t.Errorf("confeature.Hooks missing field %q — public-surface "+
				"regression vs configcat.Hooks (Principle II)", name)
			continue
		}
		if cfField.Type.Kind() != reflect.Func || upField.Type.Kind() != reflect.Func {
			t.Errorf("Hooks field %q: expected func on both sides; "+
				"confeature=%s configcat=%s",
				name, cfField.Type.Kind(), upField.Type.Kind())
			continue
		}
		assertHookFuncSignatureMatches(t, name, cfField.Type, upField.Type)
	}

	// Side B: Confeature's Hooks MUST NOT carry an extra field beyond
	// the upstream set (e.g. no invented OnClientReady — Go upstream has
	// none). Catches surface invention in either direction.
	if confeatureHooks.NumField() != len(conformingHookFields) {
		t.Errorf("confeature.Hooks has %d fields; want exactly %d "+
			"(%v) — no invented surface (upstream Go has no OnClientReady)",
			confeatureHooks.NumField(), len(conformingHookFields),
			conformingHookFields)
	}
	if configcatHooks.NumField() != len(conformingHookFields) {
		t.Errorf("configcat.Hooks now has %d fields; the upstream "+
			"surface drifted from the pinned %d — re-evaluate parity",
			configcatHooks.NumField(), len(conformingHookFields))
	}

	t.Logf("CONFORMING (#575): confeature.Hooks mirrors configcat.Hooks "+
		"%v — attached via WithHooks.", conformingHookFields)
}

// assertHookFuncSignatureMatches compares the arity + in/out kinds of a
// hook callback field. The argument-element types diverge by NAME only
// (confeature.EvaluationDetails vs configcat.EvaluationDetails — both
// pointer-to-struct), so we compare structural kind, not the named type
// (which would never match across packages).
func assertHookFuncSignatureMatches(t *testing.T, name string, cf, up reflect.Type) {
	t.Helper()
	if cf.NumIn() != up.NumIn() {
		t.Errorf("Hooks field %q: arity NumIn=%d (confeature) vs %d "+
			"(configcat)", name, cf.NumIn(), up.NumIn())
		return
	}
	if cf.NumOut() != up.NumOut() {
		t.Errorf("Hooks field %q: NumOut=%d (confeature) vs %d "+
			"(configcat)", name, cf.NumOut(), up.NumOut())
		return
	}
	for i := 0; i < cf.NumIn(); i++ {
		if cf.In(i).Kind() != up.In(i).Kind() {
			t.Errorf("Hooks field %q arg %d: kind %s (confeature) vs %s "+
				"(configcat)", name, i, cf.In(i).Kind(), up.In(i).Kind())
		}
	}
}
