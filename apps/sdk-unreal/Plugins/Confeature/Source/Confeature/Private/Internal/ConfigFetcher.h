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
//   - A body cap (`MaxBodyBytes`, #837): a response past it ends the fetch
//     as `body_too_large`, enforced while the body is still arriving.
//
// UE's HTTP module is inherently asynchronous (`OnProcessRequestComplete`
// delegate). `FetchSync` blocks the calling thread until that delegate
// fires: a worker thread waits on an `FEvent`; the game thread — which
// delivers the delegate — pumps the HTTP manager while it waits, as
// ConfigCat's Unreal SDK does (#832).

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HAL/CriticalSection.h"
#include "HttpFwd.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureLogger.h"

#include <atomic>

class IHttpRequest;  // HttpFwd.h declares it too; FFetchTestHooks names it
class FEvent;

namespace Confeature::Internal
{
	inline constexpr const TCHAR* DefaultBaseUrl = TEXT("https://cdn-global.confeature.io");
	inline constexpr int32 DefaultTimeoutSeconds = 30;
	// Largest response body a fetch accepts before it fails with
	// `FetchError::BodyTooLarge` (#837) — sdk-cpp's `kMaxBodyBytes`
	// (587f4905), so the C++ ports refuse the same bodies. A config_v6
	// document is kilobytes; this only bounds a hostile or broken origin,
	// proxy or redirect target. A body of exactly this size is accepted.
	inline constexpr int64 MaxBodyBytes = int64{16} * 1024 * 1024;

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
		// The response declared or delivered more than `MaxBodyBytes`.
		// sdk-cpp's fixed code, verbatim (a transport failure: the
		// fetchFailed class).
		inline constexpr const TCHAR* BodyTooLarge = TEXT("body_too_large");
		// The fetch was cancelled by `FConfigFetcher::Cancel` (the client
		// closed). Never logged.
		inline constexpr const TCHAR* Cancelled = TEXT("fetch cancelled");
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

	// The game-thread wait step, upstream's (configcat/unreal-engine-sdk
	// @ 923800268dba36ad25963dcace191179de4ba936, read 2026-10-27,
	// `ConfigCatNetworkAdapter::get`): one HTTP-manager Tick of this
	// length, then a Sleep of it.
	inline constexpr float GameThreadPumpSeconds = 0.05f;

	// One step of that pump: ticks the HTTP manager (which runs any due
	// HTTP delegate on this thread), then sleeps.
	CONFEATURE_API void PumpHttpOnce();

	// Waits up to `Seconds` for `Done`. Off the game thread a plain event
	// wait; ON it, `PumpHttpOnce` until `Done` or the deadline — the game
	// thread delivers the very completion it waits for, so a plain wait
	// there deadlocks (#832). True when `Done` fired.
	CONFEATURE_API bool WaitForCompletion(FEvent& Done, double Seconds);

	// The header half of the body cap (#837): true when a `Content-Length`
	// value announces more than `MaxBodyBytes`. Only a plain decimal is
	// read (leading zeros ignored); anything else is the backend's to
	// reject, and the received-bytes check still bounds it. The fetcher
	// skips it only for a block known to be 1xx or 3xx (see FetchSync).
	CONFEATURE_API bool IsDeclaredLengthOverCap(const FString& ContentLength);

	// The progress half of the body cap (#837): true once a received-bytes
	// count has passed `MaxBodyBytes`. A NEGATIVE count is over the cap —
	// UE 5.3's int32 count wraps negative past 2 GiB, and reading the wrap
	// as "small" would let an endless body through.
	CONFEATURE_API bool IsReceivedCountOverCap(int64 BytesReceived);
	CONFEATURE_API bool IsReceivedCountOverCap(uint64 BytesReceived);

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
		// calling thread until the OnProcessRequestComplete delegate fires
		// (`WaitForCompletion`). The HTTP manager delivers that delegate
		// on game-thread ticks, so on the game thread the wait pumps the
		// manager itself (Tick 0.05 s + Sleep 0.05 s, upstream's loop):
		// the frame stalls for the request's duration — at most the
		// give-up bound — but never deadlocks (#832). The body cap's
		// header and progress delegates fire from those same ticks.
		//
		// The body is capped at `MaxBodyBytes` (#837): a `Content-Length`
		// over the cap is refused when its header arrives — unless the
		// block's status is KNOWN to be 1xx or 3xx (an interim block, a
		// followed redirect or a 304 declares no body of this response); an
		// unknown status (0) is checked, since a backend may report the code
		// only after the headers — and a body
		// without one (chunked) is cancelled once the received count
		// passes the cap; a completed response over the cap is refused
		// too. Either way the fetch fails with `body_too_large` and the
		// body is never parsed.
		//
		// What the cap bounds: PARSING, not peak memory. UE delivers the
		// header and progress delegates on HTTP-manager ticks (the game
		// thread by default), so the cancel lands on the first tick after
		// the cap is crossed, and the backend buffers whatever arrives
		// within that tick — on a fast link, megabytes past the cap. UE 5.3
		// has no hook inside the backend's read loop (sdk-cpp aborts in
		// curl's write callback; 5.3 offers no equivalent), so the bound
		// is per game-thread tick there. UE 5.4+ reads 64-bit progress
		// counts (OnRequestProgress64); 5.3's int32 count wraps past 2 GiB
		// and a negative count is treated as over the cap.
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

		// Cancels the fetch in flight, if any (the client's Close, #832
		// review). Its completion — which UE delivers on a later
		// HTTP-manager tick — reports `FetchError::Cancelled` without a log
		// line, and the blocked `FetchSync` returns that; if the completion
		// never comes, it returns at its give-up bound as before. Any thread.
		// One fetch is tracked at a time (the client serialises them).
		void Cancel();

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

		// How to cancel the fetch in flight; empty when none runs.
		void TrackInFlight(TFunction<void()> Canceller);
		FCriticalSection InFlightMutex;
		TFunction<void()> CancelInFlight;
	};
}
