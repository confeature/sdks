// SPDX-License-Identifier: MIT

// Hooks / events behaviour suite (epic #574 / issue #577).
//
// API-surface conformance (the four paired delegates are PRESENT) lives
// in ApiSurfaceChecklistTest.cpp; this file exercises the EMISSIONS:
//   - OnClientReady fires once after construction (game-thread, next tick).
//   - OnFlagEvaluated fires from the GetValueDetails* path (LocalOnly).
//   - OnConfigChanged fires on a successful FETCH (ForceRefresh, FETCHED).
//   - OnError fires on a failed fetch (non-2xx).
//   - A body past the 16 MiB cap (#837) fires OnError once and keeps the
//     config the client already held.
//   - ForceRefresh is synchronous like upstream but never deadlocks on the
//     game thread (#832): it pumps the HTTP manager and returns with the
//     fresh config applied and its hooks fired, also while an async
//     refresh holds the fetch lock. ForceRefreshWithCallback and
//     ForceRefreshAsync return at once and deliver the outcome on the game
//     thread after the hooks. Concurrent async calls coalesce into one
//     fetch; Close() during a refresh voids it.
//   - Empty-binding safety: a client with no listeners never crashes.
//   - Both halves of each pair (native FOn* + Blueprint FOn*Bp) carry the
//     same payload from the same site.
//
// Threading: emissions marshal onto the game thread via AsyncTask. The
// Automation test body runs on the game thread, so we PUMP pending
// game-thread tasks (FTaskGraphInterface ProcessThreadUntilIdle +
// FTSTicker) between an action and its assertion, with a bounded deadline.
// The mock HTTP server mirrors WireCasesTest's loopback-socket pattern
// (UE ships no in-process HTTP mock; adding HTTPServer is a forbidden
// plugin dep — see #148 constraints).

#include "CoreMinimal.h"
#include "Async/Async.h"
#include "Async/TaskGraphInterfaces.h"
#include "Containers/Ticker.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/ThreadSafeBool.h"
#include "HAL/FileManager.h"
#include "HAL/UnrealMemory.h"
#include "HttpManager.h"
#include "HttpModule.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "UObject/StrongObjectPtr.h"

#include "ConfeatureClient.h"
#include "ConfeatureHooks.h"
#include "Internal/ConfigFetcher.h"

#include <atomic>

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include "Windows/HideWindowsPlatformTypes.h"
using HookSocketType = SOCKET;
constexpr HookSocketType HookInvalidSocket = INVALID_SOCKET;
constexpr int HookSocketError = SOCKET_ERROR;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
using HookSocketType = int;
constexpr HookSocketType HookInvalidSocket = -1;
constexpr int HookSocketError = -1;
#endif

namespace
{
	// A compliant 76-char SDK key — the same deterministic key the wire
	// suite uses. Any valid-format key works; this keeps failures grep-able.
	constexpr const TCHAR* HookTestSdkKey
		= TEXT("confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-")
		  TEXT("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

	// Pumps game-thread work (AsyncTask GameThread + FTSTicker) until
	// `Predicate` is true or the deadline elapses. Returns the final
	// Predicate value. The hooks marshal via AsyncTask(GameThread), which
	// is drained by ProcessThreadUntilIdle on the game thread.
	bool PumpUntil(double TimeoutSeconds, TFunctionRef<bool()> Predicate)
	{
		const double Deadline = FPlatformTime::Seconds() + TimeoutSeconds;
		while (FPlatformTime::Seconds() < Deadline)
		{
			if (Predicate())
			{
				return true;
			}
			FTaskGraphInterface::Get().ProcessThreadUntilIdle(ENamedThreads::GameThread);
			FTSTicker::GetCoreTicker().Tick(0.01f);
			FPlatformProcess::Sleep(0.005f);
		}
		return Predicate();
	}

	// Pumps both the game-thread task queue AND the HTTP manager — used
	// while a ForceRefresh fetch is in flight (the fetcher's completion
	// delegate fires off the HTTP manager tick).
	bool PumpWithHttpUntil(double TimeoutSeconds, TFunctionRef<bool()> Predicate)
	{
		const double Deadline = FPlatformTime::Seconds() + TimeoutSeconds;
		FHttpManager& Manager = FHttpModule::Get().GetHttpManager();
		while (FPlatformTime::Seconds() < Deadline)
		{
			if (Predicate())
			{
				return true;
			}
			Manager.Tick(0.01f);
			FTaskGraphInterface::Get().ProcessThreadUntilIdle(ENamedThreads::GameThread);
			FTSTicker::GetCoreTicker().Tick(0.01f);
			FPlatformProcess::Sleep(0.005f);
		}
		return Predicate();
	}

	// Minimal loopback HTTP/1.1 server — answers each connection with the
	// next canned response (the last one repeats), then closes it. Mirrors
	// WireCasesTest's FMockServer, trimmed to the one-request-one-response
	// shape the hook tests need.
	class FHookMockServer
	{
	public:
		explicit FHookMockServer(FString InResponse)
			: FHookMockServer(TArray<FString>{MoveTemp(InResponse)})
		{
		}

		explicit FHookMockServer(TArray<FString> InResponses)
			: Responses(MoveTemp(InResponses))
		{
#if PLATFORM_WINDOWS
			WSADATA Data;
			WSAStartup(MAKEWORD(2, 2), &Data);
#endif
			Sock = ::socket(AF_INET, SOCK_STREAM, 0);
			if (Sock == HookInvalidSocket)
			{
				return;
			}
			int Yes = 1;
			::setsockopt(Sock, SOL_SOCKET, SO_REUSEADDR,
				reinterpret_cast<const char*>(&Yes), sizeof(Yes));
			sockaddr_in Addr;
			FMemory::Memzero(Addr);
			Addr.sin_family = AF_INET;
			Addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
			Addr.sin_port = 0;
			if (::bind(Sock, reinterpret_cast<sockaddr*>(&Addr), sizeof(Addr)) == HookSocketError)
			{
				CloseSock(Sock);
				Sock = HookInvalidSocket;
				return;
			}
			socklen_t Len = sizeof(Addr);
			if (::getsockname(Sock, reinterpret_cast<sockaddr*>(&Addr), &Len) == HookSocketError)
			{
				CloseSock(Sock);
				Sock = HookInvalidSocket;
				return;
			}
			Port = ntohs(Addr.sin_port);
			if (::listen(Sock, 4) == HookSocketError)
			{
				CloseSock(Sock);
				Sock = HookInvalidSocket;
				return;
			}
			bValid = true;
		}

		~FHookMockServer()
		{
			Stop();
			if (Sock != HookInvalidSocket)
			{
				CloseSock(Sock);
				Sock = HookInvalidSocket;
			}
#if PLATFORM_WINDOWS
			WSACleanup();
#endif
		}

		FHookMockServer(const FHookMockServer&) = delete;
		FHookMockServer& operator=(const FHookMockServer&) = delete;

		bool IsValid() const { return bValid; }
		uint16 GetPort() const { return Port; }

		// Holds every response back this long after reading the request
		// (#832: long enough that a caller waiting on the fetch would
		// visibly stall). Set before Start().
		void SetResponseDelaySeconds(float Seconds) { ResponseDelaySeconds = Seconds; }

		// Requests read so far.
		int32 RequestCount() const { return Requests.load(); }

		void Start()
		{
			Future = Async(EAsyncExecution::Thread, [this]() { this->Run(); });
		}

		void Stop()
		{
			if (!Future.IsValid())
			{
				return;
			}
			Stopping.AtomicSet(true);
			HookSocketType Wake = ::socket(AF_INET, SOCK_STREAM, 0);
			if (Wake != HookInvalidSocket)
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

	private:
		static void CloseSock(HookSocketType S)
		{
#if PLATFORM_WINDOWS
			::closesocket(S);
#else
			::close(S);
#endif
		}

		void Run()
		{
			while (!Stopping)
			{
				sockaddr_in ClientAddr;
				FMemory::Memzero(ClientAddr);
				socklen_t Len = sizeof(ClientAddr);
				HookSocketType Client
					= ::accept(Sock, reinterpret_cast<sockaddr*>(&ClientAddr), &Len);
				if (Client == HookInvalidSocket)
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
				// Drain the request headers, then send the canned response.
				char Buf[4097];
				FString Raw;
				while (true)
				{
					int N = static_cast<int>(::recv(Client, Buf, sizeof(Buf) - 1, 0));
					if (N <= 0)
					{
						break;
					}
					Buf[N] = '\0';
					Raw.Append(UTF8_TO_TCHAR(Buf));
					if (Raw.Contains(TEXT("\r\n\r\n")) || Raw.Len() > (1 << 16))
					{
						break;
					}
				}
				Requests.fetch_add(1);
				if (ResponseDelaySeconds > 0.0f)
				{
					FPlatformProcess::Sleep(ResponseDelaySeconds);
				}
				const FString& Response = Responses.IsEmpty()
					? FString()
					: Responses[FMath::Min(Served++, Responses.Num() - 1)];
				SendAll(Client, Response);
				CloseSock(Client);
			}
		}

		// Writes all of `Text` as UTF-8, looping over short sends (a body
		// past 16 MiB does not go out in one). A send to a client that
		// hung up fails instead of raising SIGPIPE: MSG_NOSIGNAL where it
		// exists, SO_NOSIGPIPE on Apple.
		static void SendAll(HookSocketType Client, const FString& Text)
		{
#if defined(SO_NOSIGPIPE)
			int NoSigPipe = 1;
			::setsockopt(Client, SOL_SOCKET, SO_NOSIGPIPE, &NoSigPipe, sizeof(NoSigPipe));
#endif
#if defined(MSG_NOSIGNAL)
			constexpr int Flags = MSG_NOSIGNAL;
#else
			constexpr int Flags = 0;
#endif
			const FTCHARToUTF8 Utf8(*Text);
			int64 Offset = 0;
			while (Offset < Utf8.Length())
			{
				const int Chunk = static_cast<int>(FMath::Min<int64>(Utf8.Length() - Offset, 1 << 16));
				const int N = static_cast<int>(::send(Client, Utf8.Get() + Offset, Chunk, Flags));
				if (N <= 0)
				{
					return;
				}
				Offset += N;
			}
		}

		// Touched by the server thread only.
		TArray<FString> Responses;
		int32 Served = 0;
		float ResponseDelaySeconds = 0.0f;
		std::atomic<int32> Requests{0};
		HookSocketType Sock = HookInvalidSocket;
		uint16 Port = 0;
		bool bValid = false;
		FThreadSafeBool Stopping;
		TFuture<void> Future;
	};

	// Builds an HTTP/1.1 200 response carrying a minimal-but-valid
	// config_v6 body ({p, f, s} — passes the fetcher's shape guard).
	FString BuildOkConfigResponse()
	{
		const FString Body = TEXT("{\"p\":{\"s\":\"\"},\"f\":{},\"s\":[]}");
		const FTCHARToUTF8 Utf8Body(*Body);
		return FString::Printf(
			TEXT("HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: %d\r\n")
			TEXT("Connection: close\r\n\r\n%s"),
			Utf8Body.Length(), *Body);
	}

	// A 200 whose body is one byte past the fetcher's 16 MiB cap (#837),
	// length declared — however the backend reports it (the header, the
	// received count, or only the finished body), the fetch must refuse it.
	FString BuildOverCapResponse()
	{
		const int32 Len = static_cast<int32>(Confeature::Internal::MaxBodyBytes) + 1;
		return FString::Printf(
				   TEXT("HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"), Len)
			+ FString::ChrN(Len, TEXT(' '));
	}

	FString BuildBaseUrl(uint16 Port)
	{
		return FString::Printf(TEXT("http://127.0.0.1:%u"), Port);
	}
}

// ── OnClientReady ────────────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksClientReadyTest,
	"Confeature.Hooks.OnClientReady",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksClientReadyTest::RunTest(const FString& /*Parameters*/)
{
	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.Build());

	TSharedRef<int32> NativeCount = MakeShared<int32>(0);
	Client->OnClientReady.AddLambda([NativeCount]() { ++(*NativeCount); });

	const bool bFired = PumpUntil(2.0, [&NativeCount]() { return *NativeCount >= 1; });
	TestTrue(TEXT("OnClientReady fired once after construction"), bFired);
	TestEqual(TEXT("OnClientReady fired exactly once"), *NativeCount, 1);

	Client->Close();
	return true;
}

// ── OnFlagEvaluated ──────────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksFlagEvaluatedTest,
	"Confeature.Hooks.OnFlagEvaluated",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksFlagEvaluatedTest::RunTest(const FString& /*Parameters*/)
{
	TMap<FString, FString> OverrideMap;
	OverrideMap.Add(TEXT("k"), TEXT("true"));
	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.FlagOverrides(FConfeatureFlagOverrides::MakeLocalOnly(OverrideMap))
			.Build());

	TSharedRef<FString> SeenKey = MakeShared<FString>();
	TSharedRef<int32> Count = MakeShared<int32>(0);
	Client->OnFlagEvaluated.AddLambda(
		[SeenKey, Count](UConfeatureEvaluationWrapper* Wrapper)
		{
			if (Wrapper)
			{
				*SeenKey = Wrapper->Details.Key;
				++(*Count);
			}
		});

	FConfeatureUser User;
	const FConfeatureEvaluationDetails Details = Client->GetValueDetailsBool(TEXT("k"), false, User);
	TestTrue(TEXT("override resolved to true"), Details.bValue);

	const bool bFired = PumpUntil(2.0, [&Count]() { return *Count >= 1; });
	TestTrue(TEXT("OnFlagEvaluated fired on GetValueDetailsBool"), bFired);
	TestEqual(TEXT("OnFlagEvaluated carried the requested key"), *SeenKey, FString(TEXT("k")));

	Client->Close();
	return true;
}

// ── OnConfigChanged ──────────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksConfigChangedTest,
	"Confeature.Hooks.OnConfigChanged",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksConfigChangedTest::RunTest(const FString& /*Parameters*/)
{
	FHookMockServer Server(BuildOkConfigResponse());
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping OnConfigChanged: failed to bind loopback socket"));
		return true;
	}
	Server.Start();

	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.BaseUrl(BuildBaseUrl(Server.GetPort()))
			.HttpTimeoutSeconds(5)
			.Build());

	TSharedRef<int32> Count = MakeShared<int32>(0);
	Client->OnConfigChanged.AddLambda(
		[Count](UConfeatureSettingsWrapper* Wrapper) { if (Wrapper) ++(*Count); });

	// ForceRefresh is synchronous; from a worker thread its hooks are
	// marshalled to the game thread, which we pump (HTTP manager + tasks)
	// so the fetch completes AND the OnConfigChanged drains.
	UConfeatureClient* Raw = Client.Get();
	TFuture<void> RefreshFuture = Async(EAsyncExecution::Thread, [Raw]() { Raw->ForceRefresh(); });

	const bool bFired = PumpWithHttpUntil(10.0, [&Count]() { return *Count >= 1; });
	RefreshFuture.Wait();

	TestTrue(TEXT("OnConfigChanged fired on a successful FETCH"), bFired);

	Client->Close();
	Server.Stop();
	return true;
}

// ── OnError ──────────────────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksErrorTest,
	"Confeature.Hooks.OnError",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksErrorTest::RunTest(const FString& /*Parameters*/)
{
	// 503 → the fetcher fails → OnError fires.
	FHookMockServer Server(
		TEXT("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping OnError: failed to bind loopback socket"));
		return true;
	}
	Server.Start();

	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.BaseUrl(BuildBaseUrl(Server.GetPort()))
			.HttpTimeoutSeconds(5)
			.Build());

	TSharedRef<FThreadSafeBool> SawError = MakeShared<FThreadSafeBool>();
	TSharedRef<FString> ErrMessage = MakeShared<FString>();
	Client->OnError.AddLambda(
		[SawError, ErrMessage](const FString& Message, const FString& /*Detail*/)
		{
			*ErrMessage = Message;
			SawError->AtomicSet(true);
		});

	UConfeatureClient* Raw = Client.Get();
	TFuture<void> RefreshFuture = Async(EAsyncExecution::Thread, [Raw]() { Raw->ForceRefresh(); });

	const bool bFired = PumpWithHttpUntil(10.0, [&SawError]() { return (bool)*SawError; });
	RefreshFuture.Wait();

	TestTrue(TEXT("OnError fired on a failed fetch"), bFired);
	TestFalse(TEXT("OnError message is non-empty"), ErrMessage->IsEmpty());
	// The raw SDK key must NEVER appear in the error payload.
	TestFalse(TEXT("OnError message redacts the SDK key"),
		ErrMessage->Contains(FString(HookTestSdkKey)));

	Client->Close();
	Server.Stop();
	return true;
}

// ── Body cap (#837) ──────────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksOverCapBodyTest,
	"Confeature.Hooks.OverCapBodyKeepsConfig",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksOverCapBodyTest::RunTest(const FString& /*Parameters*/)
{
	// First a config serving `k = true`, then a body past the cap.
	const FString Body
		= TEXT("{\"p\":{\"s\":\"\"},\"f\":{\"k\":{\"t\":0,\"v\":{\"b\":true}}},\"s\":[]}");
	const FTCHARToUTF8 Utf8Body(*Body);
	FHookMockServer Server(TArray<FString>{
		FString::Printf(
			TEXT("HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: %d\r\n")
			TEXT("Connection: close\r\n\r\n%s"),
			Utf8Body.Length(), *Body),
		BuildOverCapResponse()});
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping OverCapBodyKeepsConfig: failed to bind loopback socket"));
		return true;
	}
	Server.Start();

	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.BaseUrl(BuildBaseUrl(Server.GetPort()))
			.CacheDirectory(FPaths::Combine(FPaths::ProjectIntermediateDir(),
				TEXT("ConfeatureTests"), FGuid::NewGuid().ToString()))
			.HttpTimeoutSeconds(30)
			.Build());

	TSharedRef<int32> Errors = MakeShared<int32>(0);
	TSharedRef<FString> ErrDetail = MakeShared<FString>();
	Client->OnError.AddLambda(
		[Errors, ErrDetail](const FString& /*Message*/, const FString& Detail)
		{
			*ErrDetail = Detail;
			++(*Errors);
		});

	// Synchronous ForceRefresh on the game thread: it pumps the HTTP
	// manager itself, and its hooks have fired when it returns.
	Client->ForceRefresh();
	FConfeatureUser User;
	TestEqual(TEXT("the first refresh raised no error"), *Errors, 0);
	TestTrue(TEXT("the first config serves k = true"), Client->GetValueBool(TEXT("k"), false, User));

	Client->ForceRefresh();
	// A second OnError would arrive in this window.
	PumpUntil(0.5, []() { return false; });

	TestEqual(TEXT("OnError fired once"), *Errors, 1);
	TestEqual(TEXT("OnError carries the fixed reason"), *ErrDetail,
		FString(Confeature::Internal::FetchError::BodyTooLarge));
	TestFalse(TEXT("OnError detail redacts the SDK key"), ErrDetail->Contains(FString(HookTestSdkKey)));
	TestTrue(TEXT("the previous config is kept"), Client->GetValueBool(TEXT("k"), false, User));

	Client->Close();
	Server.Stop();
	return true;
}

// ── ForceRefresh never blocks the game thread (#832) ─────────────────
//
// Before #832 the Blueprint ForceRefresh fetched synchronously on the game
// thread and waited on a completion only that thread's ticks deliver: the
// frame froze for the whole give-up bound, then the refresh failed. Each
// test below calls from the test (game) thread against a server that
// holds its answer back, and asserts the call returned long before it.
namespace
{
	constexpr float HeldResponseSeconds = 2.0f;
	// A call that returns within this did not wait for the held answer.
	constexpr double NonBlockingBoundSeconds = 0.5;

	TStrongObjectPtr<UConfeatureClient> MakeRefreshClient(const FHookMockServer& Server)
	{
		return TStrongObjectPtr<UConfeatureClient>(
			UConfeatureClient::Builder(FString(HookTestSdkKey))
				.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
				.BaseUrl(BuildBaseUrl(Server.GetPort()))
				.CacheDirectory(FPaths::Combine(FPaths::ProjectIntermediateDir(),
					TEXT("ConfeatureTests"), FGuid::NewGuid().ToString()))
				.HttpTimeoutSeconds(10)
				.Build());
	}

	// What a refresh's observers saw, in the order the game thread saw it.
	struct FRefreshObservations
	{
		int32 ConfigChanged = 0;
		int32 Errors = 0;
		FString ErrorDetail;
		int32 Completions = 0;
		FConfeatureRefreshResult Result;
		bool bCompletedOnGameThread = false;
		// Hooks seen when the completion ran: they must precede it.
		int32 HooksBeforeCompletion = -1;
	};

	void Observe(UConfeatureClient& Client, const TSharedRef<FRefreshObservations>& Seen)
	{
		Client.OnConfigChanged.AddLambda(
			[Seen](UConfeatureSettingsWrapper* /*Settings*/) { ++Seen->ConfigChanged; });
		Client.OnError.AddLambda(
			[Seen](const FString& /*Message*/, const FString& Detail)
			{
				++Seen->Errors;
				Seen->ErrorDetail = Detail;
			});
	}

	TFunction<void(const FConfeatureRefreshResult&)> CompletionInto(
		const TSharedRef<FRefreshObservations>& Seen)
	{
		return [Seen](const FConfeatureRefreshResult& Result)
		{
			++Seen->Completions;
			Seen->Result = Result;
			Seen->bCompletedOnGameThread = IsInGameThread();
			Seen->HooksBeforeCompletion = Seen->ConfigChanged + Seen->Errors;
		};
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksForceRefreshAsyncTest,
	"Confeature.Hooks.ForceRefreshAsyncNonBlocking",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksForceRefreshAsyncTest::RunTest(const FString& /*Parameters*/)
{
	if (!TestTrue(TEXT("the test runs on the game thread"), IsInGameThread()))
	{
		return false;
	}

	// Success: a fetched config. Failure: a 503. Each must deliver the
	// same outcome the blocking bool did, and the same hooks.
	struct FCase
	{
		const TCHAR* Name;
		FString Response;
		bool bWantSuccess;
		int32 WantConfigChanged;
		int32 WantErrors;
		const TCHAR* WantError;
	};
	const FCase Cases[] = {
		{TEXT("fetched"), BuildOkConfigResponse(), true, 1, 0, TEXT("")},
		{TEXT("503"),
			TEXT("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
			false, 0, 1, TEXT("HTTP 503")},
	};

	for (const FCase& Case : Cases)
	{
		FHookMockServer Server(Case.Response);
		if (!Server.IsValid())
		{
			AddWarning(FString::Printf(TEXT("Skipping %s: failed to bind loopback socket"), Case.Name));
			continue;
		}
		Server.SetResponseDelaySeconds(HeldResponseSeconds);
		Server.Start();
		TStrongObjectPtr<UConfeatureClient> Client = MakeRefreshClient(Server);
		const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
		Observe(*Client, Seen);

		const double Start = FPlatformTime::Seconds();
		Client->ForceRefreshAsync(CompletionInto(Seen));
		const double Returned = FPlatformTime::Seconds() - Start;

		TestTrue(
			FString::Printf(TEXT("%s: ForceRefreshAsync returned at once (%.3f s)"), Case.Name, Returned),
			Returned < NonBlockingBoundSeconds);
		TestEqual(FString::Printf(TEXT("%s: no completion inside the call"), Case.Name), Seen->Completions, 0);

		PumpWithHttpUntil(15.0, [&Seen]() { return Seen->Completions >= 1; });
		PumpUntil(0.5, []() { return false; });  // a second completion would land here

		TestEqual(FString::Printf(TEXT("%s: one completion"), Case.Name), Seen->Completions, 1);
		TestTrue(FString::Printf(TEXT("%s: completed on the game thread"), Case.Name), Seen->bCompletedOnGameThread);
		TestTrue(FString::Printf(TEXT("%s: success == %d"), Case.Name, Case.bWantSuccess ? 1 : 0),
			Seen->Result.bSuccess == Case.bWantSuccess);
		TestEqual(FString::Printf(TEXT("%s: reason"), Case.Name), Seen->Result.ErrorMessage, FString(Case.WantError));
		TestEqual(FString::Printf(TEXT("%s: OnConfigChanged"), Case.Name), Seen->ConfigChanged, Case.WantConfigChanged);
		TestEqual(FString::Printf(TEXT("%s: OnError"), Case.Name), Seen->Errors, Case.WantErrors);
		TestEqual(FString::Printf(TEXT("%s: OnError detail"), Case.Name), Seen->ErrorDetail,
			FString(Case.WantErrors > 0 ? Case.WantError : TEXT("")));
		TestEqual(FString::Printf(TEXT("%s: hooks fired before the completion"), Case.Name),
			Seen->HooksBeforeCompletion, Case.WantConfigChanged + Case.WantErrors);

		Client->Close();
		Server.Stop();
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksForceRefreshBlueprintTest,
	"Confeature.Hooks.ForceRefreshWithCallbackNonBlocking",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// The non-blocking Blueprint node, called as a graph calls it with nothing
// bound to the pin: it returns at once, the hooks fire later.
bool FConfeatureHooksForceRefreshBlueprintTest::RunTest(const FString& /*Parameters*/)
{
	if (!TestTrue(TEXT("the test runs on the game thread"), IsInGameThread()))
	{
		return false;
	}
	FHookMockServer Server(BuildOkConfigResponse());
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping ForceRefreshWithCallbackNonBlocking: failed to bind loopback socket"));
		return true;
	}
	Server.SetResponseDelaySeconds(HeldResponseSeconds);
	Server.Start();
	TStrongObjectPtr<UConfeatureClient> Client = MakeRefreshClient(Server);
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Observe(*Client, Seen);

	const double Start = FPlatformTime::Seconds();
	Client->ForceRefreshWithCallback(FConfeatureOnRefreshCompletedBp());
	const double Returned = FPlatformTime::Seconds() - Start;
	TestTrue(FString::Printf(TEXT("ForceRefreshWithCallback returned at once (%.3f s)"), Returned),
		Returned < NonBlockingBoundSeconds);
	const bool bChanged = PumpWithHttpUntil(15.0, [&Seen]() { return Seen->ConfigChanged >= 1; });
	PumpUntil(0.5, []() { return false; });
	TestTrue(TEXT("OnConfigChanged fired"), bChanged);
	TestEqual(TEXT("OnConfigChanged fired once"), Seen->ConfigChanged, 1);
	TestEqual(TEXT("no OnError"), Seen->Errors, 0);
	TestEqual(TEXT("one request"), Server.RequestCount(), 1);

	Client->Close();
	Server.Stop();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksSyncRefreshOnGameThreadTest,
	"Confeature.Hooks.ForceRefreshOnGameThreadSeesFreshConfig",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// The #832 defect, inverted. Upstream's synchronous ForceRefresh on the
// game thread, with NO external pumping, against a server that holds its
// answer: it waits for the answer (it really blocks, as upstream does),
// returns well inside the request timeout (no deadlock), and the very next
// GetValue sees the fresh config — with OnConfigChanged already fired.
bool FConfeatureHooksSyncRefreshOnGameThreadTest::RunTest(const FString& /*Parameters*/)
{
	if (!TestTrue(TEXT("the test runs on the game thread"), IsInGameThread()))
	{
		return false;
	}
	const FString Body
		= TEXT("{\"p\":{\"s\":\"\"},\"f\":{\"k\":{\"t\":0,\"v\":{\"b\":true}}},\"s\":[]}");
	const FTCHARToUTF8 Utf8Body(*Body);
	FHookMockServer Server(FString::Printf(
		TEXT("HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"),
		Utf8Body.Length(), *Body));
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping ForceRefreshOnGameThreadSeesFreshConfig: failed to bind loopback socket"));
		return true;
	}
	Server.SetResponseDelaySeconds(1.0f);
	Server.Start();
	TStrongObjectPtr<UConfeatureClient> Client = MakeRefreshClient(Server);  // 10 s request timeout
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Observe(*Client, Seen);
	FConfeatureUser User;
	TestFalse(TEXT("before: k is not served"), Client->GetValueBool(TEXT("k"), false, User));

	const double Start = FPlatformTime::Seconds();
	Client->ForceRefresh();
	const double Elapsed = FPlatformTime::Seconds() - Start;

	TestTrue(FString::Printf(TEXT("it waited for the held answer (%.2f s)"), Elapsed), Elapsed >= 0.9);
	TestTrue(FString::Printf(TEXT("no deadlock: well inside the timeout (%.2f s)"), Elapsed), Elapsed < 5.0);
	TestTrue(TEXT("GetValue sees the fresh config"), Client->GetValueBool(TEXT("k"), false, User));
	TestEqual(TEXT("OnConfigChanged fired before ForceRefresh returned"), Seen->ConfigChanged, 1);
	TestEqual(TEXT("no OnError"), Seen->Errors, 0);
	TestEqual(TEXT("one request"), Server.RequestCount(), 1);

	Client->Close();
	Server.Stop();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksSyncRefreshDuringAsyncTest,
	"Confeature.Hooks.ForceRefreshDuringAsyncRefresh",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// A synchronous ForceRefresh on the game thread while an async refresh
// holds the fetch lock: the async refresh's completion is delivered only by
// game-thread HTTP ticks, so a plain lock would deadlock. The game thread
// pumps while it waits for the lock: the async fetch ends, then its own.
bool FConfeatureHooksSyncRefreshDuringAsyncTest::RunTest(const FString& /*Parameters*/)
{
	FHookMockServer Server(BuildOkConfigResponse());
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping ForceRefreshDuringAsyncRefresh: failed to bind loopback socket"));
		return true;
	}
	Server.SetResponseDelaySeconds(1.0f);
	Server.Start();
	TStrongObjectPtr<UConfeatureClient> Client = MakeRefreshClient(Server);  // 10 s request timeout
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Observe(*Client, Seen);

	Client->ForceRefreshAsync(CompletionInto(Seen));
	// The async fetch is under way (its request reached the server).
	PumpWithHttpUntil(5.0, [&Server]() { return Server.RequestCount() >= 1; });

	const double Start = FPlatformTime::Seconds();
	Client->ForceRefresh();
	const double Elapsed = FPlatformTime::Seconds() - Start;
	PumpUntil(2.0, [&Seen]() { return Seen->Completions >= 1; });

	TestTrue(FString::Printf(TEXT("no deadlock (%.2f s)"), Elapsed), Elapsed < 8.0);
	TestEqual(TEXT("two requests: the async one, then the synchronous one"), Server.RequestCount(), 2);
	TestEqual(TEXT("the async completion arrived"), Seen->Completions, 1);
	TestTrue(TEXT("the async refresh succeeded"), Seen->Result.bSuccess);
	TestEqual(TEXT("no OnError"), Seen->Errors, 0);

	Client->Close();
	Server.Stop();
	return true;
}

// ── Refresh coalescing + close guard (#832 review) ───────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksRefreshCoalescesTest,
	"Confeature.Hooks.ForceRefreshCoalesces",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// Three calls while one refresh is in flight: one request, one
// OnConfigChanged, three completions with the same outcome — so no two
// refreshes race on the cached config and ETag.
bool FConfeatureHooksRefreshCoalescesTest::RunTest(const FString& /*Parameters*/)
{
	FHookMockServer Server(BuildOkConfigResponse());
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping ForceRefreshCoalesces: failed to bind loopback socket"));
		return true;
	}
	Server.SetResponseDelaySeconds(HeldResponseSeconds);
	Server.Start();
	TStrongObjectPtr<UConfeatureClient> Client = MakeRefreshClient(Server);
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Observe(*Client, Seen);
	TSharedRef<int32> Successes = MakeShared<int32>(0);
	for (int32 I = 0; I < 3; ++I)
	{
		Client->ForceRefreshAsync(
			[Seen, Successes](const FConfeatureRefreshResult& Result)
			{
				++Seen->Completions;
				*Successes += Result.bSuccess ? 1 : 0;
			});
	}
	PumpWithHttpUntil(15.0, [&Seen]() { return Seen->Completions >= 3; });
	PumpUntil(0.5, []() { return false; });

	TestEqual(TEXT("three completions"), Seen->Completions, 3);
	TestEqual(TEXT("all three succeeded"), *Successes, 3);
	TestEqual(TEXT("one request"), Server.RequestCount(), 1);
	TestEqual(TEXT("OnConfigChanged fired once"), Seen->ConfigChanged, 1);

	Client->Close();
	Server.Stop();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksCloseDuringRefreshTest,
	"Confeature.Hooks.CloseDuringRefresh",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// Close() while the fetch is in flight: the late response writes neither
// the config nor the cache, fires no hook, and reports CLIENT_CLOSED.
bool FConfeatureHooksCloseDuringRefreshTest::RunTest(const FString& /*Parameters*/)
{
	FHookMockServer Server(BuildOkConfigResponse());
	if (!Server.IsValid())
	{
		AddWarning(TEXT("Skipping CloseDuringRefresh: failed to bind loopback socket"));
		return true;
	}
	Server.SetResponseDelaySeconds(HeldResponseSeconds);
	Server.Start();
	const FString CacheDir = FPaths::Combine(
		FPaths::ProjectIntermediateDir(), TEXT("ConfeatureTests"), FGuid::NewGuid().ToString());
	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.BaseUrl(BuildBaseUrl(Server.GetPort()))
			.CacheDirectory(CacheDir)
			.HttpTimeoutSeconds(10)
			.Build());
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Observe(*Client, Seen);

	Client->ForceRefreshAsync(CompletionInto(Seen));
	// The request reaches the server, then the client closes.
	PumpWithHttpUntil(5.0, [&Server]() { return Server.RequestCount() >= 1; });
	const double ClosedAt = FPlatformTime::Seconds();
	Client->Close();
	PumpWithHttpUntil(15.0, [&Seen]() { return Seen->Completions >= 1; });
	const double Ended = FPlatformTime::Seconds() - ClosedAt;
	PumpUntil(0.5, []() { return false; });

	// Close() cancelled the request: the refresh ended before the server's
	// held answer would have.
	TestTrue(FString::Printf(TEXT("the cancel ended the refresh early (%.2f s)"), Ended),
		Ended < HeldResponseSeconds * 0.75);

	TestEqual(TEXT("one request"), Server.RequestCount(), 1);
	TestEqual(TEXT("one completion"), Seen->Completions, 1);
	TestFalse(TEXT("the refresh failed"), Seen->Result.bSuccess);
	TestEqual(TEXT("it reports CLIENT_CLOSED"), Seen->Result.ErrorMessage, FString(TEXT("CLIENT_CLOSED")));
	TestEqual(TEXT("no OnConfigChanged"), Seen->ConfigChanged, 0);
	TestEqual(TEXT("no OnError"), Seen->Errors, 0);
	TArray<FString> Files;
	IFileManager::Get().FindFiles(Files, *FPaths::Combine(CacheDir, TEXT("*")), true, false);
	TestEqual(TEXT("nothing written to the cache"), Files.Num(), 0);

	Server.Stop();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksRefreshUninitializedTest,
	"Confeature.Hooks.ForceRefreshUninitialized",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

// A client never built through Create / Builder (a bare NewObject) has no
// fetcher: the refresh completes on a later tick with CLIENT_NOT_INITIALIZED.
bool FConfeatureHooksRefreshUninitializedTest::RunTest(const FString& /*Parameters*/)
{
	TStrongObjectPtr<UConfeatureClient> Client(NewObject<UConfeatureClient>());
	const TSharedRef<FRefreshObservations> Seen = MakeShared<FRefreshObservations>();
	Client->ForceRefreshAsync(CompletionInto(Seen));
	TestEqual(TEXT("no completion inside the call"), Seen->Completions, 0);
	PumpUntil(2.0, [&Seen]() { return Seen->Completions >= 1; });
	TestEqual(TEXT("one completion"), Seen->Completions, 1);
	TestFalse(TEXT("the refresh failed"), Seen->Result.bSuccess);
	TestEqual(TEXT("CLIENT_NOT_INITIALIZED"), Seen->Result.ErrorMessage, FString(TEXT("CLIENT_NOT_INITIALIZED")));
	Client->ForceRefresh();  // no fetcher: returns at once, no crash
	TestEqual(TEXT("the synchronous variant completes nothing"), Seen->Completions, 1);
	return true;
}

// ── Empty-binding safety ─────────────────────────────────────────────
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureHooksEmptyBindingSafeTest,
	"Confeature.Hooks.EmptyBindingSafe",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureHooksEmptyBindingSafeTest::RunTest(const FString& /*Parameters*/)
{
	// No listeners bound on ANY delegate — every emission must be a no-op,
	// never a crash (a delegate with no bindings is a safe Broadcast()).
	TMap<FString, FString> OverrideMap;
	OverrideMap.Add(TEXT("k"), TEXT("true"));
	TStrongObjectPtr<UConfeatureClient> Client(
		UConfeatureClient::Builder(FString(HookTestSdkKey))
			.PollingMode(FConfeaturePollingModeConfig::ManualPollMode())
			.FlagOverrides(FConfeatureFlagOverrides::MakeLocalOnly(OverrideMap))
			.Build());

	FConfeatureUser User;
	(void)Client->GetValueDetailsBool(TEXT("k"), false, User);

	// Drain the marshalled emissions; reaching here without a crash is the
	// assertion.
	PumpUntil(1.0, []() { return false; });
	TestTrue(TEXT("emissions with no listeners did not crash"), true);

	Client->Close();
	return true;
}
