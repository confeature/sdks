// SPDX-License-Identifier: MIT
#pragma once

// Header carrying the SDK's canonical version string. Stamped into the
// outgoing User-Agent header (`confeature-unreal-sdk/{VERSION}`) and
// exposed publicly for customer-side diagnostics + Automation tests.
//
// Bumping requires a coordinated change to:
//   - apps/sdk-unreal/Plugins/Confeature/Confeature.uplugin VersionName
//   - apps/sdk-unreal/README.md install snippet

#include "CoreMinimal.h"

namespace Confeature
{
	// `static constexpr TCHAR[]` mirrors the UE idiom for string
	// literals — TCHAR-safe across Win64 / Mac / Linux / iOS / Android.
	inline static constexpr TCHAR SDK_VERSION[] = TEXT("0.1.0");
}
