// SPDX-License-Identifier: MIT
#pragma once

// Logging façade mirroring ConfigCat-cpp's `ILogger`. Default impl
// (`FConfeatureUELogger` in `Private/ConfeatureLogger.cpp`) routes to
// the `LogConfeature` UE_LOG category — visible in the editor log
// pane + `~/Logs/<Project>/<Project>.log`.
//
// SECURITY (FR-013): the raw SDK key NEVER appears in log payloads;
// every site that needs to reference a key routes through
// `Confeature::Internal::RedactSdkKey` first.

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureLogger.generated.h"

// Numeric ordering matches ConfigCat-cpp's `LogLevel` so customer
// filters port byte-for-byte from C++ code.
UENUM(BlueprintType)
enum class EConfeatureLogLevel : uint8
{
	Debug = 0 UMETA(DisplayName = "Debug"),
	Info = 1 UMETA(DisplayName = "Info"),
	Warning = 2 UMETA(DisplayName = "Warning"),
	Error = 3 UMETA(DisplayName = "Error"),
	Off = 4 UMETA(DisplayName = "Off"),
};

// Abstract logger contract. Customer subclasses override `Log` to
// route SDK messages anywhere (in-game console, telemetry pipeline,
// etc.). Thread-safety is the implementation's responsibility — the
// SDK's polling thread may invoke `Log` concurrently with main-thread
// `GetValue` calls.
class CONFEATURE_API IConfeatureLogger
{
public:
	virtual ~IConfeatureLogger() = default;
	virtual void Log(EConfeatureLogLevel Level, const FString& Message) = 0;

	void Debug(const FString& Message) { Log(EConfeatureLogLevel::Debug, Message); }
	void Info(const FString& Message) { Log(EConfeatureLogLevel::Info, Message); }
	void Warning(const FString& Message) { Log(EConfeatureLogLevel::Warning, Message); }
	void Error(const FString& Message) { Log(EConfeatureLogLevel::Error, Message); }
};

// Returns a shared default logger that forwards to `UE_LOG(LogConfeature, ...)`
// with `Level >= Cutoff` filtering. Caller may swap their own
// `IConfeatureLogger` via `FConfeatureClientBuilder::Logger(...)`.
CONFEATURE_API TSharedRef<IConfeatureLogger> MakeDefaultConfeatureLogger(
	EConfeatureLogLevel Cutoff = EConfeatureLogLevel::Error);
