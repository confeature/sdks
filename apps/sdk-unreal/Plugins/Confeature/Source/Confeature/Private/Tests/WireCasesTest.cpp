// SPDX-License-Identifier: MIT

// Wire-protocol fixture suite (Unreal Engine consumer).
//
// Drives sdk-unreal's `Confeature::Internal::FConfigFetcher` against
// each case in `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`.
// The corpus is the language-agnostic contract; this file is the UE
// consumer that maps the fetcher's `EFetchStatus` + stringly-typed
// `FFetchResult.Error` onto the corpus's normalised
// `{fetched, notModified, failed}` x
// `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.
//
// See epic #146 (contract testing framework) + #148 slice 16 (this
// suite — closes the fan-out) + spec 112. Constitution Principle II
// (NON-NEGOTIABLE — drop-in compatibility) + Principle IV (multi-SDK
// federation) + Principle VII (local-first quality gating).
//
// Layer choice: drives `FConfigFetcher` directly (NOT UConfeatureClient),
// matching sdk-cpp / sdk-go / sdk-rust / sdk-python — the wire-cases
// corpus by name tests wire behaviour and the fetcher IS sdk-unreal's
// wire layer. Driving the public client would add poll-service
// indirection that the corpus does not assert.
//
// Mock pattern: a minimal loopback HTTP/1.1 server backed by BSD
// sockets. UE has no first-party in-process HTTP mock and adding
// `FHttpServer` (HTTPServer module) would add a plugin dependency
// (forbidden — see issue #148 constraints). The pattern mirrors
// sdk-cpp's `MockServer` so divergence here would mean divergence
// across the C++ ports — fix the mock, not the corpus.
//
// #803: the request PATH is asserted on the parsed request line against
// the corpus `expected.requestPath` (the key travels raw, as ConfigCat's);
// `given.sdkKey` configures the fetcher; any `given`/`expected` field this
// consumer does not read FAILS the case. More tests share the mock:
// `Confeature.Wire.KeyFreeFailures` (timeout, mid-body reset, redirect
// loop — the key in no log line and no error),
// `Confeature.Wire.RefusedKeys` ("", ".", ".." — no request at all),
// `Confeature.Wire.AbandonedFetch` (a completion that never comes: the
// request is cancelled — the connection closes long before the request's
// own timeout — and its late completion runs and is discarded), and the
// two result-claim races no real backend reaches on demand, forced
// through `FFetchTestHooks`: `Confeature.Wire.CompletionWinsAfterWait`
// (the completion claims between the wait expiring and the give-up's
// claim) and `Confeature.Wire.ProcessRequestRefused` (ProcessRequest
// returns false after firing the completion, or without firing it).
//
// Threading: `FConfigFetcher::FetchSync` blocks on an FEvent until the
// HTTP-completion delegate fires. UE's HTTP manager is pumped from the
// game thread (where Automation tests also run) so calling FetchSync
// directly from the test deadlocks. We push the fetch onto a worker
// thread via `Async(EAsyncExecution::Thread, ...)` and pump the HTTP
// manager from the test thread until the worker's future resolves.

#include "CoreMinimal.h"
#include "Async/Async.h"
#include "Async/Future.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/ThreadSafeBool.h"
#include "HAL/UnrealMemory.h"
#include "HttpManager.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

#include "ConfeatureLogger.h"
#include "Internal/ConfigFetcher.h"
#include "Tests/TestPaths.h"

#include <atomic>

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include "Windows/HideWindowsPlatformTypes.h"
using SocketType = SOCKET;
constexpr SocketType InvalidSocketValue = INVALID_SOCKET;
constexpr int SocketErrorValue = SOCKET_ERROR;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
using SocketType = int;
constexpr SocketType InvalidSocketValue = -1;
constexpr int SocketErrorValue = -1;
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireCasesTest,
	"Confeature.Wire.WireCases",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireKeyFreeFailuresTest,
	"Confeature.Wire.KeyFreeFailures",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireRefusedKeysTest,
	"Confeature.Wire.RefusedKeys",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireAbandonedFetchTest,
	"Confeature.Wire.AbandonedFetch",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireCompletionWinsAfterWaitTest,
	"Confeature.Wire.CompletionWinsAfterWait",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureWireProcessRequestRefusedTest,
	"Confeature.Wire.ProcessRequestRefused",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

namespace
{
	// The SDK key a case runs with when the corpus does not pin one
	// (`given.sdkKey`) — any well-shaped key would do; a deterministic
	// one keeps failures grep-able.
	constexpr const TCHAR* WireTestSdkKey
		= TEXT("confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-")
		  TEXT("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

	// The claim-race tests bound every step by this, so a regression that
	// deadlocks FetchSync fails the test instead of hanging the run.
	constexpr uint32 RaceStepBoundMs = 10000;

	// Every `given` / `expected` field this consumer reads. A corpus field
	// outside these sets FAILS the case (#803 FR-003), so a new
	// expectation can never be skipped silently.
	const TSet<FString>& KnownGivenFields()
	{
		static const TSet<FString> Known{
			TEXT("previousEtag"), TEXT("sdkKey"), TEXT("baseUrl")};
		return Known;
	}
	const TSet<FString>& KnownExpectedFields()
	{
		static const TSet<FString> Known{
			TEXT("outcome"),
			TEXT("errorClass"),
			TEXT("hasConfig"),
			TEXT("resultingEtag"),
			TEXT("requestHeaderIfNoneMatch"),
			TEXT("requestUrlPrefix"),
			TEXT("requestPath")};
		return Known;
	}

	// Maps the fetcher's fixed `FFetchResult.Error` reasons
	// (`Confeature::Internal::FetchError`, #803 FR-002) onto the corpus's
	// normalised error-class vocabulary:
	//
	//   - INVALID_SDK_KEY                   -> invalidSdkKey (refused locally, no request)
	//   - "Malformed config_v6.json"        -> parseFailed   (JSON.parse OR wrong shape)
	//   - "HTTP request timed out" /
	//     "Timed out waiting for HTTP ..."  -> timeout
	//   - "HTTP 403" / "HTTP 404"           -> invalidSdkKey (CDN rejected the key — per ConfigCat
	//                                          only 403/404 are invalid-SDK-key statuses; 401 is a
	//                                          generic retryable failure)
	//   - "HTTP <other non-2xx>"            -> fetchFailed
	//   - "HTTP request failed"             -> fetchFailed   (network / transport)
	//   - anything else                     -> fetchFailed
	//
	// Mirrors sdk-cpp's `cppErrorToClass` + sdk-go's `goErrorToClass`.
	FString UnrealErrorToClass(const FString& Reason)
	{
		using namespace Confeature::Internal;
		if (Reason.Equals(FetchError::InvalidSdkKey))
		{
			return TEXT("invalidSdkKey");
		}
		if (Reason.Equals(FetchError::MalformedBody))
		{
			return TEXT("parseFailed");
		}
		if (Reason.Equals(FetchError::RequestTimedOut) || Reason.Equals(FetchError::CompletionTimedOut))
		{
			return TEXT("timeout");
		}
		if (Reason.Equals(TEXT("HTTP 403")) || Reason.Equals(TEXT("HTTP 404")))
		{
			return TEXT("invalidSdkKey");
		}
		return TEXT("fetchFailed");
	}

	// The UE verbosity the default logger (`MakeDefaultConfeatureLogger`,
	// ConfeatureModule.cpp) maps each level to.
	const TCHAR* UeVerbosityName(EConfeatureLogLevel Level)
	{
		switch (Level)
		{
			case EConfeatureLogLevel::Debug:
				return TEXT("Verbose");
			case EConfeatureLogLevel::Info:
				return TEXT("Log");
			case EConfeatureLogLevel::Warning:
				return TEXT("Warning");
			case EConfeatureLogLevel::Error:
				return TEXT("Error");
			case EConfeatureLogLevel::Off:
			default:
				return TEXT("Off");
		}
	}

	// Records every log line the SDK emits through its logger seam, as the
	// default logger's UE_LOG would print it: category, verbosity and the
	// message (`LogConfeature: Error: <message>`). The seam carries
	// nothing else (no error object, no context), so a captured line holds
	// everything an SDK log line in the UE output log can hold. The fetcher
	// logs from the HTTP completion thread and the worker thread.
	class FCapturingLogger final : public IConfeatureLogger
	{
	public:
		virtual void Log(EConfeatureLogLevel Level, const FString& Message) override
		{
			FScopeLock Guard(&Mutex);
			Lines.Add(FString::Printf(TEXT("LogConfeature: %s: %s"), UeVerbosityName(Level), *Message));
		}

		TArray<FString> Snapshot() const
		{
			FScopeLock Guard(&Mutex);
			return Lines;
		}

	private:
		mutable FCriticalSection Mutex;
		TArray<FString> Lines;
	};

	// The request target of a raw HTTP/1.1 request (`GET <target> HTTP/1.1`),
	// or "" when the request line is unreadable.
	FString RequestTarget(const FString& RawRequest)
	{
		FString Line = RawRequest;
		int32 Eol = Line.Find(TEXT("\r\n"), ESearchCase::CaseSensitive);
		if (Eol != INDEX_NONE)
		{
			Line.LeftInline(Eol);
		}
		TArray<FString> Parts;
		Line.ParseIntoArray(Parts, TEXT(" "), /*InCullEmpty=*/true);
		return Parts.Num() >= 2 ? Parts[1] : FString();
	}

	// Minimal blocking HTTP/1.1 server tailored to FConfigFetcher's
	// surface. Mirrors sdk-cpp's MockServer — kept private to this TU
	// so Automation binaries don't share state across test files.
	class FMockServer
	{
	public:
		FMockServer()
		{
#if PLATFORM_WINDOWS
			WSADATA Data;
			WSAStartup(MAKEWORD(2, 2), &Data);
#endif
			Sock = ::socket(AF_INET, SOCK_STREAM, 0);
			if (Sock == InvalidSocketValue)
			{
				return;
			}
			int Yes = 1;
			::setsockopt(
				Sock,
				SOL_SOCKET,
				SO_REUSEADDR,
				reinterpret_cast<const char*>(&Yes),
				sizeof(Yes));
			sockaddr_in Addr;
			FMemory::Memzero(Addr);
			Addr.sin_family = AF_INET;
			Addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
			Addr.sin_port = 0;
			if (::bind(Sock, reinterpret_cast<sockaddr*>(&Addr), sizeof(Addr)) == SocketErrorValue)
			{
				CloseSock(Sock);
				Sock = InvalidSocketValue;
				return;
			}
			socklen_t Len = sizeof(Addr);
			if (::getsockname(Sock, reinterpret_cast<sockaddr*>(&Addr), &Len) == SocketErrorValue)
			{
				CloseSock(Sock);
				Sock = InvalidSocketValue;
				return;
			}
			Port = ntohs(Addr.sin_port);
			if (::listen(Sock, 4) == SocketErrorValue)
			{
				CloseSock(Sock);
				Sock = InvalidSocketValue;
				return;
			}
			bValid = true;
		}

		~FMockServer()
		{
			Stop();
			if (Sock != InvalidSocketValue)
			{
				CloseSock(Sock);
				Sock = InvalidSocketValue;
			}
#if PLATFORM_WINDOWS
			WSACleanup();
#endif
		}

		FMockServer(const FMockServer&) = delete;
		FMockServer& operator=(const FMockServer&) = delete;

		bool IsValid() const { return bValid; }

		// Transport behaviour (#490 / #590). Mirrors the corpus
		// `server.behavior` field + the sdk-go reference adapter:
		//   - Respond          — deliver the enqueued canned response (default).
		//   - Timeout          — accept the connection, read the request, then
		//                         HANG (never reply, never close) so the
		//                         fetcher's request timeout fires → "Timed out…"
		//                         → timeout class. The mock watches for the
		//                         CLIENT closing the connection and records it
		//                         (`SawClientClose`): with the mock holding it
		//                         open, only the client ending the request —
		//                         its timeout or a cancel — closes it.
		//   - CloseMidResponse — send a header announcing a larger
		//                         Content-Length than the bytes written, then
		//                         slam the socket → the client sees a truncated
		//                         body → a TRANSPORT failure (fetchFailed), NOT
		//                         a JSON parse failure.
		//   - RedirectLoop     — answer every request with a 302 back to the
		//                         very URL requested (which holds the SDK key),
		//                         so a library error quoting the redirect
		//                         target would leak the key (#803 FR-004).
		enum class EMockBehavior : uint8
		{
			Respond,
			Timeout,
			CloseMidResponse,
			RedirectLoop,
		};

		void SetBehavior(EMockBehavior InBehavior) { Behavior = InBehavior; }

		void Enqueue(const FString& Response)
		{
			FScopeLock Guard(&ResponsesMutex);
			PendingResponses.Add(Response);
		}

		void Start()
		{
			Future = Async(
				EAsyncExecution::Thread, [this]() { this->Run(); });
		}

		void Stop()
		{
			if (!Future.IsValid())
			{
				return;
			}
			Stopping.AtomicSet(true);
			// Self-connect to unblock accept().
			SocketType Wake = ::socket(AF_INET, SOCK_STREAM, 0);
			if (Wake != InvalidSocketValue)
			{
				sockaddr_in Addr;
				FMemory::Memzero(Addr);
				Addr.sin_family = AF_INET;
				Addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
				Addr.sin_port = htons(Port);
				::connect(Wake, reinterpret_cast<sockaddr*>(&Addr), sizeof(Addr));
				CloseSock(Wake);
			}
			Future.Wait();
		}

		FString LastRequest() const
		{
			FScopeLock Guard(&RequestsMutex);
			if (Requests.Num() == 0)
			{
				return FString();
			}
			return Requests.Last();
		}

		int32 RequestCount() const
		{
			FScopeLock Guard(&RequestsMutex);
			return Requests.Num();
		}

		// True once a client closed (FIN or RST) a connection the Timeout
		// behaviour was holding open.
		bool SawClientClose() const { return ClientClosed; }

		// `FPlatformTime::Seconds()` when the mock saw that close; only
		// meaningful once `SawClientClose()` is true.
		double ClientCloseSeconds() const { return ClientClosedAt.load(); }

		uint16 GetPort() const { return Port; }

	private:
		static void CloseSock(SocketType S)
		{
#if PLATFORM_WINDOWS
			::closesocket(S);
#else
			::close(S);
#endif
		}

		// Waits up to `TimeoutMs` for the peer to close `S`: true on an
		// orderly close (recv 0) or a reset (recv < 0). The client sends
		// nothing after its request, so any readable state is a close.
		// poll()/WSAPoll take the socket itself, so any descriptor value
		// works — select()'s FD_SET is undefined at or above FD_SETSIZE.
		static bool PeerClosedWithin(SocketType S, int32 TimeoutMs)
		{
#if PLATFORM_WINDOWS
			WSAPOLLFD Entry;
			FMemory::Memzero(Entry);
			Entry.fd = S;
			Entry.events = POLLRDNORM;  // WSAPoll rejects POLLPRI; a close sets POLLHUP
			const int Ready = ::WSAPoll(&Entry, 1, TimeoutMs);
#else
			pollfd Entry;
			FMemory::Memzero(Entry);
			Entry.fd = S;
			Entry.events = POLLIN;  // a close sets POLLIN (recv 0) and/or POLLHUP
			const int Ready = ::poll(&Entry, 1, TimeoutMs);
#endif
			// An error (EINTR included) or an invalid descriptor is not a
			// close: wait out the slice so the caller's loop never spins.
			if (Ready < 0 || (Ready > 0 && (Entry.revents & POLLNVAL) != 0))
			{
				FPlatformProcess::Sleep(static_cast<float>(TimeoutMs) / 1000.0f);
				return false;
			}
			if (Ready == 0)
			{
				return false;
			}
			char Byte = 0;
			return static_cast<int>(::recv(S, &Byte, 1, 0)) <= 0;
		}

		void Run()
		{
			while (!Stopping)
			{
				sockaddr_in ClientAddr;
				FMemory::Memzero(ClientAddr);
				socklen_t Len = sizeof(ClientAddr);
				SocketType Client
					= ::accept(Sock, reinterpret_cast<sockaddr*>(&ClientAddr), &Len);
				if (Client == InvalidSocketValue)
				{
					if (Stopping)
					{
						return;
					}
					continue;
				}
				if (Stopping)
				{
					CloseSock(Client);
					return;
				}
				HandleOne(Client);
				CloseSock(Client);
			}
		}

		void HandleOne(SocketType Client)
		{
			FString Raw;
			char Buf[4097];
			while (true)
			{
				int N = static_cast<int>(::recv(Client, Buf, sizeof(Buf) - 1, 0));
				if (N <= 0)
				{
					break;
				}
				Buf[N] = '\0';
				Raw.Append(UTF8_TO_TCHAR(Buf));
				if (Raw.Contains(TEXT("\r\n\r\n")))
				{
					break;
				}
				if (Raw.Len() > (1 << 16))
				{
					break;
				}
			}
			{
				FScopeLock Guard(&RequestsMutex);
				Requests.Add(Raw);
			}

			// Timeout behaviour: we have read the request (so the
			// request-side invariants still hold) but never reply. The
			// fetcher's FEvent::Wait expires → "Timed out…" → timeout class.
			// Hold the connection open until Stop() unblocks us so the
			// socket stays alive while the client waits out its timeout —
			// unless the CLIENT closes it first, which is recorded.
			if (Behavior == EMockBehavior::Timeout)
			{
				while (!Stopping)
				{
					if (PeerClosedWithin(Client, 20))
					{
						// The time first, so a reader seeing the flag sees it.
						ClientClosedAt.store(FPlatformTime::Seconds());
						ClientClosed.AtomicSet(true);
						return;
					}
				}
				return;
			}

			// Redirect-loop behaviour: a 302 back to the very target the
			// client asked for (key included); every UE 5.3 backend follows
			// it (libcurl with CURLOPT_FOLLOWLOCATION, NSURLSession on
			// Apple) until its redirect cap or the request timeout.
			if (Behavior == EMockBehavior::RedirectLoop)
			{
				const FString Loop = FString::Printf(
					TEXT("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:%u%s\r\n")
					TEXT("Content-Length: 0\r\nConnection: close\r\n\r\n"),
					Port,
					*RequestTarget(Raw));
				const FTCHARToUTF8 Utf8Loop(*Loop);
				::send(Client, Utf8Loop.Get(), Utf8Loop.Length(), 0);
				return;
			}

			// Close-mid-response behaviour: announce a 4096-byte body, send
			// a handful of bytes, then return (the caller closes the socket).
			// The client reads a truncated body → a transport failure
			// (HTTP request failed → fetchFailed), NOT a parse failure.
			if (Behavior == EMockBehavior::CloseMidResponse)
			{
				const FString Truncated
					= TEXT("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n")
					  TEXT("Connection: close\r\n\r\n{\"p\":{\"s\":\"partial");
				const FTCHARToUTF8 Utf8Trunc(*Truncated);
				::send(Client, Utf8Trunc.Get(), Utf8Trunc.Length(), 0);
				return;
			}

			FString Response;
			{
				FScopeLock Guard(&ResponsesMutex);
				if (PendingResponses.Num() > 0)
				{
					Response = PendingResponses[0];
					PendingResponses.RemoveAt(0);
				}
			}
			if (Response.IsEmpty())
			{
				Response = TEXT("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n")
						   TEXT("Connection: close\r\n\r\n");
			}
			const FTCHARToUTF8 Utf8(*Response);
			::send(Client, Utf8.Get(), Utf8.Length(), 0);
		}

		SocketType Sock = InvalidSocketValue;
		uint16 Port = 0;
		bool bValid = false;
		EMockBehavior Behavior = EMockBehavior::Respond;
		FThreadSafeBool Stopping;
		FThreadSafeBool ClientClosed;
		std::atomic<double> ClientClosedAt{0.0};
		TFuture<void> Future;

		mutable FCriticalSection ResponsesMutex;
		TArray<FString> PendingResponses;

		mutable FCriticalSection RequestsMutex;
		TArray<FString> Requests;
	};

	FString BaseUrlFor(const FMockServer& Server)
	{
		return FString::Printf(TEXT("http://127.0.0.1:%u"), Server.GetPort());
	}

	// Resolves a case's response body — either inlined raw text (`body`)
	// or a reference to a sibling fixture (`bodyRef`). Either may be
	// null/absent for 304-style responses.
	bool ResolveBody(
		FAutomationTestBase& Test,
		const FString& FixturesDir,
		const TSharedPtr<FJsonObject>& Server,
		FString& OutBody)
	{
		OutBody.Reset();
		const TSharedPtr<FJsonValue> RefField = Server->TryGetField(TEXT("bodyRef"));
		if (RefField.IsValid() && RefField->Type != EJson::Null)
		{
			FString Ref;
			Server->TryGetStringField(TEXT("bodyRef"), Ref);
			const FString Path = FPaths::Combine(FixturesDir, Ref);
			if (!FFileHelper::LoadFileToString(OutBody, *Path))
			{
				Test.AddError(FString::Printf(TEXT("Failed to read bodyRef at %s"), *Path));
				return false;
			}
			return true;
		}
		const TSharedPtr<FJsonValue> BodyField = Server->TryGetField(TEXT("body"));
		if (BodyField.IsValid() && BodyField->Type != EJson::Null)
		{
			Server->TryGetStringField(TEXT("body"), OutBody);
			return true;
		}
		return true;  // 304 path — empty body is legitimate.
	}

	// Crafts a canned HTTP/1.1 response from a case's `server` block.
	FString BuildResponse(const TSharedPtr<FJsonObject>& Server, const FString& Body)
	{
		FString Out;
		int32 Status = 200;
		Server->TryGetNumberField(TEXT("status"), Status);
		FString Reason = TEXT("OK");
		switch (Status)
		{
			case 200:
				Reason = TEXT("OK");
				break;
			case 304:
				Reason = TEXT("Not Modified");
				break;
			case 404:
				Reason = TEXT("Not Found");
				break;
			case 503:
				Reason = TEXT("Service Unavailable");
				break;
			default:
				Reason = TEXT("Unknown");
				break;
		}
		Out += FString::Printf(TEXT("HTTP/1.1 %d %s\r\n"), Status, *Reason);

		const TSharedPtr<FJsonObject>* Headers = nullptr;
		if (Server->TryGetObjectField(TEXT("headers"), Headers) && Headers && Headers->IsValid())
		{
			for (const auto& Pair : (*Headers)->Values)
			{
				if (Pair.Key.Equals(TEXT("Content-Length"), ESearchCase::IgnoreCase))
				{
					continue;  // We set Content-Length explicitly below.
				}
				FString Val;
				Pair.Value->TryGetString(Val);
				Out += FString::Printf(TEXT("%s: %s\r\n"), *Pair.Key, *Val);
			}
		}
		// Byte length on the wire, not TCHAR length — the body may be
		// multibyte UTF-8 after conversion. We approximate by using the
		// TCHARToUTF8 conversion length.
		const FTCHARToUTF8 Utf8Body(*Body);
		Out += FString::Printf(TEXT("Content-Length: %d\r\n"), Utf8Body.Length());
		Out += TEXT("Connection: close\r\n\r\n");
		Out += Body;
		return Out;
	}

	// Drives FetchSync on a worker thread while the calling (game)
	// thread pumps the HTTP manager for up to `TimeoutSeconds`. Then it
	// waits for the worker regardless — FetchSync bounds its own wait —
	// so `Fetcher` is never destroyed under a running fetch.
	Confeature::Internal::FFetchResult RunFetchPumpedFromGameThread(
		Confeature::Internal::FConfigFetcher& Fetcher,
		const FString& PrevETag,
		float TimeoutSeconds)
	{
		TFuture<Confeature::Internal::FFetchResult> Future = Async(
			EAsyncExecution::Thread,
			[&Fetcher, PrevETag]()
			{
				return Fetcher.FetchSync(PrevETag);
			});
		const double Deadline = FPlatformTime::Seconds() + TimeoutSeconds;
		FHttpManager& Manager = FHttpModule::Get().GetHttpManager();
		while (!Future.IsReady())
		{
			Manager.Tick(0.01f);
			FPlatformProcess::Sleep(0.01f);
			if (FPlatformTime::Seconds() > Deadline)
			{
				break;
			}
		}
		return Future.Get();
	}

	// Maps a corpus `server.behavior` onto the mock. Absent = respond.
	bool ParseBehavior(
		const TSharedPtr<FJsonObject>& Server, FMockServer::EMockBehavior& OutBehavior)
	{
		OutBehavior = FMockServer::EMockBehavior::Respond;
		FString Behavior;
		if (!Server->TryGetStringField(TEXT("behavior"), Behavior))
		{
			return true;
		}
		if (Behavior.Equals(TEXT("timeout")))
		{
			OutBehavior = FMockServer::EMockBehavior::Timeout;
			return true;
		}
		if (Behavior.Equals(TEXT("close-mid-response")))
		{
			OutBehavior = FMockServer::EMockBehavior::CloseMidResponse;
			return true;
		}
		return false;
	}
}

bool FConfeatureWireCasesTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping WireCasesTest: packages/test-fixtures-sdk-parity/fixtures not "
				 "found relative to ProjectDir(). The plugin is being consumed outside the "
				 "Confeature monorepo — run the test from a Confeature workspace checkout."));
		return true;
	}

	const FString CorpusPath = FPaths::Combine(FixturesDir, TEXT("wire-cases.json"));
	FString Raw;
	if (!FFileHelper::LoadFileToString(Raw, *CorpusPath))
	{
		AddError(FString::Printf(TEXT("Failed to read fixture file at %s"), *CorpusPath));
		return false;
	}
	TSharedPtr<FJsonObject> Corpus;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
	if (!FJsonSerializer::Deserialize(Reader, Corpus) || !Corpus.IsValid())
	{
		AddError(TEXT("Failed to parse wire-cases.json"));
		return false;
	}

	const TArray<TSharedPtr<FJsonValue>>* Cases = nullptr;
	if (!Corpus->TryGetArrayField(TEXT("cases"), Cases) || Cases == nullptr)
	{
		AddError(TEXT("wire-cases.json missing 'cases' array"));
		return false;
	}
	// FROZEN at 19 — #491 grew 7→12, #590 grew 12→14 (timeout +
	// network-reset behaviour cases), #803 grew 14→17 (request-path
	// cases: legacy, ConfigCat-shaped, malformed), #994 grew 17→19
	// (redirect cases). Any drift = spec change.
	TestEqual(TEXT("wire-cases corpus size"), Cases->Num(), 19);

	// Cases pending for sdk-unreal (wire-cases-pending.json, 1.4, #994) are
	// left out BY NAME, under a proof that the entry is still true: this
	// reader still cannot read them. The day it can, the entry must go.
	TMap<FString, FString> Pending;
	{
		const FString PendingPath = FPaths::Combine(FixturesDir, TEXT("wire-cases-pending.json"));
		FString PendingRaw;
		TSharedPtr<FJsonObject> Manifest;
		const TSharedPtr<FJsonObject>* PendingObj = nullptr;
		if (!FFileHelper::LoadFileToString(PendingRaw, *PendingPath)
			|| !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(PendingRaw), Manifest)
			|| !Manifest.IsValid()
			|| !Manifest->TryGetObjectField(TEXT("pending"), PendingObj))
		{
			AddError(FString::Printf(TEXT("Failed to read %s"), *PendingPath));
			return false;
		}
		const TSharedPtr<FJsonObject>* Entry = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Ids = nullptr;
		FString Ticket;
		if ((*PendingObj)->TryGetObjectField(TEXT("sdk-unreal"), Entry)
			&& (*Entry)->TryGetStringField(TEXT("ticket"), Ticket)
			&& (*Entry)->TryGetArrayField(TEXT("cases"), Ids))
		{
			for (const TSharedPtr<FJsonValue>& IdVal : *Ids)
			{
				Pending.Add(IdVal->AsString(), Ticket);
			}
		}
	}
	const int32 PendingCount = Pending.Num();

	int32 Passed = 0;
	for (const TSharedPtr<FJsonValue>& CaseVal : *Cases)
	{
		const TSharedPtr<FJsonObject>* CaseObj = nullptr;
		if (!CaseVal.IsValid() || !CaseVal->TryGetObject(CaseObj) || !CaseObj || !CaseObj->IsValid())
		{
			AddError(TEXT("Malformed wire-cases entry — expected object"));
			continue;
		}
		FString Id;
		(*CaseObj)->TryGetStringField(TEXT("id"), Id);

		const TSharedPtr<FJsonObject>* GivenObj = nullptr;
		const TSharedPtr<FJsonObject>* ServerObj = nullptr;
		const TSharedPtr<FJsonObject>* ExpectedObj = nullptr;
		if (!(*CaseObj)->TryGetObjectField(TEXT("given"), GivenObj)
			|| !(*CaseObj)->TryGetObjectField(TEXT("server"), ServerObj)
			|| !(*CaseObj)->TryGetObjectField(TEXT("expected"), ExpectedObj))
		{
			AddError(FString::Printf(
				TEXT("wire-case '%s' missing given/server/expected"), *Id));
			continue;
		}
		const FString TestId = FString::Printf(TEXT("wire-case '%s'"), *Id);

		if (const FString* Ticket = Pending.Find(Id))
		{
			int32 Unread = 0;
			for (const auto& Pair : (*GivenObj)->Values)
			{
				Unread += KnownGivenFields().Contains(Pair.Key) ? 0 : 1;
			}
			for (const auto& Pair : (*ExpectedObj)->Values)
			{
				Unread += KnownExpectedFields().Contains(Pair.Key) ? 0 : 1;
			}
			if (Unread == 0)
			{
				AddError(FString::Printf(
					TEXT("%s is pending for sdk-unreal (%s) but this reader reads every field of it — "
						 "remove it from wire-cases-pending.json and run it"),
					*TestId, **Ticket));
			}
			else
			{
				AddInfo(FString::Printf(TEXT("%s pending (%s): this reader cannot read it yet"), *TestId, **Ticket));
			}
			Pending.Remove(Id);
			continue;
		}

		// FR-003: a field nobody reads fails the case, never passes it.
		bool bUnknownField = false;
		for (const auto& Pair : (*GivenObj)->Values)
		{
			if (!KnownGivenFields().Contains(Pair.Key))
			{
				AddError(FString::Printf(
					TEXT("%s — unknown given field '%s' (no adapter)"), *TestId, *Pair.Key));
				bUnknownField = true;
			}
		}
		for (const auto& Pair : (*ExpectedObj)->Values)
		{
			if (!KnownExpectedFields().Contains(Pair.Key))
			{
				AddError(FString::Printf(
					TEXT("%s — unknown expected field '%s' (no adapter)"), *TestId, *Pair.Key));
				bUnknownField = true;
			}
		}
		FMockServer::EMockBehavior Behavior = FMockServer::EMockBehavior::Respond;
		if (!ParseBehavior(*ServerObj, Behavior))
		{
			AddError(FString::Printf(TEXT("%s — unknown server.behavior (no adapter)"), *TestId));
			bUnknownField = true;
		}
		if (bUnknownField)
		{
			continue;
		}

		FString SdkKey = FString(WireTestSdkKey);
		(*GivenObj)->TryGetStringField(TEXT("sdkKey"), SdkKey);

		// Resolve response body — bodyRef → sibling fixture; body → raw.
		FString Body;
		if (!ResolveBody(*this, FixturesDir, *ServerObj, Body))
		{
			continue;
		}
		const FString WireResponse = BuildResponse(*ServerObj, Body);

		FMockServer Mock;
		if (!Mock.IsValid())
		{
			AddError(FString::Printf(
				TEXT("wire-case '%s': failed to bind loopback socket"), *Id));
			continue;
		}
		Mock.SetBehavior(Behavior);
		Mock.Enqueue(WireResponse);
		Mock.Start();

		// Translate the corpus `previousEtag` (string | null) into the
		// fetcher's PrevETag parameter — empty string means absent.
		FString PrevETag;
		const TSharedPtr<FJsonValue> PrevField = (*GivenObj)->TryGetField(TEXT("previousEtag"));
		if (PrevField.IsValid() && PrevField->Type != EJson::Null)
		{
			(*GivenObj)->TryGetStringField(TEXT("previousEtag"), PrevETag);
		}

		FConfigFetcher Fetcher(
			SdkKey,
			TEXT("0.0.0-wire-test"),
			BaseUrlFor(Mock),
			/*TimeoutSeconds=*/5,
			nullptr);

		const FFetchResult Result = RunFetchPumpedFromGameThread(Fetcher, PrevETag, 15.0f);

		Mock.Stop();

		// ---- Request-side invariants -----------------------------------
		const FString Request = Mock.LastRequest();
		if (!TestFalse(FString::Printf(TEXT("%s — server received a request"), *TestId),
				Request.IsEmpty()))
		{
			continue;
		}
		// URL shape: ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/
		// config_v6.json` (#803), compared on the PARSED path so a query
		// (#807's version carrier) never breaks it.
		const FString RequestPath = Confeature::Tests::ParsedUrlPath(RequestTarget(Request));
		TestTrue(
			FString::Printf(TEXT("%s — request path under /configuration-files/"), *TestId),
			RequestPath.StartsWith(TEXT("/configuration-files/"), ESearchCase::CaseSensitive));
		TestTrue(
			FString::Printf(TEXT("%s — request path ends in /config_v6.json"), *TestId),
			RequestPath.EndsWith(TEXT("/config_v6.json"), ESearchCase::CaseSensitive));
		FString WantPath;
		if ((*ExpectedObj)->TryGetStringField(TEXT("requestPath"), WantPath))
		{
			TestEqual(FString::Printf(TEXT("%s — request path"), *TestId), RequestPath, WantPath);
		}
		// `requestUrlPrefix` pins the URL built from `given.baseUrl`. The
		// round-trip above must reach the loopback mock, so the prefix is
		// checked on a fetcher configured with the case's base URL — the
		// same one URL function, no request sent.
		FString WantPrefix;
		if ((*ExpectedObj)->TryGetStringField(TEXT("requestUrlPrefix"), WantPrefix))
		{
			FString CaseBaseUrl = BaseUrlFor(Mock);
			(*GivenObj)->TryGetStringField(TEXT("baseUrl"), CaseBaseUrl);
			const FConfigFetcher PrefixFetcher(
				SdkKey, TEXT("0.0.0-wire-test"), CaseBaseUrl, /*TimeoutSeconds=*/5, nullptr);
			TestTrue(
				FString::Printf(TEXT("%s — request URL prefix"), *TestId),
				PrefixFetcher.Url().StartsWith(WantPrefix, ESearchCase::CaseSensitive));
		}

		// If-None-Match round-trip: corpus uses three-state semantics —
		// explicit null means the header MUST be absent; a string value
		// means the header MUST equal it verbatim. Absent key = unasserted.
		if ((*ExpectedObj)->HasField(TEXT("requestHeaderIfNoneMatch")))
		{
			const TSharedPtr<FJsonValue> WantField
				= (*ExpectedObj)->TryGetField(TEXT("requestHeaderIfNoneMatch"));
			if (WantField.IsValid() && WantField->Type == EJson::Null)
			{
				TestFalse(
					FString::Printf(TEXT("%s — If-None-Match absent"), *TestId),
					Request.Contains(TEXT("If-None-Match:"))
						|| Request.Contains(TEXT("if-none-match:")));
			}
			else
			{
				FString WantHeader;
				(*ExpectedObj)->TryGetStringField(TEXT("requestHeaderIfNoneMatch"), WantHeader);
				const FString WantLine
					= FString::Printf(TEXT("If-None-Match: %s"), *WantHeader);
				TestTrue(
					FString::Printf(TEXT("%s — If-None-Match header echoed"), *TestId),
					Request.Contains(WantLine));
			}
		}

		// ---- Outcome assertions ---------------------------------------
		bool bHasConfig = false;
		if ((*ExpectedObj)->TryGetBoolField(TEXT("hasConfig"), bHasConfig))
		{
			TestTrue(
				FString::Printf(TEXT("%s — hasConfig"), *TestId),
				Result.Body.IsValid() == bHasConfig);
		}
		// `resultingEtag` is the ETag the SDK holds afterwards: the new one
		// on a fetch, the previous one otherwise (null = none).
		if ((*ExpectedObj)->HasField(TEXT("resultingEtag")))
		{
			FString WantEtag;
			(*ExpectedObj)->TryGetStringField(TEXT("resultingEtag"), WantEtag);
			const FString HeldEtag
				= Result.Status == EFetchStatus::Fetched ? Result.ETag : PrevETag;
			TestEqual(FString::Printf(TEXT("%s — resulting ETag"), *TestId), HeldEtag, WantEtag);
		}

		FString Outcome;
		(*ExpectedObj)->TryGetStringField(TEXT("outcome"), Outcome);
		if (Outcome.Equals(TEXT("fetched")))
		{
			if (!TestTrue(
					FString::Printf(TEXT("%s — outcome=fetched"), *TestId),
					Result.Status == EFetchStatus::Fetched))
			{
				continue;
			}
		}
		else if (Outcome.Equals(TEXT("notModified")))
		{
			if (!TestTrue(
					FString::Printf(TEXT("%s — outcome=notModified"), *TestId),
					Result.Status == EFetchStatus::NotModified))
			{
				continue;
			}
		}
		else if (Outcome.Equals(TEXT("failed")))
		{
			if (!TestTrue(
					FString::Printf(TEXT("%s — outcome=failed"), *TestId),
					Result.Status == EFetchStatus::Failed))
			{
				continue;
			}
			FString WantClass;
			(*ExpectedObj)->TryGetStringField(TEXT("errorClass"), WantClass);
			const FString Mapped = UnrealErrorToClass(Result.Error);
			if (!TestEqual(
					FString::Printf(
						TEXT("%s — error class (raw='%s')"), *TestId, *Result.Error),
					Mapped,
					WantClass))
			{
				continue;
			}
		}
		else
		{
			AddError(FString::Printf(TEXT("%s — unknown outcome '%s' in corpus"), *TestId, *Outcome));
			continue;
		}

		++Passed;
	}

	for (const TPair<FString, FString>& Stale : Pending)
	{
		AddError(FString::Printf(
			TEXT("wire-cases-pending.json lists %s for sdk-unreal, not in the corpus"), *Stale.Key));
	}
	const int32 Runnable = Cases->Num() - PendingCount;
	TestEqual(TEXT("wire-cases passed"), Passed, Runnable);
	return Pending.Num() == 0 && Passed == Runnable;
}

// #803 FR-004 — the URL now holds the SDK key, so every transport failure
// must stay key-free: a timeout, a mid-body reset and a redirect loop
// back to the key-bearing URL. The full key and each of its 22-character
// parts appear in no log line and not in `FFetchResult.Error`. (UE's own
// `LogHttp` category is the integrator's logging and is out of scope —
// true of every stock ConfigCat SDK too.)
bool FConfeatureWireKeyFreeFailuresTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString Key = TEXT("configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02");
	const TArray<FString> Secrets{
		Key, TEXT("FAKEfixtureKeyNotRea01"), TEXT("FAKEfixtureKeyNotRea02")};
	const FString RawPath = TEXT(
		"/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/"
		"config_v6.json");

	// Each scenario ends in one of its fixed reasons (FR-002) — never
	// `HTTP <status>`, never library text. A redirect loop ends at the
	// backend's redirect cap (transport failure) or, uncapped, at the
	// request timeout.
	struct FScenario
	{
		const TCHAR* Name;
		FMockServer::EMockBehavior Behavior;
		TArray<FString> FixedReasons;
	};
	const FScenario Scenarios[] = {
		{TEXT("timeout"),
			FMockServer::EMockBehavior::Timeout,
			{FetchError::RequestTimedOut, FetchError::CompletionTimedOut}},
		{TEXT("mid-body reset"),
			FMockServer::EMockBehavior::CloseMidResponse,
			{FetchError::TransportFailed}},
		{TEXT("redirect loop"),
			FMockServer::EMockBehavior::RedirectLoop,
			{FetchError::TransportFailed, FetchError::RequestTimedOut, FetchError::CompletionTimedOut}},
	};

	for (const FScenario& Scenario : Scenarios)
	{
		FMockServer Mock;
		if (!Mock.IsValid())
		{
			AddError(FString::Printf(TEXT("%s: failed to bind loopback socket"), Scenario.Name));
			continue;
		}
		Mock.SetBehavior(Scenario.Behavior);
		Mock.Start();

		const TSharedRef<FCapturingLogger> Logger = MakeShared<FCapturingLogger>();
		FConfigFetcher Fetcher(
			Key, TEXT("0.0.0-wire-test"), BaseUrlFor(Mock), /*TimeoutSeconds=*/2, Logger);
		const FFetchResult Result = RunFetchPumpedFromGameThread(Fetcher, FString(), 15.0f);
		Mock.Stop();

		// Not vacuous: the key really was in the URL the server saw, the
		// fetch really failed, and the failure really was logged.
		TestEqual(
			FString::Printf(TEXT("%s: the request carried the raw key path"), Scenario.Name),
			Confeature::Tests::ParsedUrlPath(RequestTarget(Mock.LastRequest())),
			RawPath);
		TestTrue(
			FString::Printf(TEXT("%s: the fetch failed"), Scenario.Name),
			Result.Status == EFetchStatus::Failed);
		TestTrue(
			FString::Printf(TEXT("%s: the failure is one of its fixed reasons"), Scenario.Name),
			Scenario.FixedReasons.Contains(Result.Error));
		// The loop really looped: the client FOLLOWED the 302 back to the
		// key-bearing URL at least once, so a reason quoting a redirect
		// target would have had the key to quote. One request only would
		// mean this backend does not follow redirects — the scenario would
		// then prove nothing, so it fails rather than passes vacuously.
		if (Scenario.Behavior == FMockServer::EMockBehavior::RedirectLoop)
		{
			TestTrue(
				FString::Printf(
					TEXT("%s: the redirect was followed (%d requests)"), Scenario.Name, Mock.RequestCount()),
				Mock.RequestCount() > 1);
		}
		const TArray<FString> Lines = Logger->Snapshot();
		TestTrue(
			FString::Printf(TEXT("%s: the failure was logged"), Scenario.Name),
			Lines.Num() > 0);

		// Labels never echo a secret into the test report.
		for (int32 S = 0; S < Secrets.Num(); ++S)
		{
			TestFalse(
				FString::Printf(TEXT("%s: secret #%d absent from FFetchResult.Error"), Scenario.Name, S),
				Result.Error.Contains(Secrets[S], ESearchCase::CaseSensitive));
			for (int32 L = 0; L < Lines.Num(); ++L)
			{
				TestFalse(
					FString::Printf(TEXT("%s: secret #%d absent from log line #%d"), Scenario.Name, S, L),
					Lines[L].Contains(Secrets[S], ESearchCase::CaseSensitive));
			}
		}
	}
	return true;
}

// #803 FR-001 — "", "." and ".." have no path segment of their own: the
// fetcher refuses (redacted INVALID_SDK_KEY) and sends NO request.
bool FConfeatureWireRefusedKeysTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	for (const TCHAR* Refused : {TEXT(""), TEXT("."), TEXT("..")})
	{
		FMockServer Mock;
		if (!Mock.IsValid())
		{
			AddError(TEXT("failed to bind loopback socket"));
			continue;
		}
		Mock.Start();

		const TSharedRef<FCapturingLogger> Logger = MakeShared<FCapturingLogger>();
		FConfigFetcher Fetcher(
			FString(Refused), TEXT("0.0.0-wire-test"), BaseUrlFor(Mock), /*TimeoutSeconds=*/2, Logger);
		const FFetchResult Result = RunFetchPumpedFromGameThread(Fetcher, FString(), 15.0f);
		Mock.Stop();

		const FString Label = FString::Printf(TEXT("key '%s'"), Refused);
		TestEqual(FString::Printf(TEXT("%s: no request sent"), *Label), Mock.RequestCount(), 0);
		TestTrue(
			FString::Printf(TEXT("%s: fetch failed"), *Label),
			Result.Status == EFetchStatus::Failed);
		TestEqual(
			FString::Printf(TEXT("%s: INVALID_SDK_KEY"), *Label),
			Result.Error,
			FString(FetchError::InvalidSdkKey));
		TestEqual(
			FString::Printf(TEXT("%s: maps to invalidSdkKey"), *Label),
			UnrealErrorToClass(Result.Error),
			FString(TEXT("invalidSdkKey")));
		const TArray<FString> Lines = Logger->Snapshot();
		TestTrue(
			FString::Printf(TEXT("%s: INVALID_SDK_KEY logged"), *Label),
			Lines.Num() == 1 && Lines[0].Contains(TEXT("INVALID_SDK_KEY")));
	}
	return true;
}

// #803 — a completion that never arrives: FetchSync gives up, cancels the
// request (it targets the key-bearing URL), and the request's LATE
// completion runs and is discarded — no second failure line, no result.
//
// The request's own timeout (60 s) is far beyond the give-up (2 s) and the
// observation window, and the mock never closes the connection: so the
// connection closing — no earlier than the give-up — and the completion
// running within the window can only be the CANCEL's doing. Delete
// `CancelRequest()` and both stay unobserved; let something else end the
// request before the give-up and the close comes too early — either way
// the test fails.
//
// The HTTP manager is deliberately NOT pumped while FetchSync waits:
// completion delegates run on the game thread (UE 5.3's default
// CompleteOnGameThread policy), which this test holds, so none can claim
// the result before the give-up. It is pumped afterwards, so the cancelled
// request does complete — into the already-claimed state.
bool FConfeatureWireAbandonedFetchTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString Key = TEXT("configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02");
	const TArray<FString> Secrets{
		Key, TEXT("FAKEfixtureKeyNotRea01"), TEXT("FAKEfixtureKeyNotRea02")};
	constexpr int32 RequestTimeoutSeconds = 60;
	constexpr double GiveUpSeconds = 2.0;
	// Give-up + window (10 s) stays far below the request timeout AND UE's
	// default 30 s HTTP activity timeout, so neither can end the request
	// inside the window.
	constexpr double WindowSeconds = 8.0;

	FMockServer Mock;
	if (!Mock.IsValid())
	{
		AddError(TEXT("failed to bind loopback socket"));
		return false;
	}
	Mock.SetBehavior(FMockServer::EMockBehavior::Timeout);
	Mock.Start();

	const TSharedRef<FCapturingLogger> Logger = MakeShared<FCapturingLogger>();
	FConfigFetcher Fetcher(
		Key, TEXT("0.0.0-wire-test"), BaseUrlFor(Mock), RequestTimeoutSeconds, Logger);
	Fetcher.SetGiveUpSeconds(GiveUpSeconds);
	// Bounded by FetchSync's own give-up (2 s): no pump, no completion.
	const double StartedAt = FPlatformTime::Seconds();
	TFuture<FFetchResult> Future = Async(
		EAsyncExecution::Thread, [&Fetcher]() { return Fetcher.FetchSync(FString()); });
	const FFetchResult Result = Future.Get();
	const double GaveUpAt = FPlatformTime::Seconds();

	TestEqual(
		TEXT("unpumped: FetchSync gave up waiting (a delegate fired off the game thread otherwise)"),
		Result.Error,
		FString(FetchError::CompletionTimedOut));
	TestEqual(TEXT("the give-up is logged once"), Logger->Snapshot().Num(), 1);
	TestEqual(TEXT("no completion claimed the result"), Fetcher.CompletionsApplied(), 0);

	// Pump until the cancelled request has completed AND its connection
	// is closed, or the window (well inside the request timeout) ends.
	FHttpManager& Manager = FHttpModule::Get().GetHttpManager();
	const double Until = GaveUpAt + WindowSeconds;
	while (FPlatformTime::Seconds() < Until)
	{
		Manager.Tick(0.01f);
		const bool bCompleted = Fetcher.CompletionsApplied() + Fetcher.CompletionsDiscarded() > 0;
		if (bCompleted && Mock.SawClientClose())
		{
			break;
		}
		FPlatformProcess::Sleep(0.01f);
	}
	const bool bClosed = Mock.SawClientClose();
	const double ClosedAt = Mock.ClientCloseSeconds();
	const int32 RequestCount = Mock.RequestCount();
	Mock.Stop();

	TestEqual(TEXT("the request was sent"), RequestCount, 1);
	TestTrue(
		FString::Printf(
			TEXT("the cancel closed the connection within %.0f s (request timeout %d s; the mock never closes it)"),
			WindowSeconds,
			RequestTimeoutSeconds),
		bClosed);
	// The close is the CANCEL's only if the connection was still open when
	// FetchSync gave up: a close before that (the request's own timeout
	// set too short, a transport failure) would be discarded the same way
	// and pass every other check here. FetchSync cannot give up before
	// `GiveUpSeconds` after the start; the margin covers clock jitter only.
	constexpr double ClockMarginSeconds = 0.25;
	if (bClosed)
	{
		TestTrue(
			FString::Printf(
				TEXT("the connection stayed open until the give-up (closed %.2f s after the start, give-up %.0f s)"),
				ClosedAt - StartedAt,
				GiveUpSeconds),
			ClosedAt >= StartedAt + GiveUpSeconds - ClockMarginSeconds);
	}
	// The late completion RAN — once — and did nothing: it lost the claim
	// (discarded), wrote no result and logged no line.
	TestEqual(TEXT("the late completion ran and was discarded"), Fetcher.CompletionsDiscarded(), 1);
	TestEqual(TEXT("the late completion claimed nothing"), Fetcher.CompletionsApplied(), 0);
	const TArray<FString> Lines = Logger->Snapshot();
	TestEqual(TEXT("the late completion logged nothing"), Lines.Num(), 1);
	TestEqual(
		TEXT("the returned result is the give-up's"),
		Result.Error,
		FString(FetchError::CompletionTimedOut));
	for (int32 S = 0; S < Secrets.Num(); ++S)
	{
		TestFalse(
			FString::Printf(TEXT("secret #%d absent from FFetchResult.Error"), S),
			Result.Error.Contains(Secrets[S], ESearchCase::CaseSensitive));
		for (int32 L = 0; L < Lines.Num(); ++L)
		{
			TestFalse(
				FString::Printf(TEXT("secret #%d absent from log line #%d"), S, L),
				Lines[L].Contains(Secrets[S], ESearchCase::CaseSensitive));
		}
	}
	return true;
}

// #803 — the give-up's LOSING branch: the bounded wait expires, then the
// completion claims the result before FetchSync's own claim. The
// completion's result stands: FetchSync returns it (no deadlock waiting
// for it), with no timeout result, no timeout line and no cancel.
//
// Forced deterministically: the HTTP manager is NOT pumped while FetchSync
// waits (completion delegates run on the game thread, which this test
// holds — UE 5.3's CompleteOnGameThread default), so the wait expires; the
// `AfterWaitExpired` hook then holds FetchSync before its claim while this
// thread pumps the completion in.
bool FConfeatureWireCompletionWinsAfterWaitTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString Key = TEXT("configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02");
	constexpr int32 RequestTimeoutSeconds = 60;
	constexpr double GiveUpSeconds = 1.0;

	FMockServer Mock;
	if (!Mock.IsValid())
	{
		AddError(TEXT("failed to bind loopback socket"));
		return false;
	}
	const FString Body = TEXT("{\"f\":{}}");
	Mock.Enqueue(FString::Printf(
		TEXT("HTTP/1.1 200 OK\r\nETag: \"race-1\"\r\nContent-Type: application/json\r\n")
		TEXT("Content-Length: %d\r\nConnection: close\r\n\r\n%s"),
		Body.Len(),
		*Body));
	Mock.Start();

	// Shared with the hook and the worker, so a FetchSync that never
	// returns keeps them alive rather than reaching into this frame.
	struct FRendezvous
	{
		FEventRef WaitExpired{EEventMode::ManualReset};
		FEventRef Release{EEventMode::ManualReset};
	};
	const TSharedRef<FRendezvous, ESPMode::ThreadSafe> Sync = MakeShared<FRendezvous, ESPMode::ThreadSafe>();
	const TSharedRef<FCapturingLogger> Logger = MakeShared<FCapturingLogger>();
	const TSharedRef<FConfigFetcher, ESPMode::ThreadSafe> Fetcher = MakeShared<FConfigFetcher, ESPMode::ThreadSafe>(
		Key, TEXT("0.0.0-wire-test"), BaseUrlFor(Mock), RequestTimeoutSeconds, Logger);
	Fetcher->SetGiveUpSeconds(GiveUpSeconds);
	FFetchTestHooks Hooks;
	Hooks.AfterWaitExpired = [Sync]()
	{
		Sync->WaitExpired->Trigger();
		Sync->Release->Wait(RaceStepBoundMs);
	};
	Fetcher->SetTestHooks(MoveTemp(Hooks));

	TFuture<FFetchResult> Future = Async(
		EAsyncExecution::Thread, [Fetcher]() { return Fetcher->FetchSync(FString()); });

	// No pump yet: no completion can claim, so the wait must expire.
	const bool bWaitExpired = Sync->WaitExpired->Wait(RaceStepBoundMs);
	TestTrue(
		TEXT("the bounded wait expired with no completion (a delegate fired off the game thread otherwise)"),
		bWaitExpired);
	TestEqual(
		TEXT("no completion ran before the wait expired"),
		Fetcher->CompletionsApplied() + Fetcher->CompletionsDiscarded(),
		0);

	// FetchSync is held between the expired wait and its claim: pump the
	// completion in now.
	FHttpManager& Manager = FHttpModule::Get().GetHttpManager();
	const double PumpUntil = FPlatformTime::Seconds() + static_cast<double>(RaceStepBoundMs) / 1000.0;
	while (bWaitExpired && Fetcher->CompletionsApplied() + Fetcher->CompletionsDiscarded() == 0
		   && FPlatformTime::Seconds() < PumpUntil)
	{
		Manager.Tick(0.01f);
		FPlatformProcess::Sleep(0.01f);
	}
	TestEqual(TEXT("the completion claimed the result before FetchSync did"), Fetcher->CompletionsApplied(), 1);
	Sync->Release->Trigger();

	// FetchSync lost the claim: it must hand back the completion's result.
	if (!Future.WaitFor(FTimespan::FromMilliseconds(static_cast<double>(RaceStepBoundMs))))
	{
		AddError(TEXT("FetchSync never returned after losing the claim to the completion (deadlock)"));
		Mock.Stop();
		return false;
	}
	const FFetchResult Result = Future.Get();

	// Keep pumping a moment: a cancel or a second completion in this
	// branch would surface as one more completion run.
	const double SettleUntil = FPlatformTime::Seconds() + 0.5;
	while (FPlatformTime::Seconds() < SettleUntil)
	{
		Manager.Tick(0.01f);
		FPlatformProcess::Sleep(0.01f);
	}
	const int32 RequestCount = Mock.RequestCount();
	Mock.Stop();

	TestEqual(TEXT("the request was sent once"), RequestCount, 1);
	TestTrue(TEXT("the completion's result stands: fetched"), Result.Status == EFetchStatus::Fetched);
	TestTrue(TEXT("the completion's result stands: config body"), Result.Body.IsValid());
	TestEqual(TEXT("the completion's result stands: ETag"), Result.ETag, FString(TEXT("\"race-1\"")));
	TestTrue(
		FString::Printf(TEXT("no failure reason (got '%s')"), *Result.Error),
		Result.Error.IsEmpty());
	TestEqual(TEXT("the completion ran once and claimed"), Fetcher->CompletionsApplied(), 1);
	TestEqual(TEXT("no completion was discarded (no cancel, no second run)"), Fetcher->CompletionsDiscarded(), 0);
	// A successful fetch logs nothing, so ANY line is the give-up's.
	const TArray<FString> Lines = Logger->Snapshot();
	TestEqual(TEXT("no timeout line (the give-up lost the claim)"), Lines.Num(), 0);
	return true;
}

// #803 — ProcessRequest returning false. A backend's failure path may fire
// the completion from inside ProcessRequest and still return false: that
// completion owns the result and logs its one line, and FetchSync returns
// it — no NotStarted on top, no wait that never ends. A refusal that fires
// nothing is NotStarted, logged once. No request reaches the network in
// either case: the hook stands in for ProcessRequest.
bool FConfeatureWireProcessRequestRefusedTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString Key = TEXT("configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02");
	const TArray<FString> Secrets{
		Key, TEXT("FAKEfixtureKeyNotRea01"), TEXT("FAKEfixtureKeyNotRea02")};

	FMockServer Mock;
	if (!Mock.IsValid())
	{
		AddError(TEXT("failed to bind loopback socket"));
		return false;
	}
	Mock.Start();

	struct FScenario
	{
		const TCHAR* Name;
		bool bFireCompletion;
		const TCHAR* WantError;
		int32 WantApplied;
	};
	const FScenario Scenarios[] = {
		{TEXT("completed, then refused"), true, FetchError::TransportFailed, 1},
		{TEXT("refused, nothing fired"), false, FetchError::NotStarted, 0},
	};

	for (const FScenario& Scenario : Scenarios)
	{
		const TSharedRef<FCapturingLogger> Logger = MakeShared<FCapturingLogger>();
		const TSharedRef<FConfigFetcher, ESPMode::ThreadSafe> Fetcher = MakeShared<FConfigFetcher, ESPMode::ThreadSafe>(
			Key, TEXT("0.0.0-wire-test"), BaseUrlFor(Mock), /*TimeoutSeconds=*/60, Logger);
		const bool bFire = Scenario.bFireCompletion;
		FFetchTestHooks Hooks;
		Hooks.ProcessRequest = [bFire](const TSharedRef<IHttpRequest, ESPMode::ThreadSafe>& InRequest) -> bool
		{
			if (bFire)
			{
				// What a backend's failure path does: complete, then refuse.
				InRequest->OnProcessRequestComplete().ExecuteIfBound(InRequest, FHttpResponsePtr(), false);
			}
			return false;
		};
		Fetcher->SetTestHooks(MoveTemp(Hooks));

		TFuture<FFetchResult> Future = Async(
			EAsyncExecution::Thread, [Fetcher]() { return Fetcher->FetchSync(FString()); });
		if (!Future.WaitFor(FTimespan::FromMilliseconds(static_cast<double>(RaceStepBoundMs))))
		{
			AddError(FString::Printf(TEXT("%s: FetchSync never returned (deadlock)"), Scenario.Name));
			continue;
		}
		const FFetchResult Result = Future.Get();

		TestTrue(FString::Printf(TEXT("%s: the fetch failed"), Scenario.Name), Result.Status == EFetchStatus::Failed);
		TestEqual(FString::Printf(TEXT("%s: failure reason"), Scenario.Name), Result.Error, FString(Scenario.WantError));
		TestEqual(
			FString::Printf(TEXT("%s: completions that claimed"), Scenario.Name),
			Fetcher->CompletionsApplied(),
			Scenario.WantApplied);
		TestEqual(
			FString::Printf(TEXT("%s: completions discarded"), Scenario.Name), Fetcher->CompletionsDiscarded(), 0);
		const TArray<FString> Lines = Logger->Snapshot();
		TestEqual(FString::Printf(TEXT("%s: exactly one log line"), Scenario.Name), Lines.Num(), 1);
		if (Lines.Num() == 1)
		{
			TestTrue(
				FString::Printf(TEXT("%s: the line is the owner's reason"), Scenario.Name),
				Lines[0].Contains(Scenario.WantError, ESearchCase::CaseSensitive));
		}
		for (int32 S = 0; S < Secrets.Num(); ++S)
		{
			TestFalse(
				FString::Printf(TEXT("%s: secret #%d absent from FFetchResult.Error"), Scenario.Name, S),
				Result.Error.Contains(Secrets[S], ESearchCase::CaseSensitive));
			for (int32 L = 0; L < Lines.Num(); ++L)
			{
				TestFalse(
					FString::Printf(TEXT("%s: secret #%d absent from log line #%d"), Scenario.Name, S, L),
					Lines[L].Contains(Secrets[S], ESearchCase::CaseSensitive));
			}
		}
	}

	const int32 RequestCount = Mock.RequestCount();
	Mock.Stop();
	TestEqual(TEXT("no request reached the network"), RequestCount, 0);
	return true;
}
