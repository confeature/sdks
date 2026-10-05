// SPDX-License-Identifier: MIT
#pragma once

// Helpers shared by the Automation test suite to locate the canonical
// parity-corpus fixtures at
//   `packages/test-fixtures-sdk-parity/fixtures/*.json`.
//
// UE Automation tests run with the working directory anchored at the
// game / engine root, which is *not* the repo root when the plugin is
// dropped into a customer project. We walk up from `FPaths::ProjectDir()`
// (or the engine plugin directory) looking for the `packages/` sentinel
// — if it's absent (e.g. customer project consuming the plugin in
// isolation) we skip the parity tests rather than fail.

#include "CoreMinimal.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"

namespace Confeature::Tests
{
	// Returns the absolute path to `packages/test-fixtures-sdk-parity/fixtures/`
	// or the empty string when the fixtures cannot be located (e.g. the
	// plugin is consumed from a customer project that has no parity
	// corpus checked in).
	inline FString FindFixturesDirectory()
	{
		// Walk up from ProjectDir() looking for the sentinel. Cap at 8
		// hops so a runaway loop is impossible.
		FString Cursor = FPaths::ProjectDir();
		IFileManager& Files = IFileManager::Get();
		for (int32 Hop = 0; Hop < 8; ++Hop)
		{
			const FString Candidate = FPaths::Combine(
				Cursor, TEXT("packages"), TEXT("test-fixtures-sdk-parity"), TEXT("fixtures"));
			if (Files.DirectoryExists(*Candidate))
			{
				return Candidate;
			}
			const FString Parent = FPaths::GetPath(Cursor);
			if (Parent == Cursor || Parent.IsEmpty())
			{
				break;
			}
			Cursor = Parent;
		}
		return FString();
	}

	// Returns the absolute path to
	// `packages/test-fixtures-sdk-parity/fixtures/upstream/` (the vendored
	// ConfigCat evaluation corpus — spec 130 / spec 131), or the empty
	// string when the fixtures cannot be located. Built on top of
	// FindFixturesDirectory() so the same "walk up to the `packages/`
	// sentinel" logic + graceful-skip semantics apply.
	inline FString FindUpstreamFixturesDirectory()
	{
		const FString FixturesDir = FindFixturesDirectory();
		if (FixturesDir.IsEmpty())
		{
			return FString();
		}
		const FString Candidate = FPaths::Combine(FixturesDir, TEXT("upstream"));
		if (IFileManager::Get().DirectoryExists(*Candidate))
		{
			return Candidate;
		}
		return FString();
	}

	// The PARSED path of an absolute URL (`scheme://authority/path?query`)
	// or of an HTTP/1.1 request target (`/path?query`): query and fragment
	// excluded, percent-escapes kept as sent. Path pins (#803 FR-004)
	// compare this, never the full URL string, so a query such as #807's
	// version carrier cannot break them.
	inline FString ParsedUrlPath(const FString& UrlOrTarget)
	{
		FString Rest = UrlOrTarget;
		const int32 Scheme = Rest.Find(TEXT("://"), ESearchCase::CaseSensitive);
		if (Scheme != INDEX_NONE)
		{
			Rest.RightChopInline(Scheme + 3);
			int32 Slash = INDEX_NONE;
			if (!Rest.FindChar(TEXT('/'), Slash))
			{
				return TEXT("/");
			}
			Rest.RightChopInline(Slash);
		}
		int32 Cut = INDEX_NONE;
		if (Rest.FindChar(TEXT('?'), Cut))
		{
			Rest.LeftInline(Cut);
		}
		if (Rest.FindChar(TEXT('#'), Cut))
		{
			Rest.LeftInline(Cut);
		}
		return Rest;
	}
}
