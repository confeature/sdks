// SPDX-License-Identifier: MIT

package confeature

import "errors"

// Sentinel errors. Customers test against these via errors.Is(err, Err*).
// Wrapped errors use fmt.Errorf("...: %w", err) so the chain is
// preserved for errors.As. SDK keys are NEVER interpolated raw — every
// wrap site passes the key through internal/sdkkey.RedactSdkKey first.
var (
	// ErrClientClosed is returned by methods called after Close().
	// Close is idempotent: the first call closes; subsequent calls
	// return this sentinel.
	ErrClientClosed = errors.New("confeature: client is closed")

	// ErrOffline is returned by ForceRefresh / ForceRefreshWithContext
	// when the client is in offline mode (SetOffline was called).
	// Spec 101 / #267 — mirrors upstream configcat-go-sdk's OFFLINE_MODE
	// semantic.
	ErrOffline = errors.New("confeature: client is offline")

	// ErrInvalidSDKKey is returned by NewClient when the SDK key is
	// the empty string. Format validation is otherwise lenient
	// (invalid-but-non-empty keys emit a redacted INVALID_SDK_KEY
	// warning and continue).
	ErrInvalidSDKKey = errors.New("confeature: invalid SDK key (empty)")

	// ErrInvalidOption is wrapped by NewClient when one of the
	// functional options carries a non-sensical value (e.g.
	// WithRequestTimeout(-1)).
	ErrInvalidOption = errors.New("confeature: invalid option")

	// ErrOverrideBehaviourNotImplemented is the deferral sentinel for
	// LocalOverRemote and RemoteOverLocal. v1 wires only LocalOnly;
	// the other behaviours are accepted at the type level (for ABI
	// compatibility with configcat-go-sdk) but logged + returned via
	// this sentinel at evaluation time.
	ErrOverrideBehaviourNotImplemented = errors.New(
		"confeature: override behaviour not implemented (only LocalOnly is supported)",
	)

	// ErrCacheDirUnwritable is logged (not returned) the first time
	// the file-cache write fails and the SDK falls back to memory-
	// only mode. Exposed as a sentinel so log filters / tests can
	// pattern-match.
	ErrCacheDirUnwritable = errors.New(
		"confeature: cache dir is unwritable; falling back to memory cache",
	)
)
