// SPDX-License-Identifier: MIT
#pragma once

// Default config cache: writes JSON blobs under
//   `FPaths::ProjectSavedDir() / "Confeature" / "confeature-{cacheKey}.json"`
//
// `ProjectSavedDir()` resolves to `<Project>/Saved/` on every UE target
// (Editor + cooked builds on Win64 / Mac / Linux; sandboxed equivalents
// on iOS / Android). The Saved tree is always writeable and is excluded
// from cooked content + `.gitignore` by default.
//
// Atomic write: write to `<file>.tmp` then `IFileManager::Move` to the
// final path; avoids half-written reads under a concurrent reader.

#include "CoreMinimal.h"
#include "HAL/CriticalSection.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureLogger.h"

namespace Confeature::Internal
{
	class CONFEATURE_API FFilesystemCache
	{
	public:
		// `Directory` may be empty → derive from `FPaths::ProjectSavedDir()`.
		// `InLogger` is optional; nullptr disables logging.
		explicit FFilesystemCache(
			FString InDirectory, TSharedPtr<IConfeatureLogger> InLogger = nullptr);

		// Reads the cached blob for `CacheKeyTail`. Returns the empty
		// string when the file is missing or unreadable.
		FString Read(const FString& CacheKeyTail);

		// Writes `Value` atomically under `CacheKeyTail`. Creates the
		// directory tree on the first call.
		void Write(const FString& CacheKeyTail, const FString& Value);

		const FString& Directory() const { return ResolvedDirectory; }

	private:
		FString PathFor(const FString& CacheKeyTail) const;

		FString ResolvedDirectory;
		TSharedPtr<IConfeatureLogger> Logger;
		FCriticalSection Mutex;
	};

	// Resolves the default cache directory under `FPaths::ProjectSavedDir()`.
	CONFEATURE_API FString DefaultCacheDirectory();
}
