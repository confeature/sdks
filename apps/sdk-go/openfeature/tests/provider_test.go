// SPDX-License-Identifier: MIT

package consumer_test

import (
	"context"
	"encoding/json"
	"math"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	provider "github.com/confeature/sdks/apps/sdk-go/openfeature"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

const testSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

func TestOfficialClientUsesTheTargetingKeyRatherThanAnOrdinaryAttribute(t *testing.T) {
	native, client := localProvider(t, `{"f":{
		"rollout":{"t":0,"v":{"b":false},"i":"baseline","p":[{"p":100,"v":{"b":true},"i":"split"}]},
		"attribute":{"t":0,"v":{"b":false},"i":"baseline","a":"plan","p":[{"p":100,"v":{"b":true},"i":"plan"}]}
	}}`)
	ctx := context.Background()
	spoofed := openfeature.NewTargetlessEvaluationContext(map[string]any{
		"targetingKey": "ordinary-value", "Identifier": "reserved-value", "plan": "beta",
	})
	got, err := client.BooleanValueDetails(ctx, "rollout", true, spoofed)
	if err != nil || got.Value || got.Variant != "baseline" {
		t.Fatalf("an ordinary attribute must leave the default identity missing: %+v, %v", got, err)
	}
	got, err = client.BooleanValueDetails(ctx, "attribute", false, spoofed)
	if err != nil || !got.Value || got.Variant != "plan" || got.Reason != openfeature.SplitReason {
		t.Fatalf("the explicitly configured percentage attribute should still work: %+v, %v", got, err)
	}
	identified := openfeature.NewEvaluationContext("official-key", map[string]any{"targetingKey": "ordinary-value"})
	got, err = client.BooleanValueDetails(ctx, "rollout", false, identified)
	if err != nil || !got.Value || got.Variant != "split" || got.Reason != openfeature.SplitReason {
		t.Fatalf("the official key should enter the rollout: %+v, %v", got, err)
	}
	openfeature.Shutdown()
	if !native.GetBoolValue("rollout", false, nil) {
		t.Fatal("the native default user and borrowed client should survive shutdown")
	}
}

func TestOfficialClientKeepsTheWholeInt64Fallback(t *testing.T) {
	_, client := localProvider(t, `{"f":{"small":{"t":2,"v":{"i":7},"i":"seven"}}}`)
	ctx := context.Background()
	eval := openfeature.NewTargetlessEvaluationContext(nil)
	const fallback int64 = 1 << 62
	got, err := client.IntValueDetails(ctx, "missing", fallback, eval)
	if err == nil || got.Value != fallback || got.ErrorCode != openfeature.FlagNotFoundCode {
		t.Fatalf("expected the whole fallback and a missing flag error, got %+v, %v", got, err)
	}
	got, err = client.IntValueDetails(ctx, "small", fallback, eval)
	if err != nil || got.Value != 7 || got.Variant != "seven" {
		t.Fatalf("expected a successful integer resolution, got %+v, %v", got, err)
	}
}

type invocationContextHook struct {
	openfeature.UnimplementedHook
}

func (invocationContextHook) Before(
	context.Context, openfeature.HookContext, openfeature.HookHints,
) (*openfeature.EvaluationContext, error) {
	enriched := openfeature.NewEvaluationContext("hook-user", map[string]any{
		"targetingKey": "untrusted-attribute",
		"plan":         "beta",
	})
	return &enriched, nil
}

func TestProviderRetainsTheInvocationHookContext(t *testing.T) {
	_, client := localProvider(t, `{"f":{"flag":{"t":0,"v":{"b":false},"i":"baseline","r":[
		{"c":[{"u":{"a":"Identifier","c":28,"s":"hook-user"}},{"u":{"a":"plan","c":28,"s":"beta"}}],
		 "s":{"v":{"b":true},"i":"enriched"}}
	]}}}`)
	got, err := client.BooleanValueDetails(context.Background(), "flag", false,
		openfeature.NewTargetlessEvaluationContext(nil), openfeature.WithHooks(invocationContextHook{}))
	if err != nil || !got.Value || got.Variant != "enriched" || got.Reason != openfeature.TargetingMatchReason {
		t.Fatalf("the invocation hook's official key and plan should reach the native evaluator: %+v, %v", got, err)
	}
}

func TestOfficialClientReturnsTypedValuesAndErrors(t *testing.T) {
	_, client := localProvider(t, `{"f":{
		"decimal":{"t":3,"v":{"d":1.5},"i":"quarter"},
		"text":{"t":1,"v":{"s":"{\"show\":true}"},"i":"settings"},
		"malformed":{"t":0,"v":{"s":"invalid"}}
	}}`)
	ctx := context.Background()
	eval := openfeature.NewTargetlessEvaluationContext(nil)
	decimal, err := client.FloatValueDetails(ctx, "decimal", 1.5, eval)
	if err != nil || decimal.Value != 1.5 || decimal.Variant != "quarter" {
		t.Fatalf("a real value equal to the fallback still resolves: %+v, %v", decimal, err)
	}
	text, err := client.StringValueDetails(ctx, "text", "", eval)
	if err != nil || text.Value != `{"show":true}` || text.Variant != "settings" {
		t.Fatalf("JSON settings resolve as strings: %+v, %v", text, err)
	}
	wrongType, err := client.BooleanValueDetails(ctx, "decimal", true, eval)
	if err == nil || !wrongType.Value || wrongType.ErrorCode != openfeature.TypeMismatchCode {
		t.Fatalf("wrong type should return a typed fallback: %+v, %v", wrongType, err)
	}
	malformed, err := client.BooleanValueDetails(ctx, "malformed", false, eval)
	if err == nil || malformed.Value || malformed.ErrorCode != openfeature.ParseErrorCode {
		t.Fatalf("malformed flag should return a typed fallback: %+v, %v", malformed, err)
	}
	object, err := client.ObjectValueDetails(ctx, "text", "object fallback", eval)
	if err == nil || object.Value != "object fallback" || object.ErrorCode != openfeature.TypeMismatchCode {
		t.Fatalf("structured resolution should retain the supplied fallback: %+v, %v", object, err)
	}
}

func TestOfficialClientRejectsNonFiniteOverrides(t *testing.T) {
	nonFinite := math.Inf(1)
	native, err := confeature.NewClient(testSDKKey, confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"), confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewMapOverrideDataSource(map[string]any{"decimal": nonFinite}),
			Behaviour:  confeature.LocalOnly,
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = native.Close() })
	client := officialClient(t, native)
	eval := openfeature.NewTargetlessEvaluationContext(nil)
	got, err := client.FloatValueDetails(context.Background(), "decimal", -0.5, eval)
	if err == nil || got.Value != -0.5 || got.ErrorCode != openfeature.ParseErrorCode {
		t.Fatalf("non-finite flag should return a parse error: %+v, %v", got, err)
	}
}

type countedOverrides struct {
	*confeature.MapOverrideDataSource
	reads int
}

func (source *countedOverrides) GetOverridesSync() map[string]confeature.SettingValue {
	source.reads++
	return source.MapOverrideDataSource.GetOverridesSync()
}

func TestLocalOnlyResolutionReportsOneReadAndADetailsEvent(t *testing.T) {
	source := &countedOverrides{
		MapOverrideDataSource: confeature.NewMapOverrideDataSource(map[string]any{"flag": true}),
	}
	details := make(chan *confeature.EvaluationDetails, 2)
	native, err := confeature.NewClient(testSDKKey, confeature.WithManualPoll(), confeature.WithCacheDir(":memory:"),
		confeature.WithFlagOverrides(confeature.FlagOverrides{DataSource: source, Behaviour: confeature.LocalOnly}),
		confeature.WithHooks(&confeature.Hooks{OnFlagEvaluated: func(e *confeature.EvaluationDetails) { details <- e }}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = native.Close() })
	client := officialClient(t, native)
	value, err := client.BooleanValueDetails(context.Background(), "flag", true,
		openfeature.NewTargetlessEvaluationContext(nil))
	if err != nil || !value.Value || source.reads != 1 {
		t.Fatalf("expected a successful local value and one override read, got %+v, %v, reads=%d", value, err, source.reads)
	}
	event := waitForSignal(t, details, "native details event")
	if event.Value != true || event.Data.IsDefaultValue || event.Data.User != nil {
		t.Fatalf("expected one successful SDK details event with no provider user: %+v", event)
	}
}

func localProvider(t *testing.T, fixture string) (*confeature.Client, *openfeature.Client) {
	t.Helper()
	var config map[string]any
	if err := json.Unmarshal([]byte(fixture), &config); err != nil {
		t.Fatal(err)
	}
	native, err := confeature.NewClient(testSDKKey, confeature.WithManualPoll(),
		confeature.WithCacheDir(":memory:"),
		confeature.WithDefaultUser(&confeature.User{Identifier: "native-default"}),
		confeature.WithFlagOverrides(confeature.FlagOverrides{
			DataSource: confeature.NewConfigOverrideDataSource(config),
			Behaviour:  confeature.LocalOnly,
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = native.Close() })
	return native, officialClient(t, native)
}

func officialClient(t *testing.T, native *confeature.Client) *openfeature.Client {
	t.Helper()
	current, err := provider.NewProvider(native)
	if err != nil {
		t.Fatal(err)
	}
	if _, adapterSubscribes := any(current).(openfeature.EventHandler); adapterSubscribes {
		t.Fatal("the adapter must register zero provider event subscriptions")
	}
	if err := openfeature.SetNamedProviderAndWait(t.Name(), current); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(openfeature.Shutdown)
	return openfeature.NewClient(t.Name())
}
