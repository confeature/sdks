// SPDX-License-Identifier: MIT

// Unit-level guard rails for the SDK-key pipeline. The cache-key
// fixture corpus in `CacheKeyFixturesTest.cpp` is the cross-language
// gate; this suite covers the surrounding helpers (format validation,
// redaction, tail extraction, base64url RFC 4648 vectors).

#include "Dom/JsonObject.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/ConfigFetcher.h"
#include "Internal/SdkKey.h"
#include "Tests/TestPaths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureSdkKeyTest,
	"Confeature.SdkKey.Unit",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureSdkKeyTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	// DeriveCacheKey — canonical 64-char SDK key.
	const FString Canonical =
		TEXT("confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
	TestEqual(
		TEXT("DeriveCacheKey(canonical)"),
		DeriveCacheKey(Canonical),
		TEXT("confeature:cache:v1:bIg57I9_4ya_LRRpZZ8qZdn_gXPqQ1aY"));

	// DeriveCacheKey — empty input (SHA-256 of "" — well-known digest).
	TestEqual(
		TEXT("DeriveCacheKey(empty)"),
		DeriveCacheKey(TEXT("")),
		TEXT("confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM"));

	// RedactSdkKey — must hide the secret payload.
	const FString Redacted = RedactSdkKey(Canonical);
	TestTrue(TEXT("redaction contains marker"), Redacted.Contains(TEXT("[redacted]")));
	TestFalse(
		TEXT("redaction omits secret middle"),
		Redacted.Contains(Canonical.Mid(20, 20)));

	// RedactSdkKey — a ConfigCat-shaped key (#802) contains '/'; the
	// redactor treats it as plain characters and reveals no more of the
	// secret than for a legacy key: 61 chars -> 6 visible at each end, of
	// which the head is prefix only and the tail 6 of the 44 secret chars
	// (a legacy key reveals 8 secret chars at the tail).
	const FString ConfigCatShaped =
		TEXT("configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02");
	TestEqual(
		TEXT("redact configcat-shaped"),
		RedactSdkKey(ConfigCatShaped),
		FString(TEXT("config…[redacted]…tRea02")));
	TestFalse(
		TEXT("redaction omits the first secret segment"),
		RedactSdkKey(ConfigCatShaped).Contains(TEXT("FAKEfixtureKeyNotRea01")));

	// RedactSdkKey — short / empty inputs return the marker.
	TestEqual(TEXT("redact empty"), RedactSdkKey(TEXT("")), TEXT("[redacted]"));
	TestEqual(TEXT("redact short"), RedactSdkKey(TEXT("short")), TEXT("[redacted]"));

	// IsValidConfeatureKeyFormat — canonical accept (both shapes; the
	// full shared accept/reject list runs in `Confeature.SdkKey.Shapes`).
	TestTrue(TEXT("canonical key accepted"), IsValidConfeatureKeyFormat(Canonical));
	TestTrue(TEXT("configcat-shaped key accepted"), IsValidConfeatureKeyFormat(ConfigCatShaped));
	// A non-ASCII code unit must not alias to an ASCII alphabet byte
	// (U+012D truncates to 0x2D, '-').
	FString NonAscii = ConfigCatShaped;
	NonAscii[20] = static_cast<TCHAR>(0x012D);
	TestFalse(TEXT("non-ASCII character rejected"), IsValidConfeatureKeyFormat(NonAscii));

	// IsValidConfeatureKeyFormat — rejects.
	TestFalse(TEXT("empty rejected"), IsValidConfeatureKeyFormat(TEXT("")));
	TestFalse(
		TEXT("missing-payload rejected"),
		IsValidConfeatureKeyFormat(TEXT("confeature-sdk-1-")));
	TestFalse(
		TEXT("configcat prefix with '-' separators rejected"),
		IsValidConfeatureKeyFormat(TEXT("configcat-sdk-1-test-key")));
	TestFalse(
		TEXT("half-payload rejected"),
		IsValidConfeatureKeyFormat(TEXT("confeature-sdk-1-short-half")));

	// CacheKeyTail — strips the envelope, preserves keys without colons.
	TestEqual(TEXT("tail with colon"), CacheKeyTail(TEXT("confeature:cache:v1:abc")), TEXT("abc"));
	TestEqual(TEXT("tail without colon"), CacheKeyTail(TEXT("no-colon")), TEXT("no-colon"));

	// Base64UrlEncode — RFC 4648 §10 vectors (URL-safe alphabet, no padding).
	const auto Encode = [](const ANSICHAR* Data) -> FString
	{
		const int32 Len = FCStringAnsi::Strlen(Data);
		return Base64UrlEncode(reinterpret_cast<const uint8*>(Data), Len);
	};
	TestEqual(TEXT("b64url empty"), Encode(""), TEXT(""));
	TestEqual(TEXT("b64url 'f'"), Encode("f"), TEXT("Zg"));
	TestEqual(TEXT("b64url 'fo'"), Encode("fo"), TEXT("Zm8"));
	TestEqual(TEXT("b64url 'foo'"), Encode("foo"), TEXT("Zm9v"));
	TestEqual(TEXT("b64url 'foob'"), Encode("foob"), TEXT("Zm9vYg"));
	TestEqual(TEXT("b64url 'fooba'"), Encode("fooba"), TEXT("Zm9vYmE"));
	TestEqual(TEXT("b64url 'foobar'"), Encode("foobar"), TEXT("Zm9vYmFy"));

	return true;
}

// #802 — the shared accept/reject list every Confeature SDK validator is
// tested against (never a per-SDK list): every `valid` key is accepted,
// every `invalid` key rejected.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureSdkKeyShapesTest,
	"Confeature.SdkKey.Shapes",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureSdkKeyShapesTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping SdkKey.Shapes: packages/test-fixtures-sdk-parity/fixtures not "
				 "found relative to ProjectDir(). The plugin is being consumed outside the "
				 "Confeature monorepo — run the test from a Confeature workspace checkout."));
		return true;
	}

	const FString FixturePath = FPaths::Combine(FixturesDir, TEXT("sdk-key-shapes.json"));
	FString Raw;
	if (!FFileHelper::LoadFileToString(Raw, *FixturePath))
	{
		AddError(FString::Printf(TEXT("Failed to read fixture file at %s"), *FixturePath));
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		AddError(TEXT("Failed to parse sdk-key-shapes.json"));
		return false;
	}

	const auto CheckList = [this, &Root](const TCHAR* Field, bool bExpectValid)
	{
		const TArray<TSharedPtr<FJsonValue>>* Cases = nullptr;
		if (!Root->TryGetArrayField(Field, Cases) || !Cases || Cases->Num() == 0)
		{
			// Fail closed: a missing or empty list must not pass vacuously.
			AddError(FString::Printf(TEXT("sdk-key-shapes.json: '%s' missing or empty"), Field));
			return;
		}
		for (const TSharedPtr<FJsonValue>& Entry : *Cases)
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			FString Name;
			FString Key;
			if (!Entry.IsValid() || !Entry->TryGetObject(Obj) || !Obj || !Obj->IsValid()
				|| !(*Obj)->TryGetStringField(TEXT("name"), Name)
				|| !(*Obj)->TryGetStringField(TEXT("key"), Key))
			{
				AddError(FString::Printf(
					TEXT("sdk-key-shapes.json: malformed '%s' entry — expected {name, key}"),
					Field));
				continue;
			}
			// Label by fixture name only — never echo a key into test output.
			TestTrue(
				FString::Printf(
					TEXT("%s: %s is %s"),
					Field,
					*Name,
					bExpectValid ? TEXT("accepted") : TEXT("rejected")),
				IsValidConfeatureKeyFormat(Key) == bExpectValid);
		}
	};
	CheckList(TEXT("valid"), true);
	CheckList(TEXT("invalid"), false);

	return true;
}

// #803 FR-001 / FR-004 — the config URL is ConfigCat's
// `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`, built by
// `BuildConfigUrl` alone. Pins compare the PARSED path (query excluded),
// so #807's version carrier cannot break them. The request side of the
// same rule (and "no request at all" for a refused key) runs against a
// real socket in `Confeature.Wire.*`.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureSdkKeyFetchUrlTest,
	"Confeature.SdkKey.FetchUrl",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureSdkKeyFetchUrlTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;
	using Confeature::Tests::ParsedUrlPath;

	const FString BaseUrl = TEXT("https://cdn.example.test");

	// Resolves a key's URL through the fetcher (the constructor only
	// builds the URL; no request is issued) and checks the fetcher used
	// the one URL function. Returns the parsed path, or "" when refused.
	const auto PathFor = [this, &BaseUrl](const FString& Label, const FString& Key) -> FString
	{
		const FConfigFetcher Fetcher(Key, TEXT("0.0.0-test"), BaseUrl, /*TimeoutSeconds=*/5, nullptr);
		TestEqual(
			FString::Printf(TEXT("%s: the fetcher uses BuildConfigUrl"), *Label),
			Fetcher.Url(),
			BuildConfigUrl(BaseUrl, Key));
		if (!Fetcher.Url().IsEmpty())
		{
			TestTrue(
				FString::Printf(TEXT("%s: URL is under the base URL"), *Label),
				Fetcher.Url().StartsWith(BaseUrl + TEXT("/"), ESearchCase::CaseSensitive));
		}
		return Fetcher.Url().IsEmpty() ? FString() : ParsedUrlPath(Fetcher.Url());
	};

	// A ConfigCat-shaped key travels RAW — three segments, as every
	// ConfigCat SDK sends it (configcat/cpp-sdk `src/configfetcher.cpp`).
	const FString ConfigCatKey = TEXT("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d");
	TestEqual(
		TEXT("configcat-shaped key: raw path"),
		PathFor(TEXT("configcat-shaped"), ConfigCatKey),
		FString(TEXT("/configuration-files/configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/"
					 "pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json")));

	// A legacy key is one raw segment.
	const FString LegacyKey = TEXT(
		"confeature-sdk-1-FAKE_fixtureKeyN-otRealFAKEfi-03-FAKEfixtureKeyNotRealFAKEfixtu04");
	TestEqual(
		TEXT("legacy key: raw path"),
		PathFor(TEXT("legacy"), LegacyKey),
		FString(TEXT("/configuration-files/confeature-sdk-1-FAKE_fixtureKeyN-otRealFAKEfi-03-"
					 "FAKEfixtureKeyNotRealFAKEfixtu04/config_v6.json")));

	// A malformed key is escaped into ONE segment (Go's `url.PathEscape`):
	// its '/' cannot add a segment, its ".." cannot climb, its '?' cannot
	// start a query.
	TestEqual(
		TEXT("malformed key: one escaped segment"),
		PathFor(TEXT("malformed"), TEXT("not a key/../x?y;z,%")),
		FString(TEXT("/configuration-files/not%20a%20key%2F..%2Fx%3Fy%3Bz%2C%25/config_v6.json")));
	// An invalid ConfigCat-shaped key (extra segment) is malformed too.
	TestEqual(
		TEXT("extra-segment key: one escaped segment"),
		PathFor(TEXT("extra segment"), TEXT("configcat-sdk-1/a/b/c")),
		FString(TEXT("/configuration-files/configcat-sdk-1%2Fa%2Fb%2Fc/config_v6.json")));
	// Go's PathEscape keeps `$&+:=@` and `-_.~`, escapes UTF-8 bytes.
	TestEqual(TEXT("escape keeps Go's safe set"), EscapePathSegment(TEXT("a$&+:=@-_.~Z9")),
		FString(TEXT("a$&+:=@-_.~Z9")));
	FString NonAscii;
	NonAscii.AppendChar(static_cast<TCHAR>(0x00E9));
	TestEqual(TEXT("escape non-ASCII as UTF-8"), EscapePathSegment(NonAscii), FString(TEXT("%C3%A9")));
	// Real `go run` output of url.PathEscape — the wire corpus case
	// `request-path-malformed-key` pins the same key on the wire.
	TestEqual(
		TEXT("escape matches Go url.PathEscape (literal)"),
		EscapePathSegment(TEXT("bad key$&+:=@,;!'()*~/x?y#z%..")),
		FString(TEXT("bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..")));

	// The corpus key (commit 0e011b5f) adds one non-ASCII character of each
	// UTF-8 length: U+00E9 (2 bytes), U+20AC (3) and U+1F600 (4). The
	// characters are written as universal character names so the compiler,
	// not the source-file encoding, picks their TCHAR form: U+1F600 is a
	// surrogate PAIR where TCHAR is UTF-16 (Windows, Linux) and one unit
	// where it is UTF-32. Either way it must escape as the UTF-8 bytes of
	// the ONE code point — never per UTF-16 unit (that would give the
	// CESU-8 `%ED%A0%BD%ED%B8%80`). Expected values are literal `go run`
	// output of url.PathEscape.
	const FString CorpusKey = TEXT("bad key$&+:=@,;!'()*~/x?y#z%\u00E9\u20AC\U0001F600..");
	if constexpr (sizeof(TCHAR) == 2)
	{
		TestEqual(TEXT("U+1F600 is a surrogate pair in this TCHAR"), CorpusKey.Len(), 34);
	}
	TestEqual(
		TEXT("escape matches Go url.PathEscape (corpus key, literal)"),
		EscapePathSegment(CorpusKey),
		FString(TEXT("bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80..")));
	TestEqual(
		TEXT("U+20AC escapes as its 3 UTF-8 bytes"),
		EscapePathSegment(TEXT("\u20AC")),
		FString(TEXT("%E2%82%AC")));
	TestEqual(
		TEXT("U+1F600 escapes as its 4 UTF-8 bytes"),
		EscapePathSegment(TEXT("\U0001F600")),
		FString(TEXT("%F0%9F%98%80")));
	TestEqual(
		TEXT("corpus key: request path (wire-cases request-path-malformed-key)"),
		PathFor(TEXT("corpus malformed"), CorpusKey),
		FString(TEXT("/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25"
					 "%C3%A9%E2%82%AC%F0%9F%98%80../config_v6.json")));

	// Every trailing '/' of the base URL is dropped (sdk-go's
	// `strings.TrimRight(baseURL, "/")`), never `//configuration-files`.
	for (const TCHAR* Slashed : {TEXT("https://cdn.example.test/"), TEXT("https://cdn.example.test///")})
	{
		const FConfigFetcher Fetcher(
			ConfigCatKey, TEXT("0.0.0-test"), FString(Slashed), /*TimeoutSeconds=*/5, nullptr);
		TestEqual(
			FString::Printf(TEXT("base '%s': trailing slashes dropped"), Slashed),
			Fetcher.Url(),
			FString(TEXT("https://cdn.example.test/configuration-files/configcat-sdk-1/"
						 "aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json")));
	}
	TestEqual(
		TEXT("base with a path keeps it, minus the trailing slash"),
		BuildConfigUrl(TEXT("https://proxy.example.test/cdn/"), TEXT("...")),
		FString(TEXT("https://proxy.example.test/cdn/configuration-files/.../config_v6.json")));

	// "", "." and ".." have no segment of their own: no URL, no fetch.
	for (const TCHAR* Refused : {TEXT(""), TEXT("."), TEXT("..")})
	{
		TestTrue(
			FString::Printf(TEXT("key '%s' is refused (no URL)"), Refused),
			PathFor(FString::Printf(TEXT("refused '%s'"), Refused), Refused).IsEmpty());
	}
	// "..." is malformed but keeps its segment.
	TestEqual(
		TEXT("'...' is one segment"),
		PathFor(TEXT("triple dot"), TEXT("...")),
		FString(TEXT("/configuration-files/.../config_v6.json")));

	// No `/v2/` and no cache-key tail on the wire (the tail stays a
	// local cache id).
	const FString Url = BuildConfigUrl(BaseUrl, ConfigCatKey);
	TestFalse(TEXT("no /v2/ prefix"), Url.Contains(TEXT("/v2/")));
	TestFalse(
		TEXT("no cache-key tail in the URL"),
		Url.Contains(CacheKeyTail(DeriveCacheKey(ConfigCatKey))));
	TestFalse(TEXT("URL is never double-encoded"), Url.Contains(TEXT("%25")));

	return true;
}
