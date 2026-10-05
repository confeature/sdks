// SPDX-License-Identifier: MIT
#pragma once

// HTTP wrapper around UE's `FHttpModule` for the Confeature CDN.
//
// Responsibilities:
//   - User-Agent: `confeature-unreal-sdk/{VERSION}` (FR-012).
//   - `If-None-Match` support for 304 reuse (FR-011).
//   - Configurable request timeout (default 30 s).
//   - SDK key redaction in EVERY log line + error message (FR-013).
//   - Fixed, key-free failure reasons (#803 FR-002): the URL holds the
//     SDK key, so no HTTP-library text (which may quote the URL) ever
//     reaches a log line or `FFetchResult::Error`.
//
// UE's HTTP module is inherently asynchronous (`OnProcessRequestComplete`
// delegate). For the synchronous customer-facing `ForceRefresh` path we
// block on a `FEvent` from the calling thread; AutoPoll uses the async
// delegate directly so its tick doesn't stall.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HttpFwd.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureLogger.h"

#include <atomic>

class IHttpRequest;  // HttpFwd.h declares it too; FFetchTestHooks names it

namespace Confeature::Internal
{
	inline constexpr const TCHAR* DefaultBaseUrl = TEXT("https://cdn-global.confeature.io");
	inline constexpr int32 DefaultTimeoutSeconds = 30;

	enum class EFetchStatus : uint8
	{
		Fetched,
		NotModified,
		Failed,
	};

	struct FFetchResult
	{
		EFetchStatus Status = EFetchStatus::Failed;
		TSharedPtr<FJsonObject> Body;
		FString ETag;
		// One of the fixed reason codes below, or `HTTP <status>` —
		// never library text, never the SDK key (#803 FR-002).
		FString Error;
	};

	// The fixed failure reasons `FFetchResult::Error` carries. Mirrors
	// sdk-go's `classifyError` (apps/sdk-go/internal/configfetcher/fetcher.go).
	namespace FetchError
	{
		// The key cannot be fetched: empty, `.` or `..` (#803 FR-001).
		inline constexpr const TCHAR* InvalidSdkKey = TEXT("INVALID_SDK_KEY");
		// Connection, TLS, redirect or truncated-body failure.
		inline constexpr const TCHAR* TransportFailed = TEXT("HTTP request failed");
		// The HTTP module's own request timeout fired.
		inline constexpr const TCHAR* RequestTimedOut = TEXT("HTTP request timed out");
		// The completion delegate never fired within timeout + slack.
		inline constexpr const TCHAR* CompletionTimedOut = TEXT("Timed out waiting for HTTP completion");
		inline constexpr const TCHAR* NotStarted = TEXT("ProcessRequest returned false");
		inline constexpr const TCHAR* MalformedBody = TEXT("Malformed config_v6.json");
	}

	// Escapes one URL path segment exactly as Go's `url.PathEscape`:
	// UTF-8 bytes outside `[A-Za-z0-9-_.~$&+:=@]` become `%XX`
	// (uppercase hex) — so `/`, `?`, `;`, `,`, `%` and spaces are escaped.
	// The UTF-8 is that of each CODE POINT: where TCHAR is UTF-16, a
	// surrogate pair (e.g. U+1F600) is one code point, `%F0%9F%98%80`.
	CONFEATURE_API FString EscapePathSegment(const FString& Segment);

	// Builds the config URL — the ONE place the SDK does so (#803 FR-001),
	// ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`:
	//   - every trailing `/` of `BaseUrl` is dropped (sdk-go's TrimRight);
	//   - a key of the shared shape (`IsValidConfeatureKeyFormat`) goes in
	//     RAW, as ConfigCat's SDKs send it: split on `/`, each part
	//     segment-escaped (a no-op for a valid key);
	//   - any other key is escaped into ONE segment;
	//   - returns an EMPTY string when the key cannot be fetched (empty,
	//     `.` or `..` — no escaper keeps those inside their segment).
	CONFEATURE_API FString BuildConfigUrl(const FString& BaseUrl, const FString& SdkKey);

	// What became of each run of a fetcher's HTTP-completion delegate.
	// Exactly one of {the completion, FetchSync giving up} claims a fetch's
	// result; a completion that loses (it arrives after the give-up, e.g.
	// the cancelled request's own completion) is DISCARDED: it writes no
	// result and logs nothing. The wire suite reads these counts to prove
	// a late completion really ran and really did nothing.
	struct FCompletionCounts
	{
		std::atomic<int32> Applied{0};
		std::atomic<int32> Discarded{0};
	};

	// Test seams for the result claim's two LOSING branches, which no real
	// backend reaches on demand. Production never sets them: an unset hook
	// leaves `FetchSync` exactly as it is without it (one null check each).
	struct FFetchTestHooks
	{
		// Replaces `Request->ProcessRequest()`. Lets a test model a backend
		// that fires the completion delegate from inside ProcessRequest and
		// then returns false (or one that refuses without firing it).
		TFunction<bool(const TSharedRef<IHttpRequest, ESPMode::ThreadSafe>&)> ProcessRequest;
		// Runs after the bounded wait expired and BEFORE `FetchSync` tries
		// to claim the result. Lets a test hold the give-up there while the
		// completion claims first.
		TFunction<void()> AfterWaitExpired;
	};

	class CONFEATURE_API FConfigFetcher
	{
	public:
		FConfigFetcher(
			FString InSdkKey,
			FString InVersion,
			FString InBaseUrl,
			int32 InTimeoutSeconds,
			TSharedPtr<IConfeatureLogger> InLogger);

		// Returns the resolved CDN URL the fetcher targets; EMPTY when the
		// key is refused (`FetchSync` then fails with INVALID_SDK_KEY and
		// issues no request). Holds the SDK key — never log it.
		const FString& Url() const { return ResolvedUrl; }
		const FString& UserAgent() const { return UserAgentString; }

		// Issues a synchronous GET via UE's `FHttpModule`. NEVER throws;
		// failure lands in `FFetchResult{Status=Failed, Error=...}` with
		// the SDK key redacted in any log line.
		//
		// Implementation: kicks off the async request, then blocks the
		// calling thread on an `FEvent` until the OnProcessRequestComplete
		// delegate fires. Must NOT be called from the game thread when
		// the HTTP manager is also pumped from the game thread — the
		// AutoPoll worker thread is the canonical caller.
		//
		// When the completion never arrives within the give-up bound
		// (timeout + 5 s) the request is cancelled (it targets the
		// key-bearing URL) and its late completion is discarded: one
		// failure, one log line. The completion and the give-up race for
		// the result through ONE atomic claim, so a completion arriving
		// exactly at the bound either wins (its result is returned, the
		// give-up neither cancels nor logs) or loses (discarded) — never
		// both, never neither.
		FFetchResult FetchSync(const FString& PrevETag);

		// How long `FetchSync` waits for the completion before it gives up
		// and cancels; defaults to the request timeout + 5 s. The wire
		// suite sets it BELOW the request timeout, so only the cancel can
		// end the request it abandons. Non-positive values are ignored.
		void SetGiveUpSeconds(double Seconds)
		{
			if (Seconds > 0.0)
			{
				GiveUpSeconds = Seconds;
			}
		}

		// Runs of the completion delegate that claimed / lost the result
		// (see `FCompletionCounts`), across every `FetchSync` of this
		// fetcher, late ones included.
		int32 CompletionsApplied() const { return Counts->Applied.load(); }
		int32 CompletionsDiscarded() const { return Counts->Discarded.load(); }

		// Tests only (see `FFetchTestHooks`). Set before `FetchSync` runs.
		void SetTestHooks(FFetchTestHooks InHooks) { TestHooks = MoveTemp(InHooks); }

	private:
		FString SdkKey;
		FString BaseUrl;
		FString ResolvedUrl;
		FString UserAgentString;
		int32 TimeoutSeconds;
		double GiveUpSeconds;
		TSharedPtr<IConfeatureLogger> Logger;
		// Shared with every completion delegate, which may outlive both
		// `FetchSync` and this fetcher.
		TSharedRef<FCompletionCounts, ESPMode::ThreadSafe> Counts;
		FFetchTestHooks TestHooks;
	};
}
