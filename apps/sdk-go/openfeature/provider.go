// SPDX-License-Identifier: MIT

// Package confeatureopenfeature adapts a Confeature Go SDK client to OpenFeature.
package confeatureopenfeature

import (
	"context"
	"errors"
	"math"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

// Provider evaluates OpenFeature flags with a caller-owned Confeature client.
type Provider struct {
	client *confeature.Client
}

var _ openfeature.FeatureProvider = (*Provider)(nil)

// NewProvider uses the supplied client's polling and cache. The caller owns
// the client lifecycle and closes it when the application is finished with it.
func NewProvider(client *confeature.Client) (*Provider, error) {
	if client == nil {
		return nil, errors.New("a Confeature client is required")
	}
	return &Provider{client: client}, nil
}

// Metadata identifies this provider.
func (*Provider) Metadata() openfeature.Metadata { return openfeature.Metadata{Name: "Confeature"} }

// Hooks protect the official targeting key while merging the evaluation context.
func (*Provider) Hooks() []openfeature.Hook { return []openfeature.Hook{targetingKeyHook{}} }

// BooleanEvaluation resolves a Config V2 Boolean flag.
func (p *Provider) BooleanEvaluation(ctx context.Context, flag string, fallback bool, flat openfeature.FlattenedContext) openfeature.BoolResolutionDetail {
	ctx, user := evaluationInputs(ctx, flat)
	outcome := p.client.GetBoolValueDetailsWithContext(ctx, flag, fallback, user)
	value, detail := adapt(fallback, outcome.Value, outcome.Data)
	return openfeature.BoolResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// StringEvaluation resolves a Config V2 string, including JSON stored as a string.
func (p *Provider) StringEvaluation(ctx context.Context, flag string, fallback string, flat openfeature.FlattenedContext) openfeature.StringResolutionDetail {
	ctx, user := evaluationInputs(ctx, flat)
	outcome := p.client.GetStringValueDetailsWithContext(ctx, flag, fallback, user)
	value, detail := adapt(fallback, outcome.Value, outcome.Data)
	return openfeature.StringResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// IntEvaluation resolves a Config V2 integer and preserves an int64 fallback
// even on platforms where the base SDK's int is narrower.
func (p *Provider) IntEvaluation(ctx context.Context, flag string, fallback int64, flat openfeature.FlattenedContext) openfeature.IntResolutionDetail {
	ctx, user := evaluationInputs(ctx, flat)
	nativeFallback := int(fallback)
	if int64(nativeFallback) != fallback {
		// Any native int identifies the correct flag type. An SDK failure
		// is mapped back to the original caller fallback below.
		nativeFallback = 0
	}
	outcome := p.client.GetIntValueDetailsWithContext(ctx, flag, nativeFallback, user)
	value, detail := adapt(fallback, int64(outcome.Value), outcome.Data)
	return openfeature.IntResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// FloatEvaluation resolves a finite Config V2 decimal.
func (p *Provider) FloatEvaluation(ctx context.Context, flag string, fallback float64, flat openfeature.FlattenedContext) openfeature.FloatResolutionDetail {
	ctx, user := evaluationInputs(ctx, flat)
	outcome := p.client.GetFloatValueDetailsWithContext(ctx, flag, fallback, user)
	if !outcome.Data.IsDefaultValue && outcome.Data.Error == nil && (math.IsNaN(outcome.Value) || math.IsInf(outcome.Value, 0)) {
		outcome.Data.Error = confeature.ErrMalformedValue
	}
	value, detail := adapt(fallback, outcome.Value, outcome.Data)
	return openfeature.FloatResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// ObjectEvaluation returns the caller fallback since Config V2 has no structured flag values.
func (*Provider) ObjectEvaluation(_ context.Context, _ string, fallback any, _ openfeature.FlattenedContext) openfeature.InterfaceResolutionDetail {
	return openfeature.InterfaceResolutionDetail{
		Value:                    fallback,
		ProviderResolutionDetail: failure(confeature.ErrTypeMismatch),
	}
}
