// SPDX-License-Identifier: MIT
#pragma once

// `IConfeatureModule` is the UE module entry-point exposed via
// `IMPLEMENT_MODULE` in `ConfeatureModule.cpp`. The module's job in
// v0.1 is purely lifecycle:
//   - StartupModule: register the `LogConfeature` log category +
//     announce the SDK version.
//   - ShutdownModule: drop any singletons + stop background tickers.
//
// Customer code never needs to touch the module directly — the public
// surface is `UConfeatureClient` (UCLASS) + `FConfeatureUser` (USTRUCT)
// declared in their own headers.

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

CONFEATURE_API DECLARE_LOG_CATEGORY_EXTERN(LogConfeature, Log, All);

class CONFEATURE_API IConfeatureModule : public IModuleInterface
{
public:
	static IConfeatureModule& Get()
	{
		return FModuleManager::LoadModuleChecked<IConfeatureModule>(TEXT("Confeature"));
	}

	static bool IsAvailable()
	{
		return FModuleManager::Get().IsModuleLoaded(TEXT("Confeature"));
	}
};
