// SPDX-License-Identifier: MIT

#include "Internal/FilesystemCache.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"

namespace Confeature::Internal
{
	FString DefaultCacheDirectory()
	{
		return FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Confeature"));
	}

	FFilesystemCache::FFilesystemCache(FString InDirectory, TSharedPtr<IConfeatureLogger> InLogger)
		: ResolvedDirectory(InDirectory.IsEmpty() ? DefaultCacheDirectory() : MoveTemp(InDirectory))
		, Logger(MoveTemp(InLogger))
	{
	}

	FString FFilesystemCache::PathFor(const FString& CacheKeyTail) const
	{
		return FPaths::Combine(
			ResolvedDirectory, FString::Printf(TEXT("confeature-%s.json"), *CacheKeyTail));
	}

	FString FFilesystemCache::Read(const FString& CacheKeyTail)
	{
		FScopeLock Guard(&Mutex);
		const FString Path = PathFor(CacheKeyTail);
		if (!IFileManager::Get().FileExists(*Path))
		{
			return FString();
		}
		FString Contents;
		if (!FFileHelper::LoadFileToString(Contents, *Path))
		{
			if (Logger.IsValid())
			{
				Logger->Warning(FString::Printf(
					TEXT("FilesystemCache: read failed for cacheKey=%s"), *CacheKeyTail));
			}
			return FString();
		}
		return Contents;
	}

	void FFilesystemCache::Write(const FString& CacheKeyTail, const FString& Value)
	{
		FScopeLock Guard(&Mutex);
		IFileManager& FileMgr = IFileManager::Get();
		if (!FileMgr.DirectoryExists(*ResolvedDirectory))
		{
			FileMgr.MakeDirectory(*ResolvedDirectory, /*Tree=*/true);
		}

		// Atomic write: <file>.tmp.<pid> → <file>. `IFileManager::Move`
		// is `rename(2)` on POSIX + `MoveFileEx` on Win64 — both atomic
		// on the same filesystem.
		const FString FinalPath = PathFor(CacheKeyTail);
		const FString TempPath = FString::Printf(
			TEXT("%s.tmp.%u"), *FinalPath, FPlatformProcess::GetCurrentProcessId());

		if (!FFileHelper::SaveStringToFile(
				Value, *TempPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
		{
			if (Logger.IsValid())
			{
				Logger->Warning(FString::Printf(
					TEXT("FilesystemCache: write tmp failed for cacheKey=%s"), *CacheKeyTail));
			}
			return;
		}

		if (!FileMgr.Move(*FinalPath, *TempPath))
		{
			if (Logger.IsValid())
			{
				Logger->Warning(FString::Printf(
					TEXT("FilesystemCache: rename failed for cacheKey=%s"), *CacheKeyTail));
			}
			// Best-effort cleanup of the stranded tempfile.
			FileMgr.Delete(*TempPath, /*RequireExists=*/false, /*EvenReadOnly=*/false, /*Quiet=*/true);
		}
	}
}
