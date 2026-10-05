// SPDX-License-Identifier: MIT
#pragma once

// FConfeatureFlagOverrides mirrors ConfigCat-cpp's customer-supplied
// override bundle. v0.1 honours `LocalOnly`; `LocalOverRemote` /
// `RemoteOverLocal` are accepted at construction but fall through to
// the cached config in the evaluator (out-of-scope per spec 051).
//
// The override map is a flat `TMap<FString, FString>` per FR-011. The
// stringified value is parsed by the evaluator with the same JSON-aware
// type-check the other 13 languages use (see Private/Internal/OverrideEval.cpp).
//
// Spec 135 / #441 (epic #382, US3) adds an additive, rule-bearing
// full-config override path alongside the value-only map — the UE mirror
// of the corpus-verified C++ #437 `ConfigOverrideDataSource` +
// `createFlagOverridesFromConfig`. See `FConfeatureConfigOverrideDataSource`
// below. The flat-map path is byte-unchanged.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureFlagOverrides.generated.h"

// Full-config override source — holds a complete parsed `config_v6` blob
// (`{p, f, s}` as an `FJsonObject`) and routes through the real evaluator
// offline.
//
// Spec 135 / #441 (epic #382, US3): the rule-bearing sibling of the
// value-only override map. Where the map emits value-only settings, this
// source retains the WHOLE `{p, f, s}` config — salt (`p.s`) + segments
// (`s`) + rule-bearing settings (`f`) — so the UE evaluator can resolve
// targeting rules / segments / prerequisites / percentage options purely
// from the supplied config, no network fetch.
//
// UE-idiomatic mirror of the C++ #437 `ConfigOverrideDataSource`
// (`apps/sdk-cpp/include/confeature/flag_overrides.h`) and the JS
// federation's `ConfigOverrideDataSource`. The C++ source is a polymorphic
// `OverrideDataSource` subclass; UE's override bundle is a Blueprint
// `USTRUCT` that cannot carry a virtual base, so the full-config carrier is
// a plain ref-counted helper held by `TSharedPtr` on the struct. No
// ConfigCat-named member is renamed or retyped.
//
// The whole config blob is retained (never just `f`) — the spec-129
// dropped-salt regression guard (INV-4): percentage bucketing reads `p.s`
// and segment conditions read `s`.
//
// Resolution NEVER routes rule-bearing data through the value-only path:
// `GetOverridesSync()` returns the flat *base* value envelopes (so key
// enumeration works), but rule resolution always goes through the evaluator
// with the full `Config()`. The override router
// (`Confeature::Internal::EvaluateOverride`) dispatches on the source TYPE.
struct CONFEATURE_API FConfeatureConfigOverrideDataSource
{
	explicit FConfeatureConfigOverrideDataSource(const TSharedPtr<FJsonObject>& InConfig)
		: ConfigData(InConfig), BaseValues(BaseValuesOf(InConfig))
	{
	}

	// The full parsed `config_v6` blob (`{p, f, s}`). Consumed by the
	// full-config override router; never the flat-map path.
	const TSharedPtr<FJsonObject>& Config() const { return ConfigData; }

	// Returns the flat *base* value envelopes of the settings (the served
	// `setting.v.{b,s,i,d}`), so callers can enumerate the override's flag
	// keys. Rule resolution never goes through this map — the router
	// evaluates the full config through the real evaluator.
	const TMap<FString, TSharedPtr<FJsonValue>>& GetOverridesSync() const { return BaseValues; }

private:
	// Derives the flat base-value map from the config's `f` object once at
	// construction so key enumeration is cheap and stable. Mirrors the C++
	// `ConfigOverrideDataSource::baseValuesOf` (first non-null of b/s/i/d).
	static TMap<FString, TSharedPtr<FJsonValue>> BaseValuesOf(const TSharedPtr<FJsonObject>& Config);

	TSharedPtr<FJsonObject> ConfigData;
	TMap<FString, TSharedPtr<FJsonValue>> BaseValues;
};

UENUM(BlueprintType)
enum class EConfeatureOverrideBehaviour : uint8
{
	LocalOnly = 0 UMETA(DisplayName = "LocalOnly"),
	LocalOverRemote = 1 UMETA(DisplayName = "LocalOverRemote"),
	RemoteOverLocal = 2 UMETA(DisplayName = "RemoteOverLocal"),
};

USTRUCT(BlueprintType)
struct CONFEATURE_API FConfeatureFlagOverrides
{
	GENERATED_BODY()

	// Override map. Keys are flag names; values are JSON-serialised
	// primitives (`true`, `42`, `"text"`, etc.) — the evaluator parses
	// each entry as it consults the map.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	TMap<FString, FString> Map;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	EConfeatureOverrideBehaviour Behaviour = EConfeatureOverrideBehaviour::LocalOnly;

	// Full-config override source (spec 135 / #441) — additive. When set,
	// this override bundle is a full-config source: `GetValue*` resolves
	// targeting rules / segments / % options offline through the real
	// evaluator with the WHOLE `{p, f, s}` blob (the override router
	// dispatches on whether this is set). Not a `UPROPERTY` — the carrier
	// holds an `FJsonObject` that is not Blueprint-reflectable; it is
	// populated only by `MakeFromConfig`. A `FlagOverrides` is one form
	// XOR the other (mutually exclusive per ConfigCat semantics).
	TSharedPtr<FConfeatureConfigOverrideDataSource> ConfigSource;

	// True when this bundle carries a rule-bearing full-config source
	// (vs the value-only map). Mirrors the C++ router's
	// `dynamic_cast<const ConfigOverrideDataSource*>` type probe.
	bool IsFullConfig() const { return ConfigSource.IsValid(); }

	static FConfeatureFlagOverrides MakeLocalOnly(const TMap<FString, FString>& InMap)
	{
		FConfeatureFlagOverrides Out;
		Out.Map = InMap;
		Out.Behaviour = EConfeatureOverrideBehaviour::LocalOnly;
		return Out;
	}

	// Build a `FConfeatureFlagOverrides` from a complete, rule-bearing
	// `config_v6` blob (`{p, f, s}`) evaluated offline through the real UE
	// evaluator.
	//
	// The in-memory, rule-bearing offline-override factory (spec 135 / #441,
	// epic #382, US3). With `EConfeatureOverrideBehaviour::LocalOnly`,
	// `GetValue*(key, default, user)` resolves targeting rules / segments /
	// prerequisites / percentage options purely from `InConfig` through the
	// real evaluator — no network fetch.
	//
	// Additive (Principle II): mirrors the C++ `createFlagOverridesFromConfig`
	// and the JS federation's `createFlagOverridesFromConfig`. The factory
	// spelling matches the existing map factory's `MakeLocalOnly` UE
	// convention. No ConfigCat-named member is renamed or retyped.
	static FConfeatureFlagOverrides MakeFromConfig(
		const TSharedPtr<FJsonObject>& InConfig, EConfeatureOverrideBehaviour InBehaviour)
	{
		FConfeatureFlagOverrides Out;
		Out.Behaviour = InBehaviour;
		Out.ConfigSource = MakeShared<FConfeatureConfigOverrideDataSource>(InConfig);
		return Out;
	}
};
