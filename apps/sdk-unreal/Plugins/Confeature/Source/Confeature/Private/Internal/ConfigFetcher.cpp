// SPDX-License-Identifier: MIT

#include "Internal/ConfigFetcher.h"

#include "Dom/JsonObject.h"
#include "HAL/Event.h"
#include "HAL/PlatformTime.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/SdkKey.h"

#include <atomic>

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

		private:
			std::atomic<bool> bClaimed{false};
		};
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

	FFetchResult FConfigFetcher::FetchSync(const FString& PrevETag)
	{
		if (ResolvedUrl.IsEmpty())
		{
			// FR-001: an empty, `.` or `..` key has no path segment of its
			// own — refuse rather than request a different resource.
			if (Logger.IsValid())
			{
				Logger->Error(FString::Printf(
					TEXT("ConfigFetcher: INVALID_SDK_KEY, no request sent (sdkKey=%s)"),
					*RedactSdkKey(SdkKey)));
			}
			FFetchResult Refused;
			Refused.Status = EFetchStatus::Failed;
			Refused.Error = FetchError::InvalidSdkKey;
			return Refused;
		}

		FHttpModule& Http = FHttpModule::Get();
		const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = Http.CreateRequest();
		Request->SetVerb(TEXT("GET"));
		Request->SetURL(ResolvedUrl);
		Request->SetHeader(TEXT("User-Agent"), UserAgentString);
		Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
		if (!PrevETag.IsEmpty())
		{
			Request->SetHeader(TEXT("If-None-Match"), PrevETag);
		}
		Request->SetTimeout(static_cast<float>(TimeoutSeconds));

		// The HTTP module schedules the callback on the game thread by
		// default, so this fetcher must be called from a worker thread to
		// avoid deadlocking against itself.
		const TSharedRef<FFetchState, ESPMode::ThreadSafe> State
			= MakeShared<FFetchState, ESPMode::ThreadSafe>();
		const double StartSeconds = FPlatformTime::Seconds();
		const double TimeoutFloor = static_cast<double>(TimeoutSeconds) * 0.9;

		// FR-002: every branch below sets a FIXED reason. Nothing from the
		// request or response (URL, library error text, body) is quoted —
		// the URL holds the SDK key.
		Request->OnProcessRequestComplete().BindLambda(
			[State, StartSeconds, TimeoutFloor, CountsCapture = Counts, LoggerCapture = Logger, KeyCapture = SdkKey](
				FHttpRequestPtr /*Req*/,
				FHttpResponsePtr Response,
				bool bSuccess) -> void
			{
				if (!State->Claim())
				{
					// FetchSync already gave up (it returned
					// CompletionTimedOut, logged it and cancelled this
					// request) or found it not started: this completion
					// writes nothing and logs nothing.
					CountsCapture->Discarded.fetch_add(1);
					return;
				}
				CountsCapture->Applied.fetch_add(1);
				FFetchResult& Result = State->Result;
				if (!bSuccess || !Response.IsValid())
				{
					// UE 5.3 has no failure-reason API (EHttpFailureReason
					// lands in 5.4): a failure at or past the configured
					// timeout is the module's own timeout firing.
					const bool bTimedOut = FPlatformTime::Seconds() - StartSeconds >= TimeoutFloor;
					Result.Status = EFetchStatus::Failed;
					Result.Error = bTimedOut ? FetchError::RequestTimedOut : FetchError::TransportFailed;
					if (LoggerCapture.IsValid())
					{
						LoggerCapture->Error(FString::Printf(
							TEXT("ConfigFetcher: %s (sdkKey=%s)"),
							*Result.Error,
							*RedactSdkKey(KeyCapture)));
					}
					State->DoneEvent->Trigger();
					return;
				}

				const int32 Code = Response->GetResponseCode();
				if (Code == 304)
				{
					Result.Status = EFetchStatus::NotModified;
					State->DoneEvent->Trigger();
					return;
				}
				if (Code < 200 || Code >= 300)
				{
					Result.Status = EFetchStatus::Failed;
					Result.Error = FString::Printf(TEXT("HTTP %d"), Code);
					if (LoggerCapture.IsValid())
					{
						LoggerCapture->Warning(FString::Printf(
							TEXT("ConfigFetcher: non-2xx %d (sdkKey=%s)"),
							Code,
							*RedactSdkKey(KeyCapture)));
					}
					State->DoneEvent->Trigger();
					return;
				}

				const FString Body = Response->GetContentAsString();
				TSharedPtr<FJsonObject> Parsed;
				const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
				if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
				{
					Result.Status = EFetchStatus::Failed;
					Result.Error = FetchError::MalformedBody;
					if (LoggerCapture.IsValid())
					{
						LoggerCapture->Error(FString::Printf(
							TEXT("ConfigFetcher: JSON parse failed (sdkKey=%s)"),
							*RedactSdkKey(KeyCapture)));
					}
					State->DoneEvent->Trigger();
					return;
				}

				// Top-level shape guard — config_v6 documents are objects
				// carrying at least one of {p, f, s}. Valid JSON of the
				// wrong shape (e.g. a bare array or `{"foo":"bar"}`)
				// cannot become a config and surfaces with the same
				// `Malformed config_v6.json` class as a JSON.parse
				// failure — see `wire-cases.json` `wrong-shape-200`
				// (spec 112 / epic #146). Mirrors sdk-cpp's shape guard.
				if (!Parsed->HasField(TEXT("p")) && !Parsed->HasField(TEXT("f"))
					&& !Parsed->HasField(TEXT("s")))
				{
					Result.Status = EFetchStatus::Failed;
					Result.Error = FetchError::MalformedBody;
					if (LoggerCapture.IsValid())
					{
						LoggerCapture->Error(FString::Printf(
							TEXT("ConfigFetcher: unexpected top-level shape (sdkKey=%s)"),
							*RedactSdkKey(KeyCapture)));
					}
					State->DoneEvent->Trigger();
					return;
				}

				Result.Status = EFetchStatus::Fetched;
				Result.Body = Parsed;
				Result.ETag = Response->GetHeader(TEXT("ETag"));
				State->DoneEvent->Trigger();
			});

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
			FFetchResult NotStarted;
			NotStarted.Status = EFetchStatus::Failed;
			NotStarted.Error = FetchError::NotStarted;
			if (Logger.IsValid())
			{
				Logger->Error(FString::Printf(
					TEXT("ConfigFetcher: %s (sdkKey=%s)"),
					FetchError::NotStarted,
					*RedactSdkKey(SdkKey)));
			}
			return NotStarted;
		}

		// Bound the wait (by default the configured timeout + a small
		// slack) so a hung HTTP module doesn't lock the worker forever.
		const uint32 WaitMs = static_cast<uint32>(GiveUpSeconds * 1000.0);
		// A late delegate still runs against `State`, which it keeps alive.
		if (!State->DoneEvent->Wait(WaitMs))
		{
			if (TestHooks.AfterWaitExpired)
			{
				TestHooks.AfterWaitExpired();
			}
			if (!State->Claim())
			{
				// The completion claimed the result an instant after the
				// wait expired: it is writing (and, on failure, logging)
				// it now and triggers the event last. Its result stands;
				// no cancel, no timeout line.
				State->DoneEvent->Wait();
				return State->Result;
			}
			// Stop the request: it still targets the key-bearing URL and
			// nobody waits for it any more. The claim above already makes
			// its completion (which a cancel fires, with bSuccess=false) a
			// silent discard. UE 5.3's CancelRequest may be called off the
			// game thread (the curl backend hands the finish to the HTTP
			// manager / game thread); a request that already finished is
			// left alone.
			if (Request->GetStatus() == EHttpRequestStatus::Processing)
			{
				Request->CancelRequest();
			}

			FFetchResult TimedOut;
			TimedOut.Status = EFetchStatus::Failed;
			TimedOut.Error = FetchError::CompletionTimedOut;
			if (Logger.IsValid())
			{
				Logger->Error(FString::Printf(
					TEXT("ConfigFetcher: timeout (sdkKey=%s)"), *RedactSdkKey(SdkKey)));
			}
			return TimedOut;
		}
		return State->Result;
	}
}
