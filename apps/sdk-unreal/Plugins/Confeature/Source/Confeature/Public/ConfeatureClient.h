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
//   - UFUNCTION(BlueprintCallable) ForceRefresh (upstream's shape and
//     semantics: synchronous) / ForceRefreshWithCallback (Confeature
//     addition, non-blocking) / Close
//   - ForceRefreshAsync (C++, non-blocking Confeature addition)
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
// while the customer holds a strong handle. `Close()` cancels the HTTP
// request in flight and voids any refresh still running; it does not join
// the refresh thread (see Close).

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"
#include "UObject/Object.h"
#include "UObject/WeakObjectPtrTemplates.h"

#include "ConfeatureEvaluationDetails.h"
#include "ConfeatureFlagOverrides.h"
#include "ConfeatureHooks.h"
#include "ConfeatureLogger.h"
#include "ConfeaturePollingMode.h"
#include "ConfeatureUser.h"

#include "ConfeatureClient.generated.h"

class UConfeatureClient;

// The outcome of a force refresh — ConfigCat's cpp-sdk `RefreshResult`
// (`success()` is `!errorMessage`) in UE shape (#832). Success means the
// config is current: a new config was fetched, the origin answered 304
// Not Modified, or LocalOnly overrides need no fetch. A failure carries
// a fixed, key-free reason (the same one `OnError` gets for a failed
// fetch).
USTRUCT(BlueprintType)
struct CONFEATURE_API FConfeatureRefreshResult
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	bool bSuccess = false;

	// Empty on success.
	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FString ErrorMessage;
};

// Completion of `ForceRefreshWithCallback` — delivered on the game
// thread, after `OnConfigChanged` / `OnError` for the same refresh.
DECLARE_DYNAMIC_DELEGATE_OneParam(
	FConfeatureOnRefreshCompletedBp, const FConfeatureRefreshResult&, Result);

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

	// ── Force refresh (#832) ─────────────────────────────────────────────
	//
	// An on-demand fetch outside the poll cycle. Every variant fires the
	// hooks the same way: OnConfigChanged when a new config landed (not on
	// a 304), OnError when the fetch failed; a closed or offline client, or
	// LocalOnly overrides, fetch nothing and fire nothing.

	// ConfigCat's `UConfigCatSubsystem::ForceRefresh` — same name, no
	// arguments, void, SYNCHRONOUS (Principle II; configcat/unreal-engine-sdk
	// @ 923800268dba36ad25963dcace191179de4ba936, read 2026-10-27). It
	// returns once the fetch ended and its config is applied; on the game
	// thread the hooks have fired by then too (off it they are queued to
	// the game thread). On the game thread it pumps the HTTP manager while
	// it waits (Tick 0.05 s + Sleep 0.05 s, upstream's loop), so the frame
	// stalls for the request — at most the request timeout + 5 s — but
	// never deadlocks (#832). To refresh without stalling the frame, use
	// `ForceRefreshWithCallback` (Blueprint) or `ForceRefreshAsync` (C++).
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	void ForceRefresh();

	// Confeature addition (no upstream counterpart) and the route to use
	// from Blueprint: a NON-blocking `ForceRefresh` — it returns at once,
	// the fetch runs on its own thread, and the completion receives the
	// outcome on the game thread, after the hooks. A Blueprint delegate
	// unbinds itself when its object dies, so a completion that outlives
	// its graph is a silent no-op.
	UFUNCTION(BlueprintCallable, Category = "Confeature")
	void ForceRefreshWithCallback(FConfeatureOnRefreshCompletedBp OnCompleted);

	// Confeature addition, C++, the non-blocking route from the game
	// thread: returns at once; `OnCompleted` (may be empty) runs on the
	// game thread once the refresh ended — always on a later tick, never
	// inside this call.
	// A call made while an async refresh runs joins it (one fetch, every
	// completion called). A never-initialised client completes with
	// CLIENT_NOT_INITIALIZED, a closed one with CLIENT_CLOSED (also when
	// Close() ran mid-refresh).
	//
	// LIFETIME: `OnCompleted` may run after this client was closed or
	// garbage-collected (it still gets the outcome), and is dropped
	// unrun once the engine is exiting. Guard what it captures — a
	// TWeakObjectPtr for UObjects, a TWeakPtr for shared state — rather
	// than capturing raw pointers.
	void ForceRefreshAsync(TFunction<void(const FConfeatureRefreshResult&)> OnCompleted = nullptr);

	// Idempotent close. Cancels the HTTP request in flight and voids any
	// refresh still running: it writes nothing, fires no hook and reports
	// CLIENT_CLOSED. It does NOT join the refresh thread — that thread
	// returns once UE delivers the cancel (a later HTTP-manager tick) or
	// at its give-up bound (request timeout + 5 s), holding only the
	// client's shared internals, not the UObject. Safe from any thread.
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

	// Opaque implementation types, defined in ConfeatureClient.cpp.
	// Public only so that file's free helpers may name them; an
	// incomplete type is unusable anywhere else.
	struct FImpl;
	struct FUpdateResult;

private:
	// Shared, not unique: an in-flight `ForceRefreshAsync` keeps the
	// fetcher, cache and config alive past this UObject's destruction.
	TSharedPtr<FImpl, ESPMode::ThreadSafe> Impl;

	// Fires the hooks a finished refresh owes and returns its outcome.
	// Callable from any thread (the hooks marshal to the game thread).
	FConfeatureRefreshResult ReportRefresh(const FUpdateResult& Update) const;

	// Hands a finished (or never-started) refresh to the game thread on a
	// later tick: ReportRefresh there, then every callback. Static: the
	// client may be gone by then.
	static void DeliverRefresh(TWeakObjectPtr<UConfeatureClient> WeakSelf,
		TSharedPtr<FImpl, ESPMode::ThreadSafe> ImplRef,
		FUpdateResult Update,
		TArray<TFunction<void(const FConfeatureRefreshResult&)>> Callbacks);

	// DeliverRefresh for one caller's refresh resolved without a fetch.
	void DeliverAlone(FUpdateResult Update, TFunction<void(const FConfeatureRefreshResult&)> OnCompleted);

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
