// SPDX-License-Identifier: MIT

// Cross-language gate: cache-key-fixtures.json is the single source of
// truth shared by every Confeature SDK. Any drift in the SHA-256 +
// base64url + truncate-to-32 pipeline breaks Principle II.

#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/SdkKey.h"
#include "Tests/TestPaths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureCacheKeyFixturesTest,
	"Confeature.SdkKey.CacheKeyFixtures",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureCacheKeyFixturesTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping CacheKeyFixturesTest: packages/test-fixtures-sdk-parity/fixtures not "
				 "found relative to ProjectDir(). The plugin is being consumed outside the "
				 "Confeature monorepo — run the test from a Confeature workspace checkout."));
		return true;
	}

	const FString FixturePath = FPaths::Combine(FixturesDir, TEXT("cache-key-fixtures.json"));
	FString Raw;
	if (!FFileHelper::LoadFileToString(Raw, *FixturePath))
	{
		AddError(FString::Printf(TEXT("Failed to read fixture file at %s"), *FixturePath));
		return false;
	}

	// The fixture is a top-level JSON array; wrap it for the FJson
	// reader which expects an object root, or use the array overload.
	TArray<TSharedPtr<FJsonValue>> Fixtures;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
	if (!FJsonSerializer::Deserialize(Reader, Fixtures))
	{
		AddError(TEXT("Failed to parse cache-key-fixtures.json"));
		return false;
	}

	// No pinned row count — the corpus grows (#802 added a
	// `configcat-sdk-1/...` row whose `/` is hashed as plain bytes). An
	// empty corpus must still fail rather than pass vacuously.
	TestTrue(TEXT("fixture corpus is non-empty"), Fixtures.Num() > 0);

	for (const TSharedPtr<FJsonValue>& Entry : Fixtures)
	{
		const TSharedPtr<FJsonObject>* Obj = nullptr;
		if (!Entry.IsValid() || !Entry->TryGetObject(Obj) || !Obj || !Obj->IsValid())
		{
			AddError(TEXT("Malformed fixture entry — expected object"));
			continue;
		}
		FString SdkKey;
		FString Expected;
		(*Obj)->TryGetStringField(TEXT("sdkKey"), SdkKey);
		(*Obj)->TryGetStringField(TEXT("expectedCacheKey"), Expected);

		const FString Actual = DeriveCacheKey(SdkKey);
		TestEqual(
			FString::Printf(TEXT("DeriveCacheKey('%s')"), *SdkKey.Left(16)),
			Actual,
			Expected);
	}

	return true;
}
