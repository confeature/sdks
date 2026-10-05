// SPDX-License-Identifier: MIT

package confeature

// Hooks describes the events sent by Client. It mirrors
// configcat-go-sdk v9's Hooks struct 1:1 — same three callback fields,
// same names, same signatures (Principle II / epic #574, issue #575):
//
//	type Hooks struct {
//	    OnFlagEvaluated func(details *EvaluationDetails)
//	    OnError         func(err error)
//	    OnConfigChanged func()
//	}
//
// As in upstream, each field is a single func value (NOT a listener
// list). A nil field is a no-op. Confeature does NOT add an
// OnClientReady hook — the upstream Go SDK has none (an idiom
// difference vs the JS / Dart SDKs), so neither does Confeature.
//
// Attach via WithHooks(&Hooks{...}) at NewClient time — the
// functional-options analogue of upstream's Config.Hooks field.
type Hooks struct {
	// OnFlagEvaluated is called each time the SDK evaluates a feature
	// flag or setting. The details carry the resolved value plus the
	// EvaluationDetailsData metadata block.
	OnFlagEvaluated func(details *EvaluationDetails)

	// OnError is called when an error occurs inside the SDK (e.g. a
	// failed config fetch). The argument is the Go error.
	OnError func(err error)

	// OnConfigChanged is called when a new config.json has been
	// downloaded (the FETCHED path — not a 304 Not Modified).
	OnConfigChanged func()
}

// fireConfigChanged dispatches the OnConfigChanged hook on a fresh
// goroutine, mirroring upstream's `go f.hooks.OnConfigChanged()` in
// config_fetcher.go. Nil-guarded: a nil Hooks or a nil callback is a
// no-op, so no goroutine is spawned (keeping goroutine_leak_test green).
func (h *Hooks) fireConfigChanged() {
	if h == nil || h.OnConfigChanged == nil {
		return
	}
	go safeConfigChanged(h.OnConfigChanged)
}

// fireError dispatches the OnError hook on a fresh goroutine, mirroring
// upstream's `go log.hooks.OnError(...)` in logger.go. Nil-guarded.
func (h *Hooks) fireError(err error) {
	if h == nil || h.OnError == nil {
		return
	}
	go safeError(h.OnError, err)
}

// fireFlagEvaluated dispatches the OnFlagEvaluated hook on a fresh
// goroutine, mirroring upstream's `go snap.hooks.OnFlagEvaluated(...)`
// in snapshot.go. Nil-guarded.
func (h *Hooks) fireFlagEvaluated(details *EvaluationDetails) {
	if h == nil || h.OnFlagEvaluated == nil {
		return
	}
	go safeFlagEvaluated(h.OnFlagEvaluated, details)
}

// safeConfigChanged / safeError / safeFlagEvaluated run a customer
// callback under a recover() so a panicking hook can never crash the
// SDK process or block a sibling emission. Upstream Go fires each hook
// on its own goroutine; an un-recovered panic there would take down the
// whole program. Confeature hardens that boundary — a defensive
// divergence that is observably safer while keeping the exact same
// signatures and dispatch semantics (Principle II additive hardening).
func safeConfigChanged(fn func()) {
	defer func() { _ = recover() }()
	fn()
}

func safeError(fn func(error), err error) {
	defer func() { _ = recover() }()
	fn(err)
}

func safeFlagEvaluated(fn func(*EvaluationDetails), details *EvaluationDetails) {
	defer func() { _ = recover() }()
	fn(details)
}
