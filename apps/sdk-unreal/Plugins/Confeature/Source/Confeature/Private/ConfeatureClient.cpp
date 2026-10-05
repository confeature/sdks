// SPDX-License-Identifier: MIT

#include "ConfeatureClient.h"

#include "Async/Async.h"
#include "Async/TaskGraphInterfaces.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/CriticalSection.h"
#include "HAL/PlatformAtomics.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/StrongObjectPtr.h"

#include "ConfeatureVersion.h"
#include "Internal/ConfigFetcher.h"
#include "Internal/Evaluator.h"
#include "Internal/FilesystemCache.h"
#include "Internal/OverrideEval.h"
#include "Internal/SdkKey.h"

DEFINE_LOG_CATEGORY_STATIC(LogConfeatureClient, Log, All);

// Pimpl. Holding implementation state in a `TUniquePtr<FImpl>` keeps
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

	// Outcome of a single fetch + cache update, distinguished so the
	// caller can fire the right hook (ConfigChanged on a NEW config,
	// nothing on a 304, OnError on a failure). Mirrors sdk-go's
	// fetchAndApply switch over StatusFetched / StatusNotModified / default.
	enum class EUpdateOutcome : uint8
	{
		Fetched,      // a NEW config.json landed — fire OnConfigChanged.
		NotModified,  // 304 — config unchanged, no hook.
		Failed,       // fetch/parse/transport failure — fire OnError.
	};

	struct FUpdateResult
	{
		EUpdateOutcome Outcome = EUpdateOutcome::Failed;
		// Setting keys (the `f` map keys) of the newly-fetched config —
		// populated only on the Fetched path, carried into the
		// OnConfigChanged settings wrapper.
		TArray<FString> SettingKeys;
		// Stringly-typed failure reason (never carries the raw SDK key) —
		// populated only on the Failed path, carried into OnError.
		FString Error;
	};

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
			FScopeLock Guard(&Impl.ConfigMutex);
			Impl.CachedConfig = Result.Body;
			Impl.CachedETag = Result.ETag;
		}
		if (Impl.Cache.IsValid())
		{
			const FString Tail = CacheKeyTail(DeriveCacheKey(Impl.SdkKey));
			Impl.Cache->Write(Tail, SerialiseConfig(Result.Body.ToSharedRef()));
		}
		Out.Outcome = EUpdateOutcome::Fetched;
		Out.SettingKeys = ExtractSettingKeys(Result.Body.ToSharedRef());
		return Out;
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
	Impl = MakeUnique<FImpl>();
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

bool UConfeatureClient::ForceRefresh()
{
	if (!Impl.IsValid() || Impl->bClosed)
	{
		return false;
	}
	if (Impl->bHasOverrides
		&& Impl->Overrides.Behaviour == EConfeatureOverrideBehaviour::LocalOnly)
	{
		return true;
	}
	if (Impl->bOffline)
	{
		// Spec 102 / #267 — no HTTP while offline.
		return false;
	}
	const FUpdateResult Update = FetchAndUpdate(*Impl);
	switch (Update.Outcome)
	{
		case EUpdateOutcome::Fetched:
			// A NEW config.json landed → fire OnConfigChanged (the FETCHED
			// path only; a 304 below does NOT fire it). Mirrors sdk-go's
			// fetchAndApply StatusFetched branch.
			EmitConfigChanged(Update.SettingKeys);
			return true;
		case EUpdateOutcome::NotModified:
			return true;
		case EUpdateOutcome::Failed:
		default:
			// Fire OnError on a failed fetch — mirrors sdk-go's default
			// branch. The detail is the fetcher's stringly-typed reason
			// (never the raw SDK key).
			EmitError(TEXT("config fetch failed"), Update.Error);
			return false;
	}
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
	// `true` runs the teardown so the call is idempotent.
	if (Impl->bClosed.AtomicSet(true))
	{
		return;
	}
	// v0.1 has no AutoPoll ticker yet; once that lands here we cancel
	// the FTSTicker handle + flush any pending HTTP request.
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

namespace
{
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
			AsyncTask(ENamedThreads::GameThread, Forward<FuncType>(Work));
		}
	}
}

void UConfeatureClient::EmitClientReady() const
{
	// const_cast: the broadcast is a logically-const observable side
	// effect (the read-side details methods that fire OnFlagEvaluated are
	// const). The captured `Self` is a UObject; the AsyncTask may run on a
	// later tick, but a closed/GC'd client simply no-ops via IsValid().
	UConfeatureClient* Self = const_cast<UConfeatureClient*>(this);
	RunOnGameThread([Self]()
	{
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
	UConfeatureClient* Self = const_cast<UConfeatureClient*>(this);
	RunOnGameThread([Self, SettingKeys]()
	{
		if (!IsValid(Self))
		{
			return;
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
	UConfeatureClient* Self = const_cast<UConfeatureClient*>(this);
	RunOnGameThread([Self, Details]()
	{
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
	UConfeatureClient* Self = const_cast<UConfeatureClient*>(this);
	RunOnGameThread([Self, Message, Detail]()
	{
		if (!IsValid(Self))
		{
			return;
		}
		Self->OnError.Broadcast(Message, Detail);
		Self->OnErrorBp.Broadcast(Message, Detail);
	});
}
