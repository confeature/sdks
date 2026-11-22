// SPDX-License-Identifier: MIT

package confeatureopenfeature

import (
	"context"
	"errors"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

func adapt[T any](fallback, value T, data confeature.EvaluationDetailsData) (T, openfeature.ProviderResolutionDetail) {
	if data.IsDefaultValue || data.Error != nil {
		return fallback, failure(data.Error)
	}
	reason := openfeature.UnknownReason
	switch {
	case data.MatchedPercentageOption != nil:
		reason = openfeature.SplitReason
	case data.MatchedTargetingRule != nil:
		reason = openfeature.TargetingMatchReason
	}
	return value, openfeature.ProviderResolutionDetail{Reason: reason, Variant: data.VariationID}
}

func failure(err error) openfeature.ProviderResolutionDetail {
	var detail openfeature.ResolutionError
	switch {
	case errors.Is(err, confeature.ErrClientClosed), errors.Is(err, confeature.ErrNoConfig):
		detail = openfeature.NewProviderNotReadyResolutionError("The Confeature provider is not ready.")
	case errors.Is(err, confeature.ErrKeyNotFound):
		detail = openfeature.NewFlagNotFoundResolutionError("The Confeature flag was not found.")
	case errors.Is(err, confeature.ErrUnsupportedType), errors.Is(err, confeature.ErrTypeMismatch):
		detail = openfeature.NewTypeMismatchResolutionError("The Confeature flag type does not match.")
	case errors.Is(err, confeature.ErrMalformedValue), errors.Is(err, confeature.ErrMalformedConfig), errors.Is(err, confeature.ErrValueNotBool):
		detail = openfeature.NewParseErrorResolutionError("The Confeature configuration could not be evaluated.")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		detail = openfeature.NewGeneralResolutionError("The Confeature evaluation was cancelled.")
	default:
		detail = openfeature.NewGeneralResolutionError("The Confeature evaluation failed.")
	}
	return openfeature.ProviderResolutionDetail{Reason: openfeature.ErrorReason, ResolutionError: detail}
}
