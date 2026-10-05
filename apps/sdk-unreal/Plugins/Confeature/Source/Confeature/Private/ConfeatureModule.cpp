// SPDX-License-Identifier: MIT

#include "ConfeatureModule.h"

#include "Modules/ModuleManager.h"

#include "ConfeatureLogger.h"
#include "ConfeatureVersion.h"

// `LogConfeature` is the canonical UE_LOG category for this plugin.
// Customers filter the editor / packaged log pane by
//   `Log LogConfeature Verbose` to see SDK traces.
DEFINE_LOG_CATEGORY(LogConfeature);

namespace
{
	class FConfeatureModule : public IConfeatureModule
	{
	public:
		void StartupModule() override
		{
			UE_LOG(LogConfeature, Log, TEXT("Confeature SDK v%s loaded."), Confeature::SDK_VERSION);
		}

		void ShutdownModule() override
		{
			// v0.1 has no module-scoped singletons to tear down — each
			// `UConfeatureClient` owns its own ticker / cache / fetcher
			// and unwinds via `BeginDestroy()`.
		}
	};

	// Default UE_LOG-backed logger lives here so it's available without
	// pulling additional translation units into the public API.
	class FUELogConfeatureLogger : public IConfeatureLogger
	{
	public:
		explicit FUELogConfeatureLogger(EConfeatureLogLevel InCutoff)
			: Cutoff(InCutoff)
		{
		}

		void Log(EConfeatureLogLevel Level, const FString& Message) override
		{
			if (static_cast<uint8>(Level) < static_cast<uint8>(Cutoff))
			{
				return;
			}
			switch (Level)
			{
				case EConfeatureLogLevel::Debug:
					UE_LOG(LogConfeature, Verbose, TEXT("%s"), *Message);
					break;
				case EConfeatureLogLevel::Info:
					UE_LOG(LogConfeature, Log, TEXT("%s"), *Message);
					break;
				case EConfeatureLogLevel::Warning:
					UE_LOG(LogConfeature, Warning, TEXT("%s"), *Message);
					break;
				case EConfeatureLogLevel::Error:
					UE_LOG(LogConfeature, Error, TEXT("%s"), *Message);
					break;
				case EConfeatureLogLevel::Off:
				default:
					break;
			}
		}

	private:
		EConfeatureLogLevel Cutoff;
	};
}

TSharedRef<IConfeatureLogger> MakeDefaultConfeatureLogger(EConfeatureLogLevel Cutoff)
{
	return MakeShared<FUELogConfeatureLogger>(Cutoff);
}

IMPLEMENT_MODULE(FConfeatureModule, Confeature)
