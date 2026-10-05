// SPDX-License-Identifier: MIT
#pragma once

// Hooks / events surface for the Confeature Unreal SDK.
//
// Mirrors ConfigCat's official Unreal Engine SDK
// (configcat/unreal-engine-sdk — `ConfigCatSubsystem.h`), which since
// 2024 exposes a PAIRED delegate API: NATIVE C++ multicast delegates for
// C++ subscribers + Blueprint DYNAMIC multicast delegates for Blueprint
// subscribers. Both halves of each pair fire from the same emission site
// (Principle II — drop-in compatibility; epic #574 / issue #577).
//
// Upstream → Confeature name map (configcat → confeature):
//   - FOnClientReady   (FSimpleMulticastDelegate)            → unchanged shape
//   - FOnConfigChanged (TMulticastDelegate<void(UConfigCatSettingsWrapper*)>)
//                       → FConfeatureOnConfigChanged(UConfeatureSettingsWrapper*)
//   - FOnFlagEvaluated (TMulticastDelegate<void(UConfigCatEvaluationWrapper*)>)
//                       → FConfeatureOnFlagEvaluated(UConfeatureEvaluationWrapper*)
//   - FOnError         (TMulticastDelegate<void(const FString&, const FString&)>)
//                       → FConfeatureOnError(const FString&, const FString&)
// Blueprint siblings carry the upstream `...Bp` suffix verbatim:
//   - FConfeatureOnClientReadyBp / FConfeatureOnConfigChangedBp /
//     FConfeatureOnFlagEvaluatedBp / FConfeatureOnErrorBp.
//
// Confeature uses its OWN wrapper UObject types (not ConfigCat's), per
// the brief: `UConfeatureSettingsWrapper` carries the settings snapshot
// and `UConfeatureEvaluationWrapper` carries the eval-details envelope.
//
// THREADING: every emission is marshalled onto the GAME THREAD before
// broadcast (the fetch + eval lifecycle can run on a worker thread; UE
// dynamic-multicast delegates + UObject wrappers must only be touched on
// the game thread). See ConfeatureClient.cpp emission sites.

#include "CoreMinimal.h"
#include "Delegates/Delegate.h"
#include "UObject/Object.h"

#include "ConfeatureEvaluationDetails.h"

#include "ConfeatureHooks.generated.h"

// ---------------------------------------------------------------------
// Wrapper UObjects — Confeature's own settings + evaluation carriers.
// ---------------------------------------------------------------------

// Carries an immutable snapshot of the setting KEYS present in the
// freshly-fetched config_v6 document. Mirrors the role of upstream's
// `UConfigCatSettingsWrapper` (which wraps configcat::Settings) — Confeature
// surfaces the wire-level setting keys it parsed so a Blueprint listener
// can react to "what changed" without re-parsing the config. The full
// typed value is read back through the normal `GetValue*` surface.
UCLASS(BlueprintType, meta = (DisplayName = "Confeature Settings Wrapper"))
class CONFEATURE_API UConfeatureSettingsWrapper : public UObject
{
	GENERATED_BODY()

public:
	// The setting keys carried by the new config (`f` map keys). Empty
	// when the config has no flags. Read-only — the snapshot is frozen
	// at broadcast time.
	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	TArray<FString> SettingKeys;
};

// Wraps the evaluation-details envelope handed to OnFlagEvaluated.
// Mirrors upstream's `UConfigCatEvaluationWrapper` (which wraps
// configcat::EvaluationDetails). Confeature reuses its existing
// `FConfeatureEvaluationDetails` USTRUCT as the payload.
UCLASS(BlueprintType, meta = (DisplayName = "Confeature Evaluation Wrapper"))
class CONFEATURE_API UConfeatureEvaluationWrapper : public UObject
{
	GENERATED_BODY()

public:
	// The full evaluation-details envelope (key / value slot / variationId
	// / error / isDefaultValue / user) for the flag that was just evaluated.
	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FConfeatureEvaluationDetails Details;
};

// ---------------------------------------------------------------------
// Native (C++) multicast delegates — for C++ subscribers.
// Mirror upstream's `using FOn... = TMulticastDelegate<...>` aliases.
// ---------------------------------------------------------------------

// Fires once when the client's first config resolution completes (a
// successful fetch OR a cache restore OR LocalOnly readiness). Mirrors
// upstream `FOnClientReady = FSimpleMulticastDelegate`.
using FConfeatureOnClientReady = FSimpleMulticastDelegate;

// Fires when a NEW config.json has been downloaded (the FETCHED path —
// NOT a 304 Not Modified). Mirrors upstream
// `FOnConfigChanged = TMulticastDelegate<void(UConfigCatSettingsWrapper*)>`.
DECLARE_MULTICAST_DELEGATE_OneParam(FConfeatureOnConfigChanged, UConfeatureSettingsWrapper*);

// Fires for every flag evaluation that produces an EvaluationDetails.
// Mirrors upstream
// `FOnFlagEvaluated = TMulticastDelegate<void(UConfigCatEvaluationWrapper*)>`.
DECLARE_MULTICAST_DELEGATE_OneParam(FConfeatureOnFlagEvaluated, UConfeatureEvaluationWrapper*);

// Fires when an error occurs inside the SDK (e.g. a failed config fetch).
// First arg is a human-readable message, second is the error detail /
// class. The raw SDK key NEVER appears in either string. Mirrors upstream
// `FOnError = TMulticastDelegate<void(const FString&, const FString&)>`.
DECLARE_MULTICAST_DELEGATE_TwoParams(FConfeatureOnError, const FString&, const FString&);

// ---------------------------------------------------------------------
// Blueprint dynamic multicast delegates — for Blueprint subscribers.
// Mirror upstream's `DECLARE_DYNAMIC_MULTICAST_DELEGATE(...Bp)` family.
// ---------------------------------------------------------------------

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FConfeatureOnClientReadyBp);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(
	FConfeatureOnConfigChangedBp, UConfeatureSettingsWrapper*, Settings);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(
	FConfeatureOnFlagEvaluatedBp, UConfeatureEvaluationWrapper*, Evaluation);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(
	FConfeatureOnErrorBp, const FString&, Message, const FString&, Detail);
