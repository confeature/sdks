// SPDX-License-Identifier: MIT
#pragma once

// Polling-mode descriptor mirroring ConfigCat-cpp's `PollingMode`
// tagged union, adapted to a USTRUCT(BlueprintType) carrier so the
// three canonical variants (`AutoPoll`, `LazyLoad`, `ManualPoll`) are
// constructible from Blueprint.
//
// The polling-service implementation lives in `Private/ConfeatureClient.cpp`
// — v0.1 fetches on startup + force-refresh only; AutoPoll's
// `FTSTicker` cadence implementation is wired in `Phase 2`.

#include "CoreMinimal.h"

#include "ConfeaturePollingMode.generated.h"

UENUM(BlueprintType)
enum class EConfeaturePollingMode : uint8
{
	// Background ticker fetches every `IntervalSeconds`. Default 60 s.
	AutoPoll = 0 UMETA(DisplayName = "AutoPoll"),
	// First `GetValue*` after `CacheTtlSeconds` triggers a fetch.
	LazyLoad = 1 UMETA(DisplayName = "LazyLoad"),
	// Customer must call `ForceRefresh` explicitly.
	ManualPoll = 2 UMETA(DisplayName = "ManualPoll"),
};

USTRUCT(BlueprintType)
struct CONFEATURE_API FConfeaturePollingModeConfig
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	EConfeaturePollingMode Kind = EConfeaturePollingMode::AutoPoll;

	// AutoPoll: cadence between ticks. LazyLoad: cache TTL before a
	// `GetValue*` triggers a fresh fetch. Ignored by ManualPoll.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature", meta = (ClampMin = "1"))
	int32 IntervalSeconds = 60;

	// AutoPoll only: how long `FConfeatureClient::Create` waits for
	// the very first fetch before returning. Tests + tools that don't
	// want to block can set this to 0.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature", meta = (ClampMin = "0"))
	int32 MaxInitWaitSeconds = 5;

	static FConfeaturePollingModeConfig AutoPollMode(
		int32 InIntervalSeconds = 60, int32 InMaxInitWaitSeconds = 5)
	{
		FConfeaturePollingModeConfig Cfg;
		Cfg.Kind = EConfeaturePollingMode::AutoPoll;
		Cfg.IntervalSeconds = InIntervalSeconds;
		Cfg.MaxInitWaitSeconds = InMaxInitWaitSeconds;
		return Cfg;
	}

	static FConfeaturePollingModeConfig LazyLoadMode(int32 InCacheTtlSeconds = 60)
	{
		FConfeaturePollingModeConfig Cfg;
		Cfg.Kind = EConfeaturePollingMode::LazyLoad;
		Cfg.IntervalSeconds = InCacheTtlSeconds;
		return Cfg;
	}

	static FConfeaturePollingModeConfig ManualPollMode()
	{
		FConfeaturePollingModeConfig Cfg;
		Cfg.Kind = EConfeaturePollingMode::ManualPoll;
		return Cfg;
	}
};
