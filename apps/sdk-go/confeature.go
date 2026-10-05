// SPDX-License-Identifier: MIT

// Package-level doc comment lives in version.go.
//
// This file exists as the home for any package-level constants that
// don't belong in version.go (currently none — the public surface is
// declared in client.go, snapshot.go, options.go, user.go,
// flag_overrides.go, logger.go, and errors.go).
//
// In a Go package the customer-facing API surface is the union of all
// .go files at the package root. No explicit re-exports are needed —
// that's TypeScript barrel-file thinking. The structure mirrors
// configcat/go-sdk's split (one file per public concept).

package confeature
