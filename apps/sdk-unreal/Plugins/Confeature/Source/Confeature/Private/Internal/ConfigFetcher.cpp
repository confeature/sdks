// SPDX-License-Identifier: MIT

#include "Internal/ConfigFetcher.h"

#include "Dom/JsonObject.h"
#include "HAL/Event.h"
#include "HAL/PlatformProcess.h"
#include "HttpManager.h"
#include "HAL/PlatformTime.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/ScopeExit.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/SdkKey.h"

#include <atomic>
#include <type_traits>

namespace Confeature::Internal
{
	namespace
	{
		// Go's `shouldEscape(c, encodePathSegment)` == false.
		bool IsPathSegmentSafe(uint8 C)
		{
			return (C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9')
				|| C == '-' || C == '_' || C == '.' || C == '~' || C == '$' || C == '&'
				|| C == '+' || C == ':' || C == '=' || C == '@';
		}
	}

	FString EscapePathSegment(const FString& Segment)
	{
		static constexpr ANSICHAR Hex[] = "0123456789ABCDEF";
		if (Segment.IsEmpty())
		{
			return FString();  // an empty FString has no buffer to convert
		}
		// FTCHARToUTF8 converts by code point: a UTF-16 surrogate pair
		// becomes the 4 UTF-8 bytes of its one code point, never two
		// 3-byte halves (Go escapes the UTF-8 of the string's runes).
		const FTCHARToUTF8 Utf8(Segment.GetCharArray().GetData(), Segment.Len());
		const uint8* Bytes = reinterpret_cast<const uint8*>(Utf8.Get());
		FString Out;
		Out.Reserve(Utf8.Length());
		for (int32 I = 0; I < Utf8.Length(); ++I)
		{
			const uint8 C = Bytes[I];
			if (IsPathSegmentSafe(C))
			{
				Out.AppendChar(static_cast<TCHAR>(C));
			}
			else
			{
				Out.AppendChar(TEXT('%'));
				Out.AppendChar(static_cast<TCHAR>(Hex[C >> 4]));
				Out.AppendChar(static_cast<TCHAR>(Hex[C & 0x0F]));
			}
		}
		return Out;
	}

	// ConfigCat's path, key raw: configcat/cpp-sdk `src/configfetcher.cpp`
	// (`url + "/configuration-files/" + sdkKey + "/" + kConfigJsonName`),
	// which configcat/unreal-engine-sdk hands verbatim to `FHttpModule`
	// (`ConfigCatNetworkAdapter.cpp`, `GetRequest->SetURL(Url)`). The CDN
	// routes both shapes (the CDN Worker's config_v6 route).
	FString BuildConfigUrl(const FString& BaseUrl, const FString& SdkKey)
	{
		// Every trailing '/' goes, as sdk-go's `strings.TrimRight(baseURL,
		// "/")`: `https://cdn.example/` must not request
		// `//configuration-files/...` (a different route — 404).
		FString Base = BaseUrl;
		while (Base.RemoveFromEnd(TEXT("/"), ESearchCase::CaseSensitive))
		{
		}

		FString KeyPath;
		if (IsValidConfeatureKeyFormat(SdkKey))
		{
			TArray<FString> Parts;
			SdkKey.ParseIntoArray(Parts, TEXT("/"), /*InCullEmpty=*/false);
			for (const FString& Part : Parts)
			{
				if (!KeyPath.IsEmpty())
				{
					KeyPath.AppendChar(TEXT('/'));
				}
				KeyPath += EscapePathSegment(Part);
			}
		}
		else
		{
			KeyPath = EscapePathSegment(SdkKey);
			if (KeyPath.IsEmpty() || KeyPath == TEXT(".") || KeyPath == TEXT(".."))
			{
				return FString();
			}
		}
		return Base + TEXT("/configuration-files/") + KeyPath + TEXT("/config_v6.json");
	}

	namespace
	{
		// State shared with the completion delegate. Held by a shared
		// reference so a delegate firing AFTER `FetchSync` gave up waiting
		// writes into live memory, never into a returned stack frame.
		struct FFetchState
		{
			FFetchResult Result;
			FEventRef DoneEvent{EEventMode::ManualReset};

			// Exactly ONE party owns the result: the completion delegate or
			// `FetchSync` giving up (or finding the request not started).
			// Each tries this single compare-exchange BEFORE it writes the
			// result or logs; only the winner does either. A check of a
			// flag followed by a separate set would let a completion that
			// arrives exactly at the give-up bound both log and be thrown
			// away.
			bool Claim()
			{
				bool bExpected = false;
				return bClaimed.compare_exchange_strong(bExpected, true);
			}

			// The body cap (#837). Called from the header and progress
			// delegates the moment the response is known to pass
			// `MaxBodyBytes`: the first call flags the fetch and cancels the
			// transfer, so the backend stops buffering it; the completion
			// that cancel fires then reports `body_too_large`. Later calls
			// (one per progress tick until the cancel lands) do nothing.
			void RefuseBody(const FHttpRequestPtr& Request)
			{
				bool bExpected = false;
				if (bBodyTooLarge.compare_exchange_strong(bExpected, true) && Request.IsValid())
				{
					Request->CancelRequest();
				}
			}

			bool IsBodyTooLarge() const { return bBodyTooLarge.load(); }

			// `FConfigFetcher::Cancel` (the client's Close): the completion
			// the cancel fires reports `FetchError::Cancelled` and logs
			// nothing — nobody is listening for it any more.
			void Cancel(const FHttpRequestPtr& Request)
			{
				bCancelled.store(true);
				if (Request.IsValid() && Request->GetStatus() == EHttpRequestStatus::Processing)
				{
					Request->CancelRequest();
				}
			}

			bool IsCancelled() const { return bCancelled.load(); }

		private:
			std::atomic<bool> bClaimed{false};
			std::atomic<bool> bBodyTooLarge{false};
			std::atomic<bool> bCancelled{false};
		};


		// Routes whatever integer type the engine's progress delegate
		// carries to the matching signed or unsigned check.
		template <typename CountType>
		bool ReceivedOverCap(CountType BytesReceived)
		{
			if constexpr (std::is_signed_v<CountType>)
			{
				return IsReceivedCountOverCap(static_cast<int64>(BytesReceived));
			}
			else
			{
				return IsReceivedCountOverCap(static_cast<uint64>(BytesReceived));
			}
		}
	}

	namespace
	{
		// One failed fetch: its fixed reason (FR-002), logged once as
		// `ConfigFetcher: <What> (sdkKey=<redacted>)` — the one shape every
		// failure line takes, and the only place one is written.
		FFetchResult Fail(
			const FString& Reason,
			const FString& What,
			const TSharedPtr<IConfeatureLogger>& Logger,
			const FString& SdkKey,
			EConfeatureLogLevel Level = EConfeatureLogLevel::Error)
		{
			if (Logger.IsValid())
			{
				Logger->Log(Level,
					FString::Printf(TEXT("ConfigFetcher: %s (sdkKey=%s)"), *What, *RedactSdkKey(SdkKey)));
			}
			FFetchResult Failed;
			Failed.Status = EFetchStatus::Failed;
			Failed.Error = Reason;
			return Failed;
		}

		FFetchResult Fail(
			const FString& Reason, const TSharedPtr<IConfeatureLogger>& Logger, const FString& SdkKey)
		{
			return Fail(Reason, Reason, Logger, SdkKey);
		}

		using FStateRef = TSharedRef<FFetchState, ESPMode::ThreadSafe>;

		// What a completion classifies against; copied into the delegate,
		// which may outlive both `FetchSync` and the fetcher.
		struct FCompletionContext
		{
			double StartSeconds = 0.0;
			// A transport failure at or past this is the module's timeout.
			double TimeoutFloor = 0.0;
			TSharedPtr<IConfeatureLogger> Logger;
			FString SdkKey;
		};

		// False only for a header block KNOWN not to carry this response's
		// body: a 1xx (interim), a 3xx (a redirect the backend follows, or a
		// 304 whose Content-Length describes the representation). Any other
		// known code, and an UNKNOWN one (0 — no response yet, or a backend
		// that sets the code only on completion), is eligible: the header
		// check must not switch off just because the status is not known
		// yet. A 304 met that way is misjudged only if it declares more
		// than 16 MiB. UNVERIFIED (no UE env; EpicGames/UnrealEngine is not
		// readable here): when UE 5.3's curl backend sets the code relative
		// to the header broadcast — likely only once the transfer ends, so
		// on 5.3 curl the eligible-when-unknown branch is the one taken.
		bool IsBodyBlockCandidate(const FHttpRequestPtr& Request)
		{
			const FHttpResponsePtr Response = Request.IsValid() ? Request->GetResponse() : FHttpResponsePtr();
			const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
			return Code <= 0 || Code >= 400 || (Code >= 200 && Code < 300);
		}

		// #837 header half of the cap: a declared length over it is refused
		// as its header lands.
		void OnHeaderReceived(
			const FStateRef& State, FHttpRequestPtr Request, const FString& Name, const FString& Value)
		{
			if (Name.Equals(TEXT("Content-Length"), ESearchCase::IgnoreCase) && IsDeclaredLengthOverCap(Value)
				&& IsBodyBlockCandidate(Request))
			{
				State->RefuseBody(Request);
			}
		}

		// #837 progress half of the cap: a body without a declared length
		// (chunked) is cut off once the received count passes it.
		template <typename CountType>
		void OnProgress(const FStateRef& State, FHttpRequestPtr Request, CountType BytesReceived)
		{
			if (ReceivedOverCap(BytesReceived))
			{
				State->RefuseBody(Request);
			}
		}

		// Turns a finished response into the fetch's result. FR-002: every
		// failure carries a FIXED reason — nothing from the request or the
		// response (URL, library error text, body) is quoted, because the
		// URL holds the SDK key.
		FFetchResult ClassifyResponse(
			const FCompletionContext& Ctx, bool bBodyTooLarge, FHttpResponsePtr Response, bool bSuccess)
		{
			// #837: a body past the cap fails the fetch whatever else
			// happened — the cancel it triggered (bSuccess=false), a body
			// that finished arriving before the cancel landed, or a backend
			// that reported neither header nor progress. It is never parsed,
			// so the cached config stays.
			if (bBodyTooLarge
				|| (Response.IsValid() && static_cast<int64>(Response->GetContent().Num()) > MaxBodyBytes))
			{
				return Fail(FetchError::BodyTooLarge, Ctx.Logger, Ctx.SdkKey);
			}
			if (!bSuccess || !Response.IsValid())
			{
				// UE 5.3 has no failure-reason API (EHttpFailureReason lands
				// in 5.4): a failure at or past the configured timeout is the
				// module's own timeout firing.
				const bool bTimedOut = FPlatformTime::Seconds() - Ctx.StartSeconds >= Ctx.TimeoutFloor;
				return Fail(
					bTimedOut ? FetchError::RequestTimedOut : FetchError::TransportFailed, Ctx.Logger, Ctx.SdkKey);
			}

			const int32 Code = Response->GetResponseCode();
			if (Code == 304)
			{
				FFetchResult NotModified;
				NotModified.Status = EFetchStatus::NotModified;
				return NotModified;
			}
			if (Code < 200 || Code >= 300)
			{
				return Fail(FString::Printf(TEXT("HTTP %d"), Code),
					FString::Printf(TEXT("non-2xx %d"), Code),
					Ctx.Logger,
					Ctx.SdkKey,
					EConfeatureLogLevel::Warning);
			}

			const FString Body = Response->GetContentAsString();
			TSharedPtr<FJsonObject> Parsed;
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
			if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
			{
				return Fail(FetchError::MalformedBody, TEXT("JSON parse failed"), Ctx.Logger, Ctx.SdkKey);
			}
			// Top-level shape guard — config_v6 documents are objects
			// carrying at least one of {p, f, s}. Valid JSON of the wrong
			// shape (e.g. a bare array or `{"foo":"bar"}`) cannot become a
			// config and surfaces with the same `Malformed config_v6.json`
			// class as a JSON.parse failure — see `wire-cases.json`
			// `wrong-shape-200` (spec 112 / epic #146). Mirrors sdk-cpp's
			// shape guard.
			if (!Parsed->HasField(TEXT("p")) && !Parsed->HasField(TEXT("f")) && !Parsed->HasField(TEXT("s")))
			{
				return Fail(
					FetchError::MalformedBody, TEXT("unexpected top-level shape"), Ctx.Logger, Ctx.SdkKey);
			}

			FFetchResult Fetched;
			Fetched.Status = EFetchStatus::Fetched;
			Fetched.Body = Parsed;
			Fetched.ETag = Response->GetHeader(TEXT("ETag"));
			return Fetched;
		}

		// The completion delegate. It claims the result first: one that
		// loses (FetchSync already gave up, or found the request not
		// started) writes nothing and logs nothing.
		void OnComplete(const FStateRef& State,
			const TSharedRef<FCompletionCounts, ESPMode::ThreadSafe>& Counts,
			const FCompletionContext& Ctx,
			FHttpResponsePtr Response,
			bool bSuccess)
		{
			if (!State->Claim())
			{
				Counts->Discarded.fetch_add(1);
				return;
			}
			Counts->Applied.fetch_add(1);
			if (State->IsCancelled())
			{
				// Discards itself: a fixed reason for the waiting FetchSync,
				// no log line, no parse.
				State->Result.Status = EFetchStatus::Failed;
				State->Result.Error = FetchError::Cancelled;
			}
			else
			{
				State->Result = ClassifyResponse(Ctx, State->IsBodyTooLarge(), Response, bSuccess);
			}
			State->DoneEvent->Trigger();
		}
	}

	namespace
	{
		using FRequestRef = TSharedRef<IHttpRequest, ESPMode::ThreadSafe>;

		// What a config GET carries — the request half of FetchSync.
		struct FRequestSpec
		{
			const FString& Url;
			const FString& UserAgent;
			const FString& PrevETag;
			int32 TimeoutSeconds;
		};

		// Builds the GET and binds its three delegates (the cap's header and
		// progress halves, the completion) to `State`, which they share and
		// may keep alive past FetchSync.
		FRequestRef BindRequest(const FRequestSpec& Spec,
			const FStateRef& State,
			const TSharedRef<FCompletionCounts, ESPMode::ThreadSafe>& Counts,
			FCompletionContext Ctx)
		{
			const FRequestRef Request = FHttpModule::Get().CreateRequest();
			Request->SetVerb(TEXT("GET"));
			Request->SetURL(Spec.Url);
			Request->SetHeader(TEXT("User-Agent"), Spec.UserAgent);
			Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
			if (!Spec.PrevETag.IsEmpty())
			{
				Request->SetHeader(TEXT("If-None-Match"), Spec.PrevETag);
			}
			Request->SetTimeout(static_cast<float>(Spec.TimeoutSeconds));

			Request->OnHeaderReceived().BindLambda(
				[State](FHttpRequestPtr Req, const FString& Name, const FString& Value)
				{ OnHeaderReceived(State, Req, Name, Value); });
#if UE_VERSION_OLDER_THAN(5, 4, 0)
			Request->OnRequestProgress().BindLambda(
				[State](FHttpRequestPtr Req, int32 /*BytesSent*/, int32 BytesReceived)
				{ OnProgress(State, Req, BytesReceived); });
#else
			// 5.4 deprecated the int32 delegate for this 64-bit one.
			Request->OnRequestProgress64().BindLambda(
				[State](FHttpRequestPtr Req, auto /*BytesSent*/, auto BytesReceived)
				{ OnProgress(State, Req, BytesReceived); });
#endif
			Request->OnProcessRequestComplete().BindLambda(
				[State, Counts, Ctx = MoveTemp(Ctx)](
					FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bSuccess)
				{ OnComplete(State, Counts, Ctx, Response, bSuccess); });
			return Request;
		}

		// The give-up bound expired. FetchSync and the completion race for
		// the result through ONE claim: if the completion won an instant
		// after the wait expired, its result stands (no cancel, no timeout
		// line); otherwise the request is cancelled — it still targets the
		// key-bearing URL and nobody waits for it — and its completion
		// (which the cancel fires, bSuccess=false) is a silent discard.
		FFetchResult GiveUp(const FStateRef& State,
			const FRequestRef& Request,
			const TFunction<void()>& AfterWaitExpired,
			const TSharedPtr<IConfeatureLogger>& Logger,
			const FString& SdkKey)
		{
			if (AfterWaitExpired)
			{
				AfterWaitExpired();
			}
			if (!State->Claim())
			{
				State->DoneEvent->Wait();
				return State->Result;
			}
			// UE 5.3's CancelRequest may be called off the game thread (the
			// curl backend hands the finish to the HTTP manager / game
			// thread); a request that already finished is left alone.
			if (Request->GetStatus() == EHttpRequestStatus::Processing)
			{
				Request->CancelRequest();
			}
			return Fail(FetchError::CompletionTimedOut, TEXT("timeout"), Logger, SdkKey);
		}
	}

	void PumpHttpOnce()
	{
		FHttpModule::Get().GetHttpManager().Tick(GameThreadPumpSeconds);
		FPlatformProcess::Sleep(GameThreadPumpSeconds);
	}

	bool WaitForCompletion(FEvent& Done, double Seconds)
	{
		if (!IsInGameThread())
		{
			return Done.Wait(static_cast<uint32>(Seconds * 1000.0));
		}
		// #832: the game thread delivers the completion itself, so it must
		// keep ticking the HTTP manager while it waits — upstream's pump.
		// The completion (and the body cap's header and progress delegates)
		// run inside these ticks, on this thread.
		const double Deadline = FPlatformTime::Seconds() + Seconds;
		while (!Done.Wait(0))
		{
			if (FPlatformTime::Seconds() >= Deadline)
			{
				return false;
			}
			PumpHttpOnce();
		}
		return true;
	}

	bool IsDeclaredLengthOverCap(const FString& ContentLength)
	{
		FString Value = ContentLength.TrimStartAndEnd();
		if (Value.IsEmpty())
		{
			return false;
		}
		for (const TCHAR C : Value)
		{
			if (C < TEXT('0') || C > TEXT('9'))
			{
				return false;
			}
		}
		// Leading zeros carry no magnitude: without stripping them the
		// digit-count shortcut below would read `0000…0016` as huge.
		int32 FirstSignificant = 0;
		while (FirstSignificant < Value.Len() - 1 && Value[FirstSignificant] == TEXT('0'))
		{
			++FirstSignificant;
		}
		Value.RightChopInline(FirstSignificant);
		// More digits than int64 holds is over any cap; below that the
		// value parses without overflow.
		return Value.Len() > 18
			|| FCString::Strtoui64(*Value, nullptr, 10) > static_cast<uint64>(MaxBodyBytes);
	}

	bool IsReceivedCountOverCap(int64 BytesReceived)
	{
		return BytesReceived < 0 || BytesReceived > MaxBodyBytes;
	}

	bool IsReceivedCountOverCap(uint64 BytesReceived)
	{
		return BytesReceived > static_cast<uint64>(MaxBodyBytes);
	}

	FConfigFetcher::FConfigFetcher(
		FString InSdkKey,
		FString InVersion,
		FString InBaseUrl,
		int32 InTimeoutSeconds,
		TSharedPtr<IConfeatureLogger> InLogger)
		: SdkKey(MoveTemp(InSdkKey))
		, BaseUrl(InBaseUrl.IsEmpty() ? FString(DefaultBaseUrl) : MoveTemp(InBaseUrl))
		, TimeoutSeconds(InTimeoutSeconds > 0 ? InTimeoutSeconds : DefaultTimeoutSeconds)
		, GiveUpSeconds(static_cast<double>(TimeoutSeconds) + 5.0)
		, Logger(MoveTemp(InLogger))
		, Counts(MakeShared<FCompletionCounts, ESPMode::ThreadSafe>())
	{
		ResolvedUrl = BuildConfigUrl(BaseUrl, SdkKey);
		UserAgentString = FString::Printf(TEXT("confeature-unreal-sdk/%s"), *InVersion);
	}

	void FConfigFetcher::Cancel()
	{
		TFunction<void()> Canceller;
		{
			FScopeLock Guard(&InFlightMutex);
			Canceller = CancelInFlight;
		}
		if (Canceller)
		{
			Canceller();
		}
	}

	void FConfigFetcher::TrackInFlight(TFunction<void()> Canceller)
	{
		FScopeLock Guard(&InFlightMutex);
		CancelInFlight = MoveTemp(Canceller);
	}

	FFetchResult FConfigFetcher::FetchSync(const FString& PrevETag)
	{
		if (ResolvedUrl.IsEmpty())
		{
			// FR-001: an empty, `.` or `..` key has no path segment of its
			// own — refuse rather than request a different resource.
			return Fail(FetchError::InvalidSdkKey,
				FString::Printf(TEXT("%s, no request sent"), FetchError::InvalidSdkKey), Logger, SdkKey);
		}
		const FStateRef State = MakeShared<FFetchState, ESPMode::ThreadSafe>();
		FRequestSpec Spec{ResolvedUrl, UserAgentString, PrevETag, TimeoutSeconds};
		FCompletionContext Ctx{FPlatformTime::Seconds(), static_cast<double>(TimeoutSeconds) * 0.9, Logger, SdkKey};
		const FRequestRef Request = BindRequest(Spec, State, Counts, MoveTemp(Ctx));
		TrackInFlight([State, WeakRequest = TWeakPtr<IHttpRequest, ESPMode::ThreadSafe>(Request)]()
			{ State->Cancel(WeakRequest.Pin()); });
		ON_SCOPE_EXIT { TrackInFlight(nullptr); };

		const bool bStarted
			= TestHooks.ProcessRequest ? TestHooks.ProcessRequest(Request) : Request->ProcessRequest();
		if (!bStarted)
		{
			if (!State->Claim())
			{
				// The backend completed the request while refusing it (a
				// failure path that fires the delegate): that completion
				// owns the result and has logged it.
				State->DoneEvent->Wait();
				return State->Result;
			}
			return Fail(FetchError::NotStarted, Logger, SdkKey);
		}

		// Bound the wait (by default the configured timeout + a small
		// slack) so a hung HTTP module doesn't lock the caller forever.
		// A late delegate still runs against `State`, which it keeps alive.
		if (WaitForCompletion(*State->DoneEvent, GiveUpSeconds))
		{
			return State->Result;
		}
		return GiveUp(State, Request, TestHooks.AfterWaitExpired, Logger, SdkKey);
	}
}
