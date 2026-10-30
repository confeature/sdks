// SPDX-License-Identifier: MIT

#include "ConfeatureClient.h"

#include "CoreGlobals.h"

#include "Async/Async.h"
#include "Async/TaskGraphInterfaces.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/CriticalSection.h"
#include "HAL/PlatformAtomics.h"
#include "Misc/ScopeExit.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Templates/UniquePtr.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/WeakObjectPtrTemplates.h"

#include "ConfeatureVersion.h"
#include "Internal/ConfigFetcher.h"
#include "Internal/Evaluator.h"
#include "Internal/FilesystemCache.h"
#include "Internal/OverrideEval.h"
#include "Internal/SdkKey.h"

#include <atomic>

DEFINE_LOG_CATEGORY_STATIC(LogConfeatureClient, Log, All);

// Pimpl. Holding implementation state in a `TSharedPtr<FImpl>` keeps
// the public header free of `FConfigFetcher` / `FFilesystemCache` /
// FJsonObject internals so customers compiling against the UCLASS need
// no transitive includes.
struct UConfeatureClient::FImpl
{
	FString SdkKey;
	FString Version = Confeature::SDK_VERSION;
	FConfeaturePollingModeConfig PollingModeConfig;
	FConfeatureFlagOverrides Overrides;
	bool bHasOverrides = false;
	FConfeatureUser DefaultUser;
	bool bHasDefaultUser = false;
	TSharedPtr<Confeature::Internal::IConfeatureLogger> Logger;
	TUniquePtr<Confeature::Internal::FConfigFetcher> Fetcher;
	TUniquePtr<Confeature::Internal::FFilesystemCache> Cache;

	mutable FCriticalSection ConfigMutex;
	TSharedPtr<FJsonObject> CachedConfig;
	FString CachedETag;

	FThreadSafeBool bClosed{false};

	// Spec 102 / #267 — mirrors cross-SDK offline flag.
	FThreadSafeBool bOffline{false};

	// One fetch at a time (#832 review): every fetching refresh — the
	// async worker and a synchronous ForceRefresh alike — holds this from
	// its ETag read to its config write, so two refreshes never interleave
	// and an older response never overwrites a newer one. The game thread
	// never BLOCKS on it (see RefreshNow).
	FCriticalSection RefreshMutex;

	// Held around a refresh's config + cache write and around Close()'s
	// flag flip, so once Close() returned no refresh writes anything.
	// Never held across a fetch, so Close() never waits on the network.
	FCriticalSection WriteMutex;

	// Async coalescing (#832 review): while one async refresh runs, later
	// callers attach their completion to it instead of starting another.
	// Both fields are guarded by `WaitersMutex`.
	FCriticalSection WaitersMutex;
	bool bAsyncInFlight = false;
	TArray<TFunction<void(const FConfeatureRefreshResult&)>> Waiters;
};

namespace
{
	using namespace Confeature::Internal;

	// Loads any prior on-disk config into the in-memory snapshot. Tolerant
	// of legacy single-object envelopes — the same shape every other SDK
	// in the federation writes.
	void TryRestoreFromCache(UConfeatureClient::FImpl& Impl)
	{
		if (!Impl.Cache.IsValid())
		{
			return;
		}
		const FString Tail = CacheKeyTail(DeriveCacheKey(Impl.SdkKey));
		const FString Raw = Impl.Cache->Read(Tail);
		if (Raw.IsEmpty())
		{
			return;
		}
		TSharedPtr<FJsonObject> Parsed;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		if (FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid())
		{
			FScopeLock Guard(&Impl.ConfigMutex);
			Impl.CachedConfig = Parsed;
		}
	}

	// Serialise the parsed FJsonObject back to a string so we can write
	// it atomically to disk.
	FString SerialiseConfig(const TSharedRef<FJsonObject>& Config)
	{
		FString Out;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(Config, Writer);
		return Out;
	}

	// Outcome of a single refresh, distinguished so the caller can fire
	// the right hook (ConfigChanged on a NEW config, nothing on a 304,
	// OnError on a failure). Mirrors sdk-go's fetchAndApply switch over
	// StatusFetched / StatusNotModified / default.
	enum class EUpdateOutcome : uint8
	{
		Fetched,      // a NEW config.json landed — fire OnConfigChanged.
		NotModified,  // 304 — config unchanged, no hook.
		Failed,       // fetch/parse/transport failure — fire OnError.
		LocalOnly,    // LocalOnly overrides — nothing to fetch, success, no hook.
		Refused,      // closed or offline — no HTTP, failure, no hook.
	};

	// The refresh's verdict, the old `bool ForceRefresh()` return: the
	// config is current (fetched, unchanged, or LocalOnly needs none).
	bool IsSuccess(EUpdateOutcome Outcome)
	{
		return Outcome == EUpdateOutcome::Fetched || Outcome == EUpdateOutcome::NotModified
			|| Outcome == EUpdateOutcome::LocalOnly;
	}

	// The fixed refusal reasons a refresh can report without fetching.
	constexpr const TCHAR* ClientClosed = TEXT("CLIENT_CLOSED");
	// The UObject was never built through `Create` / `Builder` (e.g. a bare
	// NewObject), so it has no fetcher at all.
	constexpr const TCHAR* ClientNotInitialized = TEXT("CLIENT_NOT_INITIALIZED");
}

struct UConfeatureClient::FUpdateResult
{
	EUpdateOutcome Outcome = EUpdateOutcome::Failed;
	// Setting keys (the `f` map keys) of the newly-fetched config —
	// populated only on the Fetched path, carried into the
	// OnConfigChanged settings wrapper.
	TArray<FString> SettingKeys;
	// Stringly-typed failure reason (never carries the raw SDK key) —
	// populated on the Failed and Refused paths, carried into OnError
	// (Failed only) and the refresh result.
	FString Error;
};

namespace
{
	using FUpdateResult = UConfeatureClient::FUpdateResult;

	// The caller-facing outcome of a refresh — the one place an update
	// becomes an FConfeatureRefreshResult.
	FConfeatureRefreshResult MakeRefreshResult(const FUpdateResult& Update)
	{
		FConfeatureRefreshResult Result;
		Result.bSuccess = IsSuccess(Update.Outcome);
		Result.ErrorMessage = Result.bSuccess ? FString() : Update.Error;
		return Result;
	}

	FUpdateResult Refused(const TCHAR* Reason)
	{
		FUpdateResult Out;
		Out.Outcome = EUpdateOutcome::Refused;
		Out.Error = Reason;
		return Out;
	}

	// A refresh that finishes after Close() is void (#832 review): no hook,
	// CLIENT_CLOSED — whatever the fetch did, and whether or not the client
	// UObject still exists.
	FUpdateResult VoidIfClosed(const UConfeatureClient::FImpl* Impl, const FUpdateResult& Update)
	{
		const bool bVoid = Impl != nullptr && Impl->bClosed && Update.Outcome != EUpdateOutcome::Refused;
		return bVoid ? Refused(ClientClosed) : Update;
	}

	// Extracts the setting keys (`f` map keys) from a parsed config so the
	// OnConfigChanged settings wrapper can surface "what changed" without
	// re-parsing. Tolerant of a missing/!object `f` field.
	TArray<FString> ExtractSettingKeys(const TSharedRef<FJsonObject>& Config)
	{
		TArray<FString> Keys;
		const TSharedPtr<FJsonObject>* Flags = nullptr;
		if (Config->TryGetObjectField(TEXT("f"), Flags) && Flags && Flags->IsValid())
		{
			(*Flags)->Values.GetKeys(Keys);
		}
		return Keys;
	}

	// Drives a single synchronous fetch + cache update. Returns the typed
	// outcome so the caller can fire the matching hook. Pure helper — no
	// UObject mutation; the caller routes the updated config back into
	// `Impl.CachedConfig` under the lock (already done here) and owns the
	// game-thread hook broadcast.
	FUpdateResult FetchAndUpdate(UConfeatureClient::FImpl& Impl)
	{
		FUpdateResult Out;
		if (!Impl.Fetcher.IsValid())
		{
			Out.Outcome = EUpdateOutcome::Failed;
			Out.Error = TEXT("fetcher unavailable");
			return Out;
		}
		FString PrevETag;
		{
			FScopeLock Guard(&Impl.ConfigMutex);
			PrevETag = Impl.CachedETag;
		}
		const FFetchResult Result = Impl.Fetcher->FetchSync(PrevETag);
		if (Result.Status == EFetchStatus::NotModified)
		{
			Out.Outcome = EUpdateOutcome::NotModified;
			return Out;
		}
		if (Result.Status != EFetchStatus::Fetched || !Result.Body.IsValid())
		{
			Out.Outcome = EUpdateOutcome::Failed;
			Out.Error = Result.Error.IsEmpty() ? FString(TEXT("fetch failed")) : Result.Error;
			return Out;
		}
		{
			// A refresh still in flight when Close() ran writes nothing
			// (#832 review): Close() flips the flag under this same lock.
			FScopeLock Write(&Impl.WriteMutex);
			if (Impl.bClosed)
			{
				return Refused(ClientClosed);
			}
			{
				FScopeLock Guard(&Impl.ConfigMutex);
				Impl.CachedConfig = Result.Body;
				Impl.CachedETag = Result.ETag;
			}
			if (Impl.Cache.IsValid())
			{
				const FString Tail = CacheKeyTail(DeriveCacheKey(Impl.SdkKey));
				Impl.Cache->Write(Tail, SerialiseConfig(Result.Body.ToSharedRef()));
			}
		}
		Out.Outcome = EUpdateOutcome::Fetched;
		Out.SettingKeys = ExtractSettingKeys(Result.Body.ToSharedRef());
		return Out;
	}

	// The states that fetch nothing — closed, LocalOnly, offline, in that
	// order (as before #832). True when `Out` holds the outcome; cheap and
	// lock-free, so callers resolve them on their own thread.
	bool TryResolveWithoutFetch(const UConfeatureClient::FImpl& Impl, FUpdateResult& Out)
	{
		if (Impl.bClosed)
		{
			Out = Refused(ClientClosed);
			return true;
		}
		if (Impl.bHasOverrides && Impl.Overrides.Behaviour == EConfeatureOverrideBehaviour::LocalOnly)
		{
			Out.Outcome = EUpdateOutcome::LocalOnly;
			return true;
		}
		if (Impl.bOffline)
		{
			// Spec 102 / #267 — no HTTP while offline. ConfigCat cpp-sdk's
			// forceRefresh reason, verbatim.
			Out = Refused(TEXT("Client is in offline mode, it cannot initiate HTTP calls."));
			return true;
		}
		return false;
	}

	// One refresh, start to finish, on the calling thread. Fires no hook.
	FUpdateResult RefreshNow(UConfeatureClient::FImpl& Impl)
	{
		FUpdateResult Out;
		if (TryResolveWithoutFetch(Impl, Out))
		{
			return Out;
		}
		if (!IsInGameThread())
		{
			FScopeLock Serialised(&Impl.RefreshMutex);
			return FetchAndUpdate(Impl);
		}
		// The game thread must not block on RefreshMutex: the holder may be
		// an async refresh whose completion only this thread's HTTP ticks
		// deliver — a plain lock would deadlock (#832). It pumps instead
		// until the holder finishes; the holder's FetchSync is bounded by
		// its give-up bound, so this loop is too.
		while (!Impl.RefreshMutex.TryLock())
		{
			PumpHttpOnce();
		}
		ON_SCOPE_EXIT { Impl.RefreshMutex.Unlock(); };
		return FetchAndUpdate(Impl);
	}

	// Schedules `Work` for a later game-thread tick — never runs it inside
	// the call, even on the game thread. Dropped once the engine is
	// exiting (#832 review): the task graph may never run it, and the
	// UObjects it would touch are being torn down.
	template <typename FuncType>
	void RunOnGameThreadLater(FuncType&& Work)
	{
		if (IsEngineExitRequested())
		{
			return;
		}
		AsyncTask(ENamedThreads::GameThread, Forward<FuncType>(Work));
	}

	// Runs `Work` on the game thread now (if already there) or schedules
	// it for the next game-thread tick otherwise. UE dynamic-multicast
	// delegates + UObject wrappers (UConfeature*Wrapper) must only be
	// touched on the game thread, so every emission funnels through here.
	template <typename FuncType>
	void RunOnGameThread(FuncType&& Work)
	{
		if (IsInGameThread())
		{
			Work();
		}
		else
		{
			RunOnGameThreadLater(Forward<FuncType>(Work));
		}
	}
}

// ---------------------------------------------------------------------
// FConfeatureClientBuilder
// ---------------------------------------------------------------------

FConfeatureClientBuilder::FConfeatureClientBuilder(FString InSdkKey)
	: SdkKey(MoveTemp(InSdkKey))
{
}

FConfeatureClientBuilder& FConfeatureClientBuilder::PollingMode(
	const FConfeaturePollingModeConfig& InMode)
{
	PollingModeConfig = InMode;
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::BaseUrl(FString InUrl)
{
	CdnBaseUrl = MoveTemp(InUrl);
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::HttpTimeoutSeconds(int32 InSeconds)
{
	TimeoutSeconds = InSeconds;
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::Logger(TSharedPtr<IConfeatureLogger> InLogger)
{
	SharedLogger = MoveTemp(InLogger);
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::CacheDirectory(FString InDirectory)
{
	CacheDirectoryOverride = MoveTemp(InDirectory);
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::FlagOverrides(
	const FConfeatureFlagOverrides& InOverrides)
{
	OverridesConfig = InOverrides;
	bHasOverrides = true;
	return *this;
}

FConfeatureClientBuilder& FConfeatureClientBuilder::DefaultUser(const FConfeatureUser& InUser)
{
	DefaultUserConfig = InUser;
	bHasDefaultUser = true;
	return *this;
}

UConfeatureClient* FConfeatureClientBuilder::Build()
{
	UConfeatureClient* Client = NewObject<UConfeatureClient>();
	Client->InitializeFromBuilder(*this);
	return Client;
}

// ---------------------------------------------------------------------
// UConfeatureClient
// ---------------------------------------------------------------------

UConfeatureClient* UConfeatureClient::Create(const FString& SdkKey)
{
	FConfeatureClientBuilder Builder(SdkKey);
	return Builder.Build();
}

FConfeatureClientBuilder UConfeatureClient::Builder(FString SdkKey)
{
	return FConfeatureClientBuilder(MoveTemp(SdkKey));
}

void UConfeatureClient::InitializeFromBuilder(const FConfeatureClientBuilder& InBuilder)
{
	Impl = MakeShared<FImpl, ESPMode::ThreadSafe>();
	Impl->SdkKey = InBuilder.SdkKey;
	Impl->PollingModeConfig = InBuilder.PollingModeConfig;
	Impl->Overrides = InBuilder.OverridesConfig;
	Impl->bHasOverrides = InBuilder.bHasOverrides;
	Impl->DefaultUser = InBuilder.DefaultUserConfig;
	Impl->bHasDefaultUser = InBuilder.bHasDefaultUser;
	Impl->Logger = InBuilder.SharedLogger.IsValid() ? InBuilder.SharedLogger
												   : MakeDefaultConfeatureLogger();

	// Format check — log redacted, never abort. Mirrors the Rust / Go
	// "lenient runtime" semantics: the customer's call is still served
	// the default value on every `GetValue*`.
	if (!Confeature::Internal::IsValidConfeatureKeyFormat(Impl->SdkKey))
	{
		Impl->Logger->Warning(FString::Printf(
			TEXT("ConfeatureClient: INVALID_SDK_KEY format (sdkKey=%s)"),
			*Confeature::Internal::RedactSdkKey(Impl->SdkKey)));
	}

	Impl->Fetcher = MakeUnique<Confeature::Internal::FConfigFetcher>(
		Impl->SdkKey,
		Impl->Version,
		InBuilder.CdnBaseUrl,
		InBuilder.TimeoutSeconds,
		Impl->Logger);

	Impl->Cache = MakeUnique<Confeature::Internal::FFilesystemCache>(
		InBuilder.CacheDirectoryOverride, Impl->Logger);

	TryRestoreFromCache(*Impl);

	// OnClientReady fires once the client's first config resolution has
	// completed (here: the cache-restore attempt + LocalOnly readiness —
	// v0.1 has no eager startup fetch yet). EmitClientReady marshals to the
	// game thread, so it is delivered on the NEXT tick — after `Create` /
	// `Build` returns and the caller has had a chance to bind a listener.
	// Mirrors ConfigCat's subsystem firing OnClientReady once on init.
	EmitClientReady();
}

bool UConfeatureClient::GetValueBool(
	const FString& Key, bool DefaultValue, const FConfeatureUser& User) const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return DefaultValue;
	}

	// Wrap the default in an FJsonValue so the override-eval branch
	// can apply the canonical 7-branch type check.
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueBoolean>(DefaultValue);
	if (Impl->bHasOverrides)
	{
		const Confeature::Internal::FOverrideEvalResult Eval =
			Confeature::Internal::EvaluateOverride(&Impl->Overrides, Key, DefaultJson, &User);
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			bool Out = DefaultValue;
			if (Eval.Value->TryGetBool(Out))
			{
				return Out;
			}
			return DefaultValue;
		}
	}

	TSharedPtr<FJsonObject> Snapshot;
	{
		FScopeLock Guard(&Impl->ConfigMutex);
		Snapshot = Impl->CachedConfig;
	}
	const Confeature::Internal::FEvalResult Result = Confeature::Internal::Evaluate(
		Snapshot, Key, Confeature::Internal::FConfeatureDefaultValue::Bool(DefaultValue), &User);
	return Result.Error.IsEmpty() ? Result.BoolValue : DefaultValue;
}

FString UConfeatureClient::GetValueString(
	const FString& Key, const FString& DefaultValue, const FConfeatureUser& User) const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return DefaultValue;
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueString>(DefaultValue);
	if (Impl->bHasOverrides)
	{
		const Confeature::Internal::FOverrideEvalResult Eval =
			Confeature::Internal::EvaluateOverride(&Impl->Overrides, Key, DefaultJson, &User);
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			FString Out = DefaultValue;
			if (Eval.Value->TryGetString(Out))
			{
				return Out;
			}
			return DefaultValue;
		}
	}

	TSharedPtr<FJsonObject> Snapshot;
	{
		FScopeLock Guard(&Impl->ConfigMutex);
		Snapshot = Impl->CachedConfig;
	}
	const Confeature::Internal::FEvalResult Result = Confeature::Internal::Evaluate(
		Snapshot, Key, Confeature::Internal::FConfeatureDefaultValue::String(DefaultValue), &User);
	return Result.Error.IsEmpty() ? Result.StringValue : DefaultValue;
}

int32 UConfeatureClient::GetValueInt(
	const FString& Key, int32 DefaultValue, const FConfeatureUser& User) const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return DefaultValue;
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueNumber>(DefaultValue);
	if (Impl->bHasOverrides)
	{
		const Confeature::Internal::FOverrideEvalResult Eval =
			Confeature::Internal::EvaluateOverride(&Impl->Overrides, Key, DefaultJson, &User);
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			double Out = static_cast<double>(DefaultValue);
			if (Eval.Value->TryGetNumber(Out))
			{
				return static_cast<int32>(Out);
			}
			return DefaultValue;
		}
	}

	TSharedPtr<FJsonObject> Snapshot;
	{
		FScopeLock Guard(&Impl->ConfigMutex);
		Snapshot = Impl->CachedConfig;
	}
	const Confeature::Internal::FEvalResult Result = Confeature::Internal::Evaluate(
		Snapshot, Key, Confeature::Internal::FConfeatureDefaultValue::Int(DefaultValue), &User);
	return Result.Error.IsEmpty() ? Result.IntValue : DefaultValue;
}

float UConfeatureClient::GetValueFloat(
	const FString& Key, float DefaultValue, const FConfeatureUser& User) const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return DefaultValue;
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueNumber>(DefaultValue);
	if (Impl->bHasOverrides)
	{
		const Confeature::Internal::FOverrideEvalResult Eval =
			Confeature::Internal::EvaluateOverride(&Impl->Overrides, Key, DefaultJson, &User);
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			double Out = static_cast<double>(DefaultValue);
			if (Eval.Value->TryGetNumber(Out))
			{
				return static_cast<float>(Out);
			}
			return DefaultValue;
		}
	}

	// GetValueFloat is lossy on precision-sensitive doubles (UE float is
	// 4 bytes; the wire value is an 8-byte double). Customers who need
	// the full IEEE-754 64-bit precision should call GetValueDouble.
	TSharedPtr<FJsonObject> Snapshot;
	{
		FScopeLock Guard(&Impl->ConfigMutex);
		Snapshot = Impl->CachedConfig;
	}
	const Confeature::Internal::FEvalResult Result = Confeature::Internal::Evaluate(Snapshot, Key,
		Confeature::Internal::FConfeatureDefaultValue::Double(static_cast<double>(DefaultValue)),
		&User);
	return Result.Error.IsEmpty() ? static_cast<float>(Result.DoubleValue) : DefaultValue;
}

double UConfeatureClient::GetValueDouble(
	const FString& Key, double DefaultValue, const FConfeatureUser& User) const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return DefaultValue;
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueNumber>(DefaultValue);
	if (Impl->bHasOverrides)
	{
		const Confeature::Internal::FOverrideEvalResult Eval =
			Confeature::Internal::EvaluateOverride(&Impl->Overrides, Key, DefaultJson, &User);
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			double Out = DefaultValue;
			if (Eval.Value->TryGetNumber(Out))
			{
				return Out;
			}
			return DefaultValue;
		}
	}

	TSharedPtr<FJsonObject> Snapshot;
	{
		FScopeLock Guard(&Impl->ConfigMutex);
		Snapshot = Impl->CachedConfig;
	}
	const Confeature::Internal::FEvalResult Result = Confeature::Internal::Evaluate(
		Snapshot, Key, Confeature::Internal::FConfeatureDefaultValue::Double(DefaultValue), &User);
	return Result.Error.IsEmpty() ? Result.DoubleValue : DefaultValue;
}

namespace
{
	using namespace Confeature::Internal;

	// Shared details resolver — mirrors the sdk-cpp `Snapshot::resolveJsonDetails`
	// (apps/sdk-cpp/src/snapshot.cpp). Resolves `Key` against the override +
	// cache branches and returns the evaluator's full `FEvalResult` (value slot,
	// error code, AND variationId). The DefaultJson is only used to drive the
	// override-eval 7-branch type-check; the typed `Default` drives the cache /
	// full-config evaluator path.
	//
	// VariationId propagation (spec 152 / #475 US2, the #395 gap class):
	//   - full-config override → routes through the real evaluator, so the
	//     variationId the evaluator computed propagates (EvaluateOverride now
	//     carries it on FOverrideEvalResult.VariationId).
	//   - flat-map (value-only) override → no variationId (upstream parity).
	//   - cache branch → the evaluator returns the variationId directly.
	FEvalResult ResolveDetails(const UConfeatureClient::FImpl& Impl, const FString& Key,
		const TSharedRef<FJsonValue>& DefaultJson, const FConfeatureDefaultValue& Default,
		const FConfeatureUser& User)
	{
		// Override branch first. EvaluateOverride dispatches on the source TYPE:
		// a full-config source routes through the real evaluator (variationId
		// propagated), the value-only map keeps the flat-map path (no
		// variationId — upstream parity).
		if (Impl.bHasOverrides)
		{
			const FOverrideEvalResult Eval
				= EvaluateOverride(&Impl.Overrides, Key, DefaultJson, &User);
			if (Eval.bResolved)
			{
				FEvalResult Out;
				Out.ResolvedType = Default.Kind;
				// Reconstruct the typed slot from the resolved FJsonValue. On a
				// miss the override-eval already returned the default JSON, so the
				// slot lands on the caller's default — matching the value-only
				// path's value-only semantics.
				if (Eval.Value.IsValid())
				{
					switch (Default.Kind)
					{
						case SettingTypeBool:
						{
							bool V = Default.BoolValue;
							Eval.Value->TryGetBool(V);
							Out.BoolValue = V;
							break;
						}
						case SettingTypeString:
						{
							FString V = Default.StringValue;
							Eval.Value->TryGetString(V);
							Out.StringValue = V;
							break;
						}
						case SettingTypeInt:
						{
							double V = static_cast<double>(Default.IntValue);
							Eval.Value->TryGetNumber(V);
							Out.IntValue = static_cast<int32>(V);
							break;
						}
						case SettingTypeDouble:
						default:
						{
							double V = Default.DoubleValue;
							Eval.Value->TryGetNumber(V);
							Out.DoubleValue = V;
							break;
						}
					}
				}
				Out.VariationId = Eval.VariationId;
				return Out;
			}
		}

		// Cache branch — the evaluator returns the variationId + error code.
		TSharedPtr<FJsonObject> Snapshot;
		{
			FScopeLock Guard(&Impl.ConfigMutex);
			Snapshot = Impl.CachedConfig;
		}
		return Evaluate(Snapshot, Key, Default, &User);
	}

	// Packs a resolved FEvalResult into the public details envelope. Mirrors
	// the sdk-cpp `Snapshot::getValueDetails<T>` packing.
	FConfeatureEvaluationDetails MakeDetails(const FString& Key, const FConfeatureUser& User,
		const FEvalResult& Result, const FConfeatureDefaultValue& Default)
	{
		FConfeatureEvaluationDetails Details;
		Details.Key = Key;
		Details.User = User;

		// Seed every slot with the default so an unused slot is the supplied
		// default (mirrors EvaluationDetails<T>::value = defaultValue on the
		// non-active slots).
		Details.bValue = Default.BoolValue;
		Details.StringValue = Default.StringValue;
		Details.IntValue = Default.IntValue;
		Details.DoubleValue = Default.DoubleValue;

		if (!Result.Error.IsEmpty())
		{
			Details.bIsDefaultValue = true;
			Details.Error = Result.Error;
			return Details;
		}

		Details.bIsDefaultValue = false;
		switch (Default.Kind)
		{
			case SettingTypeBool:
				Details.bValue = Result.BoolValue;
				break;
			case SettingTypeString:
				Details.StringValue = Result.StringValue;
				break;
			case SettingTypeInt:
				Details.IntValue = Result.IntValue;
				break;
			case SettingTypeDouble:
			default:
				Details.DoubleValue = Result.DoubleValue;
				break;
		}
		if (!Result.VariationId.IsEmpty())
		{
			Details.VariationId = Result.VariationId;
			Details.bHasVariationId = true;
		}
		return Details;
	}
}

FConfeatureEvaluationDetails UConfeatureClient::GetValueDetailsBool(
	const FString& Key, bool DefaultValue, const FConfeatureUser& User) const
{
	const FConfeatureDefaultValue Default
		= Confeature::Internal::FConfeatureDefaultValue::Bool(DefaultValue);
	if (!Impl.IsValid() || Impl->bClosed)
	{
		FEvalResult Closed;
		Closed.Error = TEXT("CLIENT_CLOSED");
		return MakeDetails(Key, User, Closed, Default);
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueBoolean>(DefaultValue);
	const FEvalResult Result = ResolveDetails(*Impl, Key, DefaultJson, Default, User);
	const FConfeatureEvaluationDetails Details = MakeDetails(Key, User, Result, Default);
	EmitFlagEvaluated(Details);
	return Details;
}

FConfeatureEvaluationDetails UConfeatureClient::GetValueDetailsString(
	const FString& Key, const FString& DefaultValue, const FConfeatureUser& User) const
{
	const FConfeatureDefaultValue Default
		= Confeature::Internal::FConfeatureDefaultValue::String(DefaultValue);
	if (!Impl.IsValid() || Impl->bClosed)
	{
		FEvalResult Closed;
		Closed.Error = TEXT("CLIENT_CLOSED");
		return MakeDetails(Key, User, Closed, Default);
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueString>(DefaultValue);
	const FEvalResult Result = ResolveDetails(*Impl, Key, DefaultJson, Default, User);
	const FConfeatureEvaluationDetails Details = MakeDetails(Key, User, Result, Default);
	EmitFlagEvaluated(Details);
	return Details;
}

FConfeatureEvaluationDetails UConfeatureClient::GetValueDetailsInt(
	const FString& Key, int32 DefaultValue, const FConfeatureUser& User) const
{
	const FConfeatureDefaultValue Default
		= Confeature::Internal::FConfeatureDefaultValue::Int(DefaultValue);
	if (!Impl.IsValid() || Impl->bClosed)
	{
		FEvalResult Closed;
		Closed.Error = TEXT("CLIENT_CLOSED");
		return MakeDetails(Key, User, Closed, Default);
	}
	const TSharedRef<FJsonValue> DefaultJson
		= MakeShared<FJsonValueNumber>(static_cast<double>(DefaultValue));
	const FEvalResult Result = ResolveDetails(*Impl, Key, DefaultJson, Default, User);
	const FConfeatureEvaluationDetails Details = MakeDetails(Key, User, Result, Default);
	EmitFlagEvaluated(Details);
	return Details;
}

FConfeatureEvaluationDetails UConfeatureClient::GetValueDetailsDouble(
	const FString& Key, double DefaultValue, const FConfeatureUser& User) const
{
	const FConfeatureDefaultValue Default
		= Confeature::Internal::FConfeatureDefaultValue::Double(DefaultValue);
	if (!Impl.IsValid() || Impl->bClosed)
	{
		FEvalResult Closed;
		Closed.Error = TEXT("CLIENT_CLOSED");
		return MakeDetails(Key, User, Closed, Default);
	}
	const TSharedRef<FJsonValue> DefaultJson = MakeShared<FJsonValueNumber>(DefaultValue);
	const FEvalResult Result = ResolveDetails(*Impl, Key, DefaultJson, Default, User);
	const FConfeatureEvaluationDetails Details = MakeDetails(Key, User, Result, Default);
	EmitFlagEvaluated(Details);
	return Details;
}

// Upstream's semantics: the fetch runs on the calling thread and this
// returns when it ended and its outcome is applied. On the game thread
// FetchSync (and RefreshNow's lock) pump the HTTP manager while waiting,
// and ReportRefresh's hooks run inline, so they have fired on return.
void UConfeatureClient::ForceRefresh()
{
	if (!Impl.IsValid())
	{
		return;  // CLIENT_NOT_INITIALIZED: no fetcher, no hooks to fire
	}
	ReportRefresh(RefreshNow(*Impl));
}

void UConfeatureClient::ForceRefreshWithCallback(FConfeatureOnRefreshCompletedBp OnCompleted)
{
	ForceRefreshAsync(
		[OnCompleted](const FConfeatureRefreshResult& Result) { OnCompleted.ExecuteIfBound(Result); });
}

// The fetch runs on a thread of its own: `FetchSync` blocks it for up to
// the request timeout + 5 s, which must not hold a shared task-pool worker.
// The game thread keeps ticking the HTTP manager meanwhile, so the
// completion it delivers there is never waited on by the game thread
// itself — the #832 freeze.
//
// States that fetch nothing (closed, LocalOnly, offline) are resolved here,
// on the calling thread, without spawning. A call made while an async
// refresh runs attaches to it: one fetch, one set of hooks, every
// completion called with its outcome.
void UConfeatureClient::ForceRefreshAsync(TFunction<void(const FConfeatureRefreshResult&)> OnCompleted)
{
	if (!Impl.IsValid())
	{
		DeliverAlone(Refused(ClientNotInitialized), MoveTemp(OnCompleted));
		return;
	}
	FUpdateResult Immediate;
	if (TryResolveWithoutFetch(*Impl, Immediate))
	{
		DeliverAlone(MoveTemp(Immediate), MoveTemp(OnCompleted));
		return;
	}
	if (IsEngineExitRequested())
	{
		// Shutting down: no new fetch, and no game-thread tick left to
		// report one on.
		return;
	}
	{
		FScopeLock Guard(&Impl->WaitersMutex);
		if (OnCompleted)
		{
			Impl->Waiters.Add(MoveTemp(OnCompleted));
		}
		if (Impl->bAsyncInFlight)
		{
			return;  // attached to the refresh already running
		}
		Impl->bAsyncInFlight = true;
	}
	Async(EAsyncExecution::Thread,
		[ImplRef = Impl, WeakSelf = TWeakObjectPtr<UConfeatureClient>(this)]()
		{
			FUpdateResult Update = RefreshNow(*ImplRef);
			TArray<TFunction<void(const FConfeatureRefreshResult&)>> Attached;
			{
				FScopeLock Guard(&ImplRef->WaitersMutex);
				Attached = MoveTemp(ImplRef->Waiters);
				ImplRef->Waiters.Reset();
				ImplRef->bAsyncInFlight = false;
			}
			DeliverRefresh(WeakSelf, ImplRef, MoveTemp(Update), MoveTemp(Attached));
		});
}

void UConfeatureClient::DeliverAlone(
	FUpdateResult Update, TFunction<void(const FConfeatureRefreshResult&)> OnCompleted)
{
	TArray<TFunction<void(const FConfeatureRefreshResult&)>> Callbacks;
	if (OnCompleted)
	{
		Callbacks.Add(MoveTemp(OnCompleted));
	}
	DeliverRefresh(TWeakObjectPtr<UConfeatureClient>(this), Impl, MoveTemp(Update), MoveTemp(Callbacks));
}

// Always a later game-thread tick: hooks first (once), then each
// completion with the same outcome. `ImplRef` outlives the UObject, so the
// closed check holds even after GC.
void UConfeatureClient::DeliverRefresh(TWeakObjectPtr<UConfeatureClient> WeakSelf,
	TSharedPtr<FImpl, ESPMode::ThreadSafe> ImplRef,
	FUpdateResult Update,
	TArray<TFunction<void(const FConfeatureRefreshResult&)>> Callbacks)
{
	RunOnGameThreadLater(
		[WeakSelf, ImplRef = MoveTemp(ImplRef), Update = MoveTemp(Update), Callbacks = MoveTemp(Callbacks)]()
		{
			const FUpdateResult Final = VoidIfClosed(ImplRef.Get(), Update);
			// The client may be gone: nobody to fire hooks on, but the
			// callers still hear how their refresh ended.
			const UConfeatureClient* Self = WeakSelf.Get();
			const FConfeatureRefreshResult Result = Self ? Self->ReportRefresh(Final) : MakeRefreshResult(Final);
			for (const TFunction<void(const FConfeatureRefreshResult&)>& Callback : Callbacks)
			{
				Callback(Result);
			}
		});
}

FConfeatureRefreshResult UConfeatureClient::ReportRefresh(const FUpdateResult& InUpdate) const
{
	const FUpdateResult Update = VoidIfClosed(Impl.Get(), InUpdate);
	switch (Update.Outcome)
	{
		case EUpdateOutcome::Fetched:
			// A NEW config.json landed → fire OnConfigChanged (the FETCHED
			// path only; a 304 does NOT fire it). Mirrors sdk-go's
			// fetchAndApply StatusFetched branch.
			EmitConfigChanged(Update.SettingKeys);
			break;
		case EUpdateOutcome::Failed:
			// Fire OnError on a failed fetch — mirrors sdk-go's default
			// branch. The detail is the fetcher's stringly-typed reason
			// (never the raw SDK key).
			EmitError(TEXT("config fetch failed"), Update.Error);
			break;
		case EUpdateOutcome::NotModified:
		case EUpdateOutcome::LocalOnly:
		case EUpdateOutcome::Refused:
		default:
			// No hook: nothing changed, or (closed / offline) no fetch was
			// attempted — as before #832.
			break;
	}
	return MakeRefreshResult(Update);
}

// Spec 102 / #267 slice 14/14 — online/offline triplet. Mirrors the
// cross-SDK ConfigCat surface (setOnline / setOffline / isOffline).
void UConfeatureClient::SetOnline()
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return;
	}
	if (Impl->bHasOverrides
		&& Impl->Overrides.Behaviour == EConfeatureOverrideBehaviour::LocalOnly)
	{
		// LocalOnly never polls — the flag has no effect. Mirrors the
		// cross-SDK warning emission.
		return;
	}
	Impl->bOffline.AtomicSet(false);
}

void UConfeatureClient::SetOffline()
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return;
	}
	if (Impl->bHasOverrides
		&& Impl->Overrides.Behaviour == EConfeatureOverrideBehaviour::LocalOnly)
	{
		// Silent no-op — LocalOnly never polls.
		return;
	}
	Impl->bOffline.AtomicSet(true);
}

bool UConfeatureClient::IsOffline() const
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return true;
	}
	if (Impl->bHasOverrides
		&& Impl->Overrides.Behaviour == EConfeatureOverrideBehaviour::LocalOnly)
	{
		return true;
	}
	return Impl->bOffline;
}

void UConfeatureClient::Close()
{
	if (!Impl.IsValid())
	{
		return;
	}
	// AtomicSet returns the prior value; only the first transition to
	// `true` runs the teardown so the call is idempotent. Under WriteMutex:
	// a refresh writing now finishes first, and none writes afterwards.
	{
		FScopeLock Write(&Impl->WriteMutex);
		if (Impl->bClosed.AtomicSet(true))
		{
			return;
		}
	}
	// Stop the fetch in flight: its completion discards itself, and the
	// refresh thread blocked on it returns once the HTTP module delivers
	// the cancel (a later HTTP-manager tick) or at its give-up bound. Not
	// joined — Close() may run on the game thread, which that delivery
	// needs.
	if (Impl->Fetcher.IsValid())
	{
		Impl->Fetcher->Cancel();
	}
	// v0.1 has no AutoPoll ticker yet; once that lands its FTSTicker
	// handle is removed here too.
}

bool UConfeatureClient::IsClosed() const
{
	return Impl.IsValid() && Impl->bClosed;
}

void UConfeatureClient::BeginDestroy()
{
	Close();
	Super::BeginDestroy();
}

// ---------------------------------------------------------------------
// Hook emission helpers — paired native + Blueprint broadcast, always on
// the game thread (epic #574 / #577). Mirrors ConfigCat's Unreal SDK
// subsystem, which broadcasts each `OnX` + `OnXBp` from a single site.
// ---------------------------------------------------------------------

void UConfeatureClient::EmitClientReady() const
{
	// const_cast: the broadcast is a logically-const observable side
	// effect (the read-side details methods that fire OnFlagEvaluated are
	// const). The AsyncTask may run on a later tick, after the client was
	// garbage-collected: a raw pointer would dangle there (IsValid on freed
	// memory is undefined), so every emission captures a weak pointer and a
	// GC'd client simply no-ops.
	const TWeakObjectPtr<UConfeatureClient> WeakSelf(const_cast<UConfeatureClient*>(this));
	RunOnGameThread([WeakSelf]()
	{
		UConfeatureClient* Self = WeakSelf.Get();
		if (!IsValid(Self))
		{
			return;
		}
		Self->OnClientReady.Broadcast();
		Self->OnClientReadyBp.Broadcast();
	});
}

void UConfeatureClient::EmitConfigChanged(const TArray<FString>& SettingKeys) const
{
	const TWeakObjectPtr<UConfeatureClient> WeakSelf(const_cast<UConfeatureClient*>(this));
	RunOnGameThread([WeakSelf, SettingKeys]()
	{
		UConfeatureClient* Self = WeakSelf.Get();
		if (!IsValid(Self) || (Self->Impl.IsValid() && Self->Impl->bClosed))
		{
			return;  // a closed client fires no refresh hook (#832 review)
		}
		// The settings wrapper is a fresh transient UObject; it is rooted
		// for the duration of the synchronous broadcast (no listener may
		// retain it past the call without taking its own reference).
		UConfeatureSettingsWrapper* Wrapper = NewObject<UConfeatureSettingsWrapper>();
		Wrapper->SettingKeys = SettingKeys;
		Self->OnConfigChanged.Broadcast(Wrapper);
		Self->OnConfigChangedBp.Broadcast(Wrapper);
	});
}

void UConfeatureClient::EmitFlagEvaluated(const FConfeatureEvaluationDetails& Details) const
{
	const TWeakObjectPtr<UConfeatureClient> WeakSelf(const_cast<UConfeatureClient*>(this));
	RunOnGameThread([WeakSelf, Details]()
	{
		UConfeatureClient* Self = WeakSelf.Get();
		if (!IsValid(Self))
		{
			return;
		}
		UConfeatureEvaluationWrapper* Wrapper = NewObject<UConfeatureEvaluationWrapper>();
		Wrapper->Details = Details;
		Self->OnFlagEvaluated.Broadcast(Wrapper);
		Self->OnFlagEvaluatedBp.Broadcast(Wrapper);
	});
}

void UConfeatureClient::EmitError(const FString& Message, const FString& Detail) const
{
	const TWeakObjectPtr<UConfeatureClient> WeakSelf(const_cast<UConfeatureClient*>(this));
	RunOnGameThread([WeakSelf, Message, Detail]()
	{
		UConfeatureClient* Self = WeakSelf.Get();
		if (!IsValid(Self) || (Self->Impl.IsValid() && Self->Impl->bClosed))
		{
			return;  // a closed client fires no refresh hook (#832 review)
		}
		Self->OnError.Broadcast(Message, Detail);
		Self->OnErrorBp.Broadcast(Message, Detail);
	});
}
