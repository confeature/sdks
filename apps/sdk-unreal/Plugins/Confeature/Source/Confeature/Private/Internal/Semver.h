// SPDX-License-Identifier: MIT
#pragma once

// ConfigCat-semantics semver parse + compare (spec 131, re-ported from the
// corpus-verified C++ port `apps/sdk-cpp/src/internal/semver.cpp`, which ports
// `packages/sdk-shared/src/semver.ts`, itself a port of common-js `Semver.ts`).
// Deliberately NOT a third-party library — the loose-parse + precedence edge
// cases would otherwise fail the vendored `testmatrix_semantic*` rows.
//
// Key behaviours:
//   - Strict (non-loose) FULL grammar: v?MAJOR.MINOR.PATCH(-pre)?(+build)?,
//     each core component `0|[1-9]\d*`. Optional leading `v`.
//   - Parse on trim. Unparseable → invalid (bIsValid == false), never throws.
//   - Precedence: numeric major.minor.patch; a version WITHOUT a pre-release
//     ranks HIGHER than one WITH; pre-release ids compared field-by-field
//     (numeric < alphanumeric; more fields rank higher); build metadata
//     ignored.

#include "CoreMinimal.h"

namespace Confeature::Internal
{
	class FSemVer
	{
	public:
		// Parse `Version` under ConfigCat's strict grammar. The returned
		// FSemVer is valid (bIsValid == true) only on success; on any failure
		// (length, grammar, out-of-range core) it is invalid. Trims first.
		static FSemVer Parse(const FString& Version);

		bool IsValid() const { return bIsValid; }

		// Compare against `Other`: <0 lower-precedence, 0 equal, >0 higher.
		// Build metadata is ignored.
		int32 Compare(const FSemVer& Other) const;

	private:
		FSemVer() = default;

		// A pre-release identifier: either a numeric value (bNumeric == true)
		// or an alphanumeric string. Mirrors the TS number|string union.
		struct FIdentifier
		{
			bool bNumeric = false;
			uint64 Num = 0;
			FString Str;
		};

		bool bIsValid = false;
		FString Canonical;
		uint64 Major = 0;
		uint64 Minor = 0;
		uint64 Patch = 0;
		TArray<FIdentifier> Prerelease;

		int32 CompareMain(const FSemVer& Other) const;
		int32 ComparePre(const FSemVer& Other) const;
	};
}
