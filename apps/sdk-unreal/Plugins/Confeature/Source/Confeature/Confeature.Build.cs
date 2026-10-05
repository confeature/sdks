// SPDX-License-Identifier: MIT

// UnrealBuildTool descriptor for the Confeature runtime module.
//
// Module layout:
//   - Public/   — customer-facing UCLASS / USTRUCT / UENUM headers.
//   - Private/  — implementation + Internal/ pure-domain helpers
//                 (SdkKey, OverrideEval, Evaluator, ConfigFetcher,
//                 FilesystemCache) + Tests/ Automation suites.
//
// Dependencies are limited to the UE stdlib per FR-003 — no third-party
// SDK deps in the .uplugin or here. `HTTP` provides FHttpModule for
// the CDN fetch; `Json` + `JsonUtilities` provide FJsonSerializer for
// config_v6.json parsing; `Core` exposes FSHA256 (Misc/SecureHash.h)
// + FBase64 (Misc/Base64.h) which we use for the cache-key pipeline.

using UnrealBuildTool;

public class Confeature : ModuleRules
{
	public Confeature(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageType.UseExplicitOrSharedPCHs;
		// UE 5.3 defaults to C++17. We pin it explicitly so future UE
		// engine bumps don't silently shift the language standard
		// under us.
		CppStandard = CppStandardVersion.Cpp17;
		bUseUnity = false;

		PublicIncludePaths.AddRange(
			new string[]
			{
				// Empty — Public/ is added implicitly by UBT.
			}
		);

		PrivateIncludePaths.AddRange(
			new string[]
			{
				// Empty — Private/ is added implicitly by UBT.
			}
		);

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
				"HTTP",
				"Json",
				"JsonUtilities",
			}
		);

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				// All deps are public — Confeature's headers expose
				// FString / TMap / UCLASS types that depend on Core +
				// CoreUObject directly.
			}
		);

		DynamicallyLoadedModuleNames.AddRange(
			new string[]
			{
				// No deferred module loads in v0.1.
			}
		);
	}
}
