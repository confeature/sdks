// SPDX-License-Identifier: MIT

package confeature_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	"github.com/confeature/sdks/apps/sdk-go/internal/providercontext"
)

func TestProviderContextUsesOnlyItsOwnTargetingAttributes(t *testing.T) {
	config := providerTestConfig(t, `{"f":{
		"identity":{"t":0,"v":{"b":false},"i":"baseline","p":[{"p":100,"v":{"b":true},"i":"identifier"}]},
		"attribute":{"t":0,"v":{"b":false},"i":"baseline","a":"plan","p":[{"p":100,"v":{"b":true},"i":"plan"}]}
	}}`)
	client := providerTestClient(t, confeature.NewConfigOverrideDataSource(config),
		confeature.WithDefaultUser(&confeature.User{Identifier: "native-default"}))
	if got := client.GetBoolValueDetails("identity", false, nil); !got.Value || got.Data.VariationID != "identifier" {
		t.Fatalf("native default user should enter the rollout: %+v", got)
	}

	ctx := providercontext.WithEvaluation(context.Background(), false)
	attributes := &confeature.User{Custom: map[string]any{"plan": "beta"}}
	noIdentity := client.GetBoolValueDetailsWithContext(ctx, "identity", true, attributes)
	if noIdentity.Value || noIdentity.Data.IsDefaultValue || noIdentity.Data.VariationID != "baseline" {
		t.Fatalf("missing targeting key should leave the rollout at its baseline: %+v", noIdentity)
	}
	explicitAttribute := client.GetBoolValueDetailsWithContext(ctx, "attribute", false, attributes)
	if !explicitAttribute.Value || explicitAttribute.Data.VariationID != "plan" || explicitAttribute.Data.User != nil {
		t.Fatalf("an explicit rollout attribute works without a targeting key: %+v", explicitAttribute)
	}
}

func TestProviderContextReadsAFlatOverrideOnceAndKeepsSuccessEqualToDefault(t *testing.T) {
	var reads int
	source := synchronousSource(func() map[string]confeature.SettingValue {
		reads++
		value := true
		return map[string]confeature.SettingValue{"enabled": {B: &value}}
	})
	events := make(chan *confeature.EvaluationDetails, 1)
	client := providerTestClient(t, source, confeature.WithHooks(&confeature.Hooks{
		OnFlagEvaluated: func(details *confeature.EvaluationDetails) { events <- details },
	}))
	ctx := providercontext.WithEvaluation(context.Background(), true)
	details := client.GetBoolValueDetailsWithContext(ctx, "enabled", true, &confeature.User{Identifier: "synthetic-id"})
	if reads != 1 || !details.Value || details.Data.IsDefaultValue || details.Data.Error != nil || details.Data.User != nil {
		t.Fatalf("read count %d or successful override details differed: %+v", reads, details)
	}
	select {
	case payload := <-events:
		if payload.Data.User != nil || payload.Data.Error != nil {
			t.Fatalf("unexpected hook details: %+v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("expected one evaluation hook")
	}
}

func TestProviderContextObservesCancellationDuringTheOverrideRead(t *testing.T) {
	caller, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := synchronousSource(func() map[string]confeature.SettingValue {
		cancel()
		value := true
		return map[string]confeature.SettingValue{"enabled": {B: &value}}
	})
	events := make(chan *confeature.EvaluationDetails, 1)
	client := providerTestClient(t, source, confeature.WithHooks(&confeature.Hooks{
		OnFlagEvaluated: func(details *confeature.EvaluationDetails) { events <- details },
	}))
	ctx := providercontext.WithEvaluation(caller, false)
	details := client.GetBoolValueDetailsWithContext(ctx, "enabled", false, nil)
	if details.Value || !details.Data.IsDefaultValue || !errors.Is(details.Data.Error, context.Canceled) {
		t.Fatalf("cancellation should return the caller fallback and a cancellation error: %+v", details)
	}
	select {
	case payload := <-events:
		t.Fatalf("cancelled evaluation reached the hook: %+v", payload)
	case <-time.After(25 * time.Millisecond):
	}
}

func providerTestConfig(t *testing.T, fixture string) map[string]any {
	t.Helper()
	var config map[string]any
	if err := json.Unmarshal([]byte(fixture), &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func providerTestClient(t *testing.T, source confeature.OverrideDataSource, options ...confeature.Option) *confeature.Client {
	t.Helper()
	client, err := confeature.NewClient(typedTestKey, append([]confeature.Option{
		confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"),
		confeature.WithLogger(newTypedTestLogger()),
		confeature.WithFlagOverrides(confeature.FlagOverrides{DataSource: source, Behaviour: confeature.LocalOnly}),
	}, options...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

type synchronousSource func() map[string]confeature.SettingValue

func (s synchronousSource) GetOverridesSync() map[string]confeature.SettingValue { return s() }

func (s synchronousSource) GetOverrides(context.Context) (map[string]confeature.SettingValue, error) {
	return s(), nil
}
