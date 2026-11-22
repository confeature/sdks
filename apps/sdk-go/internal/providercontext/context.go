// SPDX-License-Identifier: MIT

// Package providercontext carries the optional provider's evaluation mode
// through the SDK's existing context-aware getters.
package providercontext

import "context"

type key struct{}

// WithEvaluation disables implicit SDK identity for this provider evaluation.
func WithEvaluation(ctx context.Context, hasIdentifier bool) context.Context {
	return context.WithValue(ctx, key{}, hasIdentifier)
}

// Evaluation reports whether the provider supplied the targeting identifier
// and whether this call comes from the provider.
func Evaluation(ctx context.Context) (hasIdentifier, provider bool) {
	if ctx == nil {
		return false, false
	}
	hasIdentifier, provider = ctx.Value(key{}).(bool)
	return hasIdentifier, provider
}
