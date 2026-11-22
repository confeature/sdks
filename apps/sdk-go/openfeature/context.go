// SPDX-License-Identifier: MIT

package confeatureopenfeature

import (
	"context"
	"slices"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	"github.com/confeature/sdks/apps/sdk-go/internal/providercontext"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

const targetingKey = "targetingKey"

type targetingKeyHook struct {
	openfeature.UnimplementedHook
}

// OpenFeature flattens ordinary attributes before inserting its official
// targeting key. Mask the reserved ordinary attribute before flattening so it
// cannot stand in for a missing targeting key.
func (targetingKeyHook) Before(
	_ context.Context, hook openfeature.HookContext, _ openfeature.HookHints,
) (*openfeature.EvaluationContext, error) {
	// The Go client replaces the accumulated hook context with each returned
	// value. Preserve the prior hooks' key and attributes when masking.
	current := hook.EvaluationContext()
	attributes := current.Attributes()
	attributes[targetingKey] = ""
	evaluation := openfeature.NewEvaluationContext(current.TargetingKey(), attributes)
	return &evaluation, nil
}

func evaluationInputs(ctx context.Context, flat openfeature.FlattenedContext) (context.Context, *confeature.User) {
	identifier, _ := flat[targetingKey].(string)
	hasIdentifier := identifier != ""
	ctx = providercontext.WithEvaluation(ctx, hasIdentifier)
	if !hasIdentifier && len(flat) == 0 {
		return ctx, nil
	}

	email, _ := flat["Email"].(string)
	country, _ := flat["Country"].(string)
	user := &confeature.User{Identifier: identifier, Email: email, Country: country}
	for name, attribute := range flat {
		switch name {
		case targetingKey, "Identifier", "Email", "Country":
			continue
		}
		if value, ok := supportedAttribute(attribute); ok {
			if user.Custom == nil {
				user.Custom = make(map[string]any)
			}
			user.Custom[name] = value
		}
	}
	if !hasIdentifier && user.Email == "" && user.Country == "" && len(user.Custom) == 0 {
		return ctx, nil
	}
	return ctx, user
}

func supportedAttribute(value any) (any, bool) {
	switch typed := value.(type) {
	case string, bool, int, int64, float64, time.Time:
		return typed, true
	case []string:
		return slices.Clone(typed), true
	case []any:
		strings := make([]string, len(typed))
		for index, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				return nil, false
			}
			strings[index] = text
		}
		return strings, true
	default:
		return nil, false
	}
}
