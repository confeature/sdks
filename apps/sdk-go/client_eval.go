// SPDX-License-Identifier: MIT

package confeature

import (
	"context"

	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
	"github.com/confeature/sdks/apps/sdk-go/internal/overrideeval"
	"github.com/confeature/sdks/apps/sdk-go/internal/providercontext"
	"github.com/confeature/sdks/apps/sdk-go/internal/sdkkey"
)

type evaluationUser struct {
	user          *User
	provider      bool
	hasIdentifier bool
}

func (u evaluationUser) evaluatorUser() *evaluator.User {
	user := toEvalUser(u.user)
	if user != nil && u.provider {
		user.MissingIdentifier = !u.hasIdentifier
	}
	return user
}

func (c *Client) evaluateWithContext(
	ctx context.Context, key string, fallback any, user *User,
) (value any, info evalInfo) {
	hasIdentifier, provider := providercontext.Evaluation(ctx)
	if provider {
		if err := ctx.Err(); err != nil {
			return fallback, cancelledProviderEvaluation(err)
		}
	}
	if c.closed.Load() {
		if !provider {
			c.logger.Warning("GetValue called after Close", "sdkKey", sdkkey.RedactSdkKey(c.sdkKey), "key", key)
		}
		return fallback, evalInfo{IsDefault: true, ClientClosed: true, OmitUser: provider}
	}
	if !provider {
		defer func() { c.fireEvaluationHook(key, user, value, info) }()
		user = c.resolveUser(user)
		return c.resolveEvaluation(ctx, key, fallback, evaluationUser{user: user})
	}

	value, info = c.resolveEvaluation(ctx, key, fallback, evaluationUser{user, true, hasIdentifier})
	if err := ctx.Err(); err != nil {
		return fallback, cancelledProviderEvaluation(err)
	}
	info.OmitUser = true
	c.fireEvaluationHook(key, user, value, info)
	return value, info
}

func (c *Client) fireEvaluationHook(key string, user *User, value any, info evalInfo) {
	if c.hooks != nil && c.hooks.OnFlagEvaluated != nil {
		c.hooks.fireFlagEvaluated(&EvaluationDetails{
			Value: value,
			Data:  c.buildDetailsData(key, user, info),
		})
	}
}

func cancelledProviderEvaluation(err error) evalInfo {
	return evalInfo{ContextError: err, IsDefault: true, OmitUser: true}
}

func (c *Client) resolveEvaluation(
	ctx context.Context, key string, fallback any, user evaluationUser,
) (any, evalInfo) {
	if c.flagOverrides != nil {
		if value, info, handled := c.resolveOverride(key, fallback, user); handled {
			return value, info
		}
		if c.flagOverrides.Behaviour != LocalOnly {
			c.logger.Warning(
				"override behaviour not implemented",
				"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
				"behaviour", c.flagOverrides.Behaviour.String(),
				"err", ErrOverrideBehaviourNotImplemented.Error(),
			)
		}
	}

	c.poll.MaybeFetchForGetValue(ctx)
	if user.provider {
		if err := ctx.Err(); err != nil {
			return fallback, cancelledProviderEvaluation(err)
		}
	}
	var configMap map[string]any
	if current := c.config.Load(); current != nil {
		configMap = *current
	}
	return evaluationOutcome(evaluator.EvaluateForUser(configMap, key, fallback, user.evaluatorUser()))
}

func (c *Client) resolveOverride(key string, fallback any, user evaluationUser) (any, evalInfo, bool) {
	if source, full := fullConfigSource(c.flagOverrides); full {
		value, info := evaluationOutcome(
			evaluator.EvaluateForUser(source.Config(), key, fallback, user.evaluatorUser()),
		)
		return value, info, true
	}

	overrides := c.overrideInternal()
	if user.provider {
		value, handled, code := overrideeval.EvaluateSyncDetails(overrides, key, fallback)
		return value, evalInfo{ErrorCode: code, IsDefault: code != ""}, handled
	}

	value, handled := overrideeval.EvaluateSync(overrides, key, fallback)
	if !handled {
		return nil, evalInfo{}, false
	}
	code := classifyOverrideOutcome(c.overrideInternal(), key, fallback, value)
	return value, evalInfo{ErrorCode: code, IsDefault: code != ""}, true
}

func evaluationOutcome(result evaluator.Result) (any, evalInfo) {
	return result.Value, evalInfo{
		ErrorCode:               result.Error,
		VariationID:             result.VariationID,
		IsDefault:               result.Error != "",
		MatchedTargetingRule:    result.MatchedTargetingRule,
		MatchedPercentageOption: result.MatchedPercentageOption,
	}
}
