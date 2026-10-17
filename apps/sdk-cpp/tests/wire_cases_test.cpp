// SPDX-License-Identifier: MIT

// Wire-protocol fixture suite (C++ consumer).
//
// Drives sdk-cpp's `confeature::internal::ConfigFetcher` against each
// case in `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`.
// The corpus is the language-agnostic contract; this file is the C++
// consumer that maps the fetcher's `FetchStatus` + stringly-typed
// `FetchResult.error` onto the corpus's normalised
// `{fetched, notModified, failed}` x
// `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.
//
// See epic #146 (contract testing framework) + #148 slice 13 (this
// suite) + spec 112. Constitution Principle II (NON-NEGOTIABLE) +
// Principle IV (multi-SDK federation) + Principle VII (local-first
// quality gating).
//
// Layer choice: drives the fetcher directly (NOT ConfeatureClient),
// matching sdk-node / sdk-bun / sdk-deno / sdk-python / sdk-go /
// sdk-rust — the wire-cases corpus by name tests wire behaviour and
// the fetcher is sdk-cpp's wire layer. Driving the public client
// would add poll-service indirection that the corpus does not assert.
//
// Mock pattern: matches the existing `MockServer` test double from
// `config_fetcher_test.cpp` (loopback TCP socket serving canned
// responses). Catch2 v3 `TEST_CASE` + per-case `DYNAMIC_SECTION` gives
// each fixture entry its own named section in the test output.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <fstream>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "internal/config_fetcher.h"
#include "wire_case_assertions.h"
#include "workspace_root.h"

using confeature::internal::ConfigFetcher;
using confeature::internal::FetchResult;
using confeature::internal::FetchStatus;
using confeature::tests::fixturesPath;
using nlohmann::json;
namespace wire = confeature::tests::wire;
using namespace std::chrono_literals;

namespace {

constexpr const char* kWireTestSdkKey =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// The request target of a raw HTTP/1.1 request line, as sent.
std::string requestTarget(const std::string& rawRequest) {
  const auto start = rawRequest.find(' ');
  const auto end = rawRequest.find(' ', start + 1);
  if (start == std::string::npos || end == std::string::npos) {
    return {};
  }
  return rawRequest.substr(start + 1, end - start - 1);
}

// A header's value in a raw request, or nullopt when it is absent. libcurl
// writes header names as given, so the match is on the exact name.
std::optional<std::string> headerValue(const std::string& rawRequest, const std::string& name) {
  const auto at = rawRequest.find("\r\n" + name + ": ");
  if (at == std::string::npos) {
    return std::nullopt;
  }
  const auto from = at + name.size() + 4;
  return rawRequest.substr(from, rawRequest.find("\r\n", from) - from);
}

// Minimal blocking HTTP/1.1 server tailored to ConfigFetcher's surface.
// Matches the pattern from `config_fetcher_test.cpp` — kept private to
// this TU so Catch2 binaries don't share state across translation units.
class MockServer {
 public:
  MockServer() {
    sock_ = ::socket(AF_INET, SOCK_STREAM, 0);
    REQUIRE(sock_ >= 0);
    int yes = 1;
    REQUIRE(::setsockopt(sock_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)) == 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    REQUIRE(::bind(sock_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    socklen_t len = sizeof(addr);
    REQUIRE(::getsockname(sock_, reinterpret_cast<sockaddr*>(&addr), &len) == 0);
    port_ = ntohs(addr.sin_port);
    REQUIRE(::listen(sock_, 4) == 0);
  }

  ~MockServer() {
    stop();
    if (sock_ >= 0) {
      ::close(sock_);
    }
  }

  MockServer(const MockServer&) = delete;
  MockServer& operator=(const MockServer&) = delete;

  void enqueue(std::string response) {
    std::lock_guard<std::mutex> guard(responsesMutex_);
    responses_.push_back(std::move(response));
  }

  // Selects how the mock transport acts on the next accepted connection
  // (#590), mirroring the corpus `server.behavior` discriminator:
  //   - Respond          : read the request, send the queued response (default).
  //   - Timeout          : read the request, then hang — never reply. The
  //                        fetcher's CURLOPT_TIMEOUT fires →
  //                        CURLE_OPERATION_TIMEDOUT → "Timeout was reached".
  //   - CloseMidResponse : read the request, write status + headers
  //                        promising a Content-Length larger than the
  //                        bytes actually sent, then slam the socket. The
  //                        fetcher's libcurl transfer aborts mid-body
  //                        (CURLE_PARTIAL_FILE / CURLE_RECV_ERROR) BEFORE
  //                        the JSON parse step → fetchFailed, never
  //                        parseFailed.
  enum class Behavior { Respond, Timeout, CloseMidResponse };

  void setBehavior(Behavior behavior) { behavior_ = behavior; }

  void start() {
    thread_ = std::thread([this]() { run(); });
  }

  void stop() {
    if (!thread_.joinable()) {
      return;
    }
    stopping_.store(true);
    // Wake any Timeout-behaviour handler parked on the release CV so the
    // worker thread can return from handleOne() and re-check stopping_.
    {
      std::lock_guard<std::mutex> guard(releaseMutex_);
      released_ = true;
    }
    releaseCv_.notify_all();
    // Self-connect to unblock accept().
    int wake = ::socket(AF_INET, SOCK_STREAM, 0);
    if (wake >= 0) {
      sockaddr_in addr{};
      addr.sin_family = AF_INET;
      addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      addr.sin_port = htons(port_);
      ::connect(wake, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
      ::close(wake);
    }
    thread_.join();
  }

  std::string lastRequest() const {
    std::lock_guard<std::mutex> guard(requestsMutex_);
    if (requests_.empty()) {
      return {};
    }
    return requests_.back();
  }

  std::size_t requestCount() const {
    std::lock_guard<std::mutex> guard(requestsMutex_);
    return requests_.size();
  }

  std::uint16_t port() const { return port_; }

 private:
  void run() {
    while (!stopping_.load()) {
      sockaddr_in clientAddr{};
      socklen_t len = sizeof(clientAddr);
      int client = ::accept(sock_, reinterpret_cast<sockaddr*>(&clientAddr), &len);
      if (client < 0) {
        if (stopping_.load()) {
          return;
        }
        continue;
      }
      if (stopping_.load()) {
        ::close(client);
        return;
      }
      handleOne(client);
      ::close(client);
    }
  }

  void handleOne(int client) {
    std::string raw;
    char buf[4096];
    while (true) {
      ssize_t n = ::recv(client, buf, sizeof(buf), 0);
      if (n <= 0) {
        break;
      }
      raw.append(buf, static_cast<std::size_t>(n));
      auto pos = raw.find("\r\n\r\n");
      if (pos != std::string::npos) {
        break;
      }
      if (raw.size() > (1 << 16)) {
        break;
      }
    }
    {
      std::lock_guard<std::mutex> guard(requestsMutex_);
      requests_.push_back(raw);
    }

    if (behavior_ == Behavior::Timeout) {
      // Read the request (so request-side invariants still hold), then
      // hang without replying until stop() releases us. The fetcher's
      // CURLOPT_TIMEOUT trips first → CURLE_OPERATION_TIMEDOUT.
      std::unique_lock<std::mutex> lock(releaseMutex_);
      releaseCv_.wait(lock, [this]() { return released_; });
      return;
    }

    if (behavior_ == Behavior::CloseMidResponse) {
      // Announce a Content-Length far larger than the bytes we send, then
      // close the socket → the fetcher's transfer aborts mid-body
      // (CURLE_PARTIAL_FILE / CURLE_RECV_ERROR) BEFORE it ever parses,
      // so a truncated body classifies as fetchFailed, not parseFailed.
      const std::string partial =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json\r\n"
          "Content-Length: 4096\r\n"
          "\r\n"
          "{\"p\":{\"s\":\"partial";
      ::send(client, partial.data(), partial.size(), 0);
      // Socket is closed by the caller (run()) right after handleOne().
      return;
    }

    std::string response;
    {
      std::lock_guard<std::mutex> guard(responsesMutex_);
      if (!responses_.empty()) {
        response = responses_.front();
        responses_.erase(responses_.begin());
      }
    }
    if (response.empty()) {
      response =
          "HTTP/1.1 500 Internal Server Error\r\n"
          "Content-Length: 0\r\n"
          "Connection: close\r\n"
          "\r\n";
    }
    ::send(client, response.data(), response.size(), 0);
  }

  int sock_{-1};
  std::uint16_t port_{0};
  std::thread thread_;
  std::atomic<bool> stopping_{false};
  Behavior behavior_{Behavior::Respond};

  mutable std::mutex responsesMutex_;
  std::vector<std::string> responses_;

  mutable std::mutex requestsMutex_;
  std::vector<std::string> requests_;

  // Releases a parked Timeout-behaviour handler on stop().
  std::mutex releaseMutex_;
  std::condition_variable releaseCv_;
  bool released_{false};
};

std::string baseUrlFor(const MockServer& server) {
  std::ostringstream os;
  os << "http://127.0.0.1:" << server.port();
  return os.str();
}

// Resolves a case's response body — either inlined raw text (`body`)
// or a reference to a sibling fixture (`bodyRef`). Either may be null
// for 304-style responses.
std::string resolveBody(const json& server) {
  if (server.contains("bodyRef") && !server["bodyRef"].is_null()) {
    const auto refPath = fixturesPath() / server["bodyRef"].get<std::string>();
    std::ifstream stream(refPath);
    REQUIRE(stream.is_open());
    std::ostringstream buf;
    buf << stream.rdbuf();
    return buf.str();
  }
  if (server.contains("body") && !server["body"].is_null()) {
    return server["body"].get<std::string>();
  }
  return std::string();
}

// Crafts a canned HTTP/1.1 response from a case's `server` block.
std::string buildResponse(const json& server, const std::string& body) {
  std::ostringstream os;
  const auto status = server.at("status").get<int>();
  os << "HTTP/1.1 " << status << " ";
  // Reason phrase — Catch2's failure messages only echo what we send,
  // so make it human-friendly. libcurl ignores it.
  switch (status) {
    case 200:
      os << "OK";
      break;
    case 304:
      os << "Not Modified";
      break;
    case 404:
      os << "Not Found";
      break;
    case 503:
      os << "Service Unavailable";
      break;
    default:
      os << "Unknown";
      break;
  }
  os << "\r\n";
  if (server.contains("headers") && server["headers"].is_object()) {
    for (auto it = server["headers"].begin(); it != server["headers"].end(); ++it) {
      // libcurl already strips Content-Length on 304, but be explicit:
      // we set Content-Length explicitly below.
      const auto name = it.key();
      if (name == "Content-Length") {
        continue;
      }
      os << name << ": " << it.value().get<std::string>() << "\r\n";
    }
  }
  os << "Content-Length: " << body.size() << "\r\n";
  os << "Connection: close\r\n";
  os << "\r\n";
  os << body;
  return os.str();
}

}  // namespace

TEST_CASE("wire-cases.json — a field this consumer does not read fails the case", "[wire_cases]") {
  // Proves the strict field check fails closed (#803 FR-003).
  const auto expected = json::parse(R"({"outcome":"fetched","requestPath":"/p","bogus":1})");
  REQUIRE(wire::firstUnknownField(expected, wire::kKnownExpectedFields) == std::string("bogus"));
  const auto given = json::parse(R"({"previousEtag":null,"sdkKey":"k","baseUrl":"b"})");
  REQUIRE_FALSE(wire::firstUnknownField(given, wire::kKnownGivenFields).has_value());
}

TEST_CASE("wire-cases.json — the error mapping fails closed", "[wire_cases]") {
  // A reason the mapping does not know is "unknown", which fails its case,
  // never a silent fetchFailed (#924).
  REQUIRE(wire::cppErrorToClass("cancelled") == "unknown");
  REQUIRE(wire::cppErrorToClass("") == "unknown");
  REQUIRE(wire::cppErrorToClass("HTTP 403") == "invalidSdkKey");
  REQUIRE(wire::cppErrorToClass("HTTP 503") == "fetchFailed");
}

TEST_CASE("wire-cases.json — wire-protocol conformance (sdk-cpp)", "[wire_cases]") {
  // Cross-language gate: wire-cases.json drives every Confeature SDK
  // wire-layer test. This consumer maps the C++ fetcher's outcome onto
  // the normalised vocabulary. Any drift here is a Principle II
  // regression — fix the SDK, never mutate the corpus.
  const auto corpus = wire::loadCorpus();
  REQUIRE(corpus.is_object());
  REQUIRE(corpus.contains("cases"));
  REQUIRE(corpus["cases"].is_array());
  // 17 cases: #491 grew 7→12; #590 added the timeout + network-reset
  // `server.behavior` cases; #803 the three request-path cases.
  REQUIRE(corpus["cases"].size() == 17);

  for (const auto& wireCase : corpus["cases"]) {
    const auto id = wireCase.at("id").get<std::string>();
    DYNAMIC_SECTION(id) {
      wire::requireKnownFields(wireCase);
      const auto& server = wireCase.at("server");

      // Behaviour adapter (#590): the corpus `server.behavior` discriminator
      // selects how the mock transport acts. Absent = "respond" (default).
      // An unrecognised value FAILS the case loudly — never fall through to
      // respond (mirrors sdk-go's behaviour adapter, commit a804507).
      std::string behavior = "respond";
      if (server.contains("behavior") && !server["behavior"].is_null()) {
        behavior = server["behavior"].get<std::string>();
      }

      MockServer mock;
      // The timeout case must outlast the fetcher's request timeout; every
      // other behaviour serves a canned response. CURLOPT_TIMEOUT is whole
      // seconds, so 1 s is the smallest deadline that still trips cleanly.
      std::chrono::seconds requestTimeout = 5s;
      if (behavior == "respond") {
        mock.setBehavior(MockServer::Behavior::Respond);
        mock.enqueue(buildResponse(server, resolveBody(server)));
      } else if (behavior == "timeout") {
        mock.setBehavior(MockServer::Behavior::Timeout);
        requestTimeout = 1s;
      } else if (behavior == "close-mid-response") {
        mock.setBehavior(MockServer::Behavior::CloseMidResponse);
      } else {
        FAIL("wire-cases: unsupported server.behavior '" << behavior << "' — no adapter");
      }
      mock.start();

      const auto sdkKey = wire::sdkKeyFor(wireCase, kWireTestSdkKey);
      ConfigFetcher fetcher(sdkKey, "0.0.0-wire-test", baseUrlFor(mock), requestTimeout, nullptr);
      const FetchResult result = fetcher.fetch(wire::previousEtagOf(wireCase));

      mock.stop();

      // Exactly one request per fetch: a retrying fetcher must not pass.
      REQUIRE(mock.requestCount() == 1);
      const auto request = mock.lastRequest();
      wire::assertWireCase(
          wireCase, sdkKey,
          wire::SentRequest{wire::pathOf(requestTarget(request)), headerValue(request, "If-None-Match")},
          result);
    }
  }
}
