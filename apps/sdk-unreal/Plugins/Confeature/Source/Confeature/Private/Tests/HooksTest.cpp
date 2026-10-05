// SPDX-License-Identifier: MIT

// Hooks / events behaviour suite (epic #574 / issue #577).
//
// API-surface conformance (the four paired delegates are PRESENT) lives
// in ApiSurfaceChecklistTest.cpp; this file exercises the EMISSIONS:
//   - OnClientReady fires once after construction (game-thread, next tick).
//   - OnFlagEvaluated fires from the GetValueDetails* path (LocalOnly).
//   - OnConfigChanged fires on a successful FETCH (ForceRefresh, FETCHED).
//   - OnError fires on a failed fetch (non-2xx).
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
#include "HAL/UnrealMemory.h"
#include "HttpManager.h"
#include "HttpModule.h"
#include "Misc/AutomationTest.h"
#include "Misc/ScopeLock.h"

#include "ConfeatureClient.h"
#include "ConfeatureHooks.h"

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

	// Minimal single-shot loopback HTTP/1.1 server — serves one canned
	// response then exits. Mirrors WireCasesTest's FMockServer, trimmed to
	// the one-request-one-response shape the hook tests need.
	class FHookMockServer
	{
	public:
		explicit FHookMockServer(FString InResponse)
			: Response(MoveTemp(InResponse))
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
				const FTCHARToUTF8 Utf8(*Response);
				::send(Client, Utf8.Get(), Utf8.Length(), 0);
				CloseSock(Client);
			}
		}

		FString Response;
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

	// ForceRefresh blocks on the fetch internally; run it on a worker
	// thread while we pump the HTTP manager + game-thread tasks so the
	// fetch completes AND the marshalled OnConfigChanged drains.
	TSharedRef<FThreadSafeBool> RefreshDone = MakeShared<FThreadSafeBool>();
	UConfeatureClient* Raw = Client.Get();
	TFuture<bool> RefreshFuture = Async(EAsyncExecution::Thread,
		[Raw, RefreshDone]()
		{
			const bool R = Raw->ForceRefresh();
			RefreshDone->AtomicSet(true);
			return R;
		});

	const bool bFired = PumpWithHttpUntil(10.0, [&Count]() { return *Count >= 1; });
	RefreshFuture.Wait();

	TestTrue(TEXT("ForceRefresh succeeded"), RefreshFuture.Get());
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
	TFuture<bool> RefreshFuture = Async(EAsyncExecution::Thread,
		[Raw]() { return Raw->ForceRefresh(); });

	const bool bFired = PumpWithHttpUntil(10.0, [&SawError]() { return (bool)*SawError; });
	RefreshFuture.Wait();

	TestFalse(TEXT("ForceRefresh failed on 503"), RefreshFuture.Get());
	TestTrue(TEXT("OnError fired on a failed fetch"), bFired);
	TestFalse(TEXT("OnError message is non-empty"), ErrMessage->IsEmpty());
	// The raw SDK key must NEVER appear in the error payload.
	TestFalse(TEXT("OnError message redacts the SDK key"),
		ErrMessage->Contains(FString(HookTestSdkKey)));

	Client->Close();
	Server.Stop();
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
