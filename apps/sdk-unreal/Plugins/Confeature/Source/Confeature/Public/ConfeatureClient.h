// SPDX-License-Identifier: MIT
#pragma once

// Top-level customer-facing `UConfeatureClient`. Drop-in compatible
// with ConfigCat's C++ / UE patterns: customers migrate by renaming the
// class + the include header (constitution Principle II — NON-NEGOTIABLE).
//
// Public API:
//   - UConfeatureClient::Create(SdkKey) → TStrongObjectPtr<UConfeatureClient>
//   - UConfeatureClient::Builder(SdkKey) → FConfeatureClientBuilder
//   - UFUNCTION(BlueprintCallable) GetValue{Bool,String,Int,Float,Double}
//   - UFUNCTION(BlueprintCallable) ForceRefresh / Close
//   - Snapshot() — synchronous view of the cached config
//
// UE Blueprint nodes cannot dispatch on template type parameters, so
// the per-primitive `GetValue*` overloads are exposed individually
// (mirrors UE's own `UDataTable::GetRow*` pattern). `GetValueDouble` is
// the 8-byte byte-stable counterpart of `GetValueFloat` (UE `float` is
// 4 bytes — lossy on precision-sensitive doubles like
// 0.30000000000000004).
//
// Memory: `UConfeatureClient` is a `UObject` rooted via
// `TStrongObjectPtr<>` so the UE garbage collector cannot reclaim it
// while the customer holds a strong handle. `Close()` releases all
// background ticker handles + HTTP requests.

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"
#include "Templates/UniquePtr.h"
#include "UObject/Object.h"

#include "ConfeatureEvaluationDetails.h"
#include "ConfeatureFlagOverrides.h"
#include "ConfeatureHooks.h"
#include "ConfeatureLogger.h"
#include "ConfeaturePollingMode.h"
#include "ConfeatureUser.h"

#include "ConfeatureClient.generated.h"

class UConfeatureClient;

// Fluent builder. Mirrors `ConfeatureClient::builder(...)` from the C++
// SDK; lives outside the UCLASS so its setters can chain via reference
// (UFUNCTIONs cannot return references).
class CONFEATURE_API FConfeatureClientBuilder
{
public:
	explicit FConfeatureClientBuilder(FString InSdkKey);

	FConfeatureClientBuilder& PollingMode(const FConfeaturePollingModeConfig& InMode);
	FConfeatureClientBuilder& BaseUrl(FString InUrl);
	FConfeatureClientBuilder& HttpTimeoutSeconds(int32 InSeconds);
	FConfeatureClientBuilder& Logger(TSharedPtr<IConfeatureLogger> InLogger);
	FConfeatureClientBuilder& CacheDirectory(FString InDirectory);
	FConfeatureClientBuilder& FlagOverrides(const FConfeatureFlagOverrides& InOverrides);
	FConfeatureClientBuilder& DefaultUser(const FConfeatureUser& InUser);

	// Validates configuration + constructs the client. Returns a UObject
	// pointer; the caller is responsible for rooting (typically via
	// `TStrongObjectPtr<>` or by binding to a `UPROPERTY()` field).
	UConfeatureClient* Build();

private:
	friend class UConfeatureClient;

	FString SdkKey;
	FConfeaturePollingModeConfig PollingModeConfig = FConfeaturePollingModeConfig::AutoPollMode();
	FString CdnBaseUrl;
	int32 TimeoutSeconds = 30;
	TSharedPtr<IConfeatureLogger> SharedLogger;
	FString CacheDirectoryOverride;
	FConfeatureFlagOverrides OverridesConfig;
	bool bHasOverrides = false;
	FConfeatureUser DefaultUserConfig;
	bool bHasDefaultUser = false;
};

UCLASS(BlueprintType, meta = (DisplayName = "Confeature Client"))
class CONFEATURE_API UConfeatureClient : public UObject
{
	GENERATED_BODY()

public:
	// Static factory mirroring `ConfigCatClient::create`. Returns a
	// raw UObject pointer; the caller MUST root it (typically via
	// `TStrongObjectPtr<>` on a stack variable or by binding to a
	// `UPROPERTY()` field on an owning UObject).
	UFUNCTION(BlueprintCallable, Category = "Confeature", meta = (DisplayName = "Create"))
	static UConfeatureClient* Create(const FString& SdkKey);

	// Fluent builder. Use from C++ — Blueprint nodes call `Create`
	// directly and configure via setters on the returned client.
	static FConfeatureClientBuilder Builder(FString SdkKey);

	// Resolves `Key` to a bool. Returns `DefaultValue` for any failure
	// path. The SDK NEVER throws from a public method.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	bool GetValueBool(const FString& Key, bool DefaultValue, const FConfeatureUser& User) const;

	// Resolves `Key` to a string. Returns `DefaultValue` for any failure
	// path (TYPE_MISMATCH / MALFORMED_VALUE / KEY_NOT_FOUND / NO_CONFIG /
	// MALFORMED_CONFIG / UNSUPPORTED_TYPE). The SDK NEVER throws.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	FString GetValueString(
		const FString& Key, const FString& DefaultValue, const FConfeatureUser& User) const;

	// Resolves `Key` to an int. Returns `DefaultValue` for any failure
	// path (see GetValueString).
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	int32 GetValueInt(const FString& Key, int32 DefaultValue, const FConfeatureUser& User) const;

	// Resolves `Key` to a float (4-byte). Lossy on precision-sensitive
	// doubles — customers needing byte-stable 64-bit precision should
	// call `GetValueDouble` instead. Returns `DefaultValue` for any
	// failure path (see GetValueString).
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	float GetValueFloat(const FString& Key, float DefaultValue, const FConfeatureUser& User) const;

	// Resolves `Key` to a double (8-byte IEEE-754). Byte-stable on
	// precision-sensitive doubles (e.g. 0.30000000000000004). UE 5.0+
	// Blueprint supports native `double` parameter and return pins.
	// Returns `DefaultValue` for any failure path (see GetValueString).
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	double GetValueDouble(
		const FString& Key, double DefaultValue, const FConfeatureUser& User) const;

	// Spec 085 / #266 + spec 152 / #475 US2 — typed evaluation-details
	// surface. Mirrors `configcat-cpp`'s `getValueDetails<T>` (adapted to
	// UE's per-primitive Blueprint convention, exactly like `GetValue*`).
	// Returns an `FConfeatureEvaluationDetails` whose value slot, error
	// code, and `VariationId` describe the resolution — the variation ID
	// propagates through the full-config override path + cache hits (the
	// #395 gap class) and is empty on every fail branch + the flat-map
	// (value-only) override path. NEVER throws.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	FConfeatureEvaluationDetails GetValueDetailsBool(
		const FString& Key, bool DefaultValue, const FConfeatureUser& User) const;

	UFUNCTION(BlueprintCallable, Category = "Confeature")
	FConfeatureEvaluationDetails GetValueDetailsString(
		const FString& Key, const FString& DefaultValue, const FConfeatureUser& User) const;

	UFUNCTION(BlueprintCallable, Category = "Confeature")
	FConfeatureEvaluationDetails GetValueDetailsInt(
		const FString& Key, int32 DefaultValue, const FConfeatureUser& User) const;

	UFUNCTION(BlueprintCallable, Category = "Confeature")
	FConfeatureEvaluationDetails GetValueDetailsDouble(
		const FString& Key, double DefaultValue, const FConfeatureUser& User) const;

	// Triggers an immediate synchronous fetch + cache update. Returns
	// true on success, false if the fetch failed (the reason is logged).
	// No-op when LocalOnly overrides are configured.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	bool ForceRefresh();

	// Idempotent close — cancels every spawned task. Safe to call from
	// any thread.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	void Close();

	// Reports whether `Close()` has been called.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	bool IsClosed() const;

	// Spec 102 / #267 slice 14/14 — online/offline triplet. Mirrors the
	// cross-SDK ConfigCat surface (setOnline / setOffline / isOffline).
	// SetOnline / SetOffline are idempotent. LocalOnly clients: IsOffline
	// returns true; SetOnline logs WARN + no-op; SetOffline silent no-op.
	// Closed clients: IsOffline returns true; setters log WARN + no-op.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	void SetOnline();

	UFUNCTION(BlueprintCallable, Category = "Confeature")
	void SetOffline();

	UFUNCTION(BlueprintCallable, Category = "Confeature")
	bool IsOffline() const;

	// ── Hooks / events (epic #574 / #577) ────────────────────────────────
	//
	// Paired delegate surface mirroring ConfigCat's official Unreal SDK
	// (`ConfigCatSubsystem`). Each event has a NATIVE multicast delegate
	// (for C++ subscribers, bound via `.AddLambda` / `.AddRaw` / `.AddUObject`)
	// and a Blueprint DYNAMIC multicast delegate (`...Bp`, BlueprintAssignable
	// so Blueprint graphs can bind an event node). Both halves of a pair fire
	// from the same emission site, on the GAME THREAD.
	//
	//   - OnClientReady   — first config resolution completed (once),
	//                        fired one game-thread tick after construction.
	//   - OnConfigChanged — a NEW config.json was downloaded (FETCHED path
	//                        in ForceRefresh; NOT a 304 Not Modified).
	//   - OnFlagEvaluated — a flag evaluation produced an EvaluationDetails.
	//                        Fired from the GetValueDetails* family (the
	//                        canonical details-producing path; the plain
	//                        GetValue* getters do not compute a details
	//                        envelope and so do not fire — bind a
	//                        *Details accessor to observe evaluations).
	//   - OnError         — an SDK error occurred (e.g. a failed fetch).
	//                        Neither argument ever carries the raw SDK key.

	// Native (C++) multicast delegates. Subscribe directly, e.g.
	//   Client->OnConfigChanged.AddLambda([](UConfeatureSettingsWrapper* S){ ... });
	FConfeatureOnClientReady OnClientReady;
	FConfeatureOnConfigChanged OnConfigChanged;
	FConfeatureOnFlagEvaluated OnFlagEvaluated;
	FConfeatureOnError OnError;

	// Blueprint dynamic multicast delegates. Bind from a Blueprint graph.
	UPROPERTY(BlueprintAssignable, Category = "Confeature|Hooks")
	FConfeatureOnClientReadyBp OnClientReadyBp;

	UPROPERTY(BlueprintAssignable, Category = "Confeature|Hooks")
	FConfeatureOnConfigChangedBp OnConfigChangedBp;

	UPROPERTY(BlueprintAssignable, Category = "Confeature|Hooks")
	FConfeatureOnFlagEvaluatedBp OnFlagEvaluatedBp;

	UPROPERTY(BlueprintAssignable, Category = "Confeature|Hooks")
	FConfeatureOnErrorBp OnErrorBp;

	virtual void BeginDestroy() override;

	// Internal: builder-driven construction. Customer code calls
	// `Create` / `Builder` — never this directly.
	void InitializeFromBuilder(const FConfeatureClientBuilder& InBuilder);

private:
	struct FImpl;
	TUniquePtr<FImpl> Impl;

	// ── Hook emission helpers (always broadcast on the GAME THREAD) ──────
	// Each marshals onto the game thread (via AsyncTask(ENamedThreads::
	// GameThread, ...) when called off-thread) before touching the
	// delegates + UObject wrappers, then broadcasts BOTH the native and
	// the Blueprint sibling. Empty-binding-safe: a delegate with no
	// listeners is a no-op.
	//
	// Marked `const` because the read-side methods (GetValue* /
	// GetValueDetails*) that fire OnFlagEvaluated are themselves `const`;
	// the broadcast is a logically-const observable side effect, so the
	// helpers const_cast to self to invoke the non-const Broadcast().
	void EmitClientReady() const;
	void EmitConfigChanged(const TArray<FString>& SettingKeys) const;
	void EmitFlagEvaluated(const FConfeatureEvaluationDetails& Details) const;
	void EmitError(const FString& Message, const FString& Detail) const;
};
