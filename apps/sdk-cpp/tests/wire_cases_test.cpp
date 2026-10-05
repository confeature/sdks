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
#include "workspace_root.h"

using confeature::internal::ConfigFetcher;
using confeature::internal::FetchResult;
using confeature::internal::FetchStatus;
using confeature::tests::fixturesPath;
using nlohmann::json;
using namespace std::chrono_literals;

namespace {

constexpr const char* kWireTestSdkKey =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Maps the fetcher's FIXED reason codes (#803 FR-002) onto the corpus's
// normalised error-class vocabulary:
//
//   - "MALFORMED_JSON"         -> parseFailed   (JSON.parse failure OR wrong shape)
//   - "HTTP 403" / "HTTP 404"  -> invalidSdkKey (CDN rejected the key — per ConfigCat
//                                 only 403/404 are invalid-SDK-key statuses; 401 is a
//                                 generic retryable failure)
//   - "INVALID_SDK_KEY"        -> invalidSdkKey (key unsendable; no request made)
//   - "HTTP <other non-2xx>"   -> fetchFailed
//   - "timeout"                -> timeout       (CURLE_OPERATION_TIMEDOUT)
//   - "body_read_failed"       -> fetchFailed   (a body truncated by a mid-response
//                                 connection drop — never parseFailed; #590)
//   - "network_error" /        -> fetchFailed
//     "too_many_redirects" /
//     "body_too_large" /
//     "curl_init_failed"
//
// Any other reason maps to "unknown" and FAILS the case: folding an
// unexpected failure into fetchFailed would hide it (mirrors sdk-go's
// `goErrorToClass`).
std::string cppErrorToClass(const std::string& reason) {
  if (reason == "MALFORMED_JSON") {
    return "parseFailed";
  }
  if (reason == "HTTP 403" || reason == "HTTP 404" || reason == "INVALID_SDK_KEY") {
    return "invalidSdkKey";
  }
  if (reason.rfind("HTTP ", 0) == 0) {
    return "fetchFailed";
  }
  if (reason == "timeout") {
    return "timeout";
  }
  if (reason == "body_read_failed" || reason == "network_error" || reason == "too_many_redirects" ||
      reason == "body_too_large" || reason == "curl_init_failed") {
    return "fetchFailed";
  }
  return "unknown";
}

// The `given` / `expected` fields this consumer reads (schema 1.3). A case
// carrying any other field FAILS: a new expectation is never skipped
// silently (#803 FR-003 — the reason 12 suites missed `requestUrlPrefix`).
const std::vector<std::string> kKnownGivenFields = {"previousEtag", "sdkKey", "baseUrl"};
const std::vector<std::string> kKnownExpectedFields = {
    "requestHeaderIfNoneMatch", "outcome",    "resultingEtag", "hasConfig", "errorClass",
    "requestUrlPrefix",         "requestPath"};

// Returns the first field of `block` this consumer does not read.
std::optional<std::string> firstUnknownField(const json& block,
                                             const std::vector<std::string>& known) {
  for (auto it = block.begin(); it != block.end(); ++it) {
    if (std::find(known.begin(), known.end(), it.key()) == known.end()) {
      return it.key();
    }
  }
  return std::nullopt;
}

// The request target's PATH as sent (still escaped, query excluded), so
// #807's query parameter never breaks a path pin.
std::string requestPath(const std::string& rawRequest) {
  const auto start = rawRequest.find(' ');
  const auto end = rawRequest.find(' ', start + 1);
  if (start == std::string::npos || end == std::string::npos) {
    return {};
  }
  const auto target = rawRequest.substr(start + 1, end - start - 1);
  return target.substr(0, target.find('?'));
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

// Loads the wire-cases corpus from the shared fixtures package. The
// fixture grew 7→12 (#491) → 14 (#590 added the timeout + network-reset
// `server.behavior` cases) — see wire-cases.json's $schema for the
// authoritative shape.
json loadCorpus() {
  std::ifstream stream(fixturesPath() / "wire-cases.json");
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  return json::parse(buf.str());
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
  REQUIRE(firstUnknownField(expected, kKnownExpectedFields) == std::string("bogus"));
  const auto given = json::parse(R"({"previousEtag":null,"sdkKey":"k","baseUrl":"b"})");
  REQUIRE_FALSE(firstUnknownField(given, kKnownGivenFields).has_value());
}

TEST_CASE("wire-cases.json — wire-protocol conformance (sdk-cpp)", "[wire_cases]") {
  // Cross-language gate: wire-cases.json drives every Confeature SDK
  // wire-layer test. This consumer maps the C++ fetcher's outcome onto
  // the normalised vocabulary. Any drift here is a Principle II
  // regression — fix the SDK, never mutate the corpus.
  const auto corpus = loadCorpus();
  REQUIRE(corpus.is_object());
  REQUIRE(corpus.contains("cases"));
  REQUIRE(corpus["cases"].is_array());
  // 16 cases: #491 grew 7→12; #590 added the timeout + network-reset
  // `server.behavior` cases; #803 the three request-path cases.
  REQUIRE(corpus["cases"].size() == 17);

  for (const auto& wireCase : corpus["cases"]) {
    const auto id = wireCase.at("id").get<std::string>();
    DYNAMIC_SECTION(id) {
      const auto& given = wireCase.at("given");
      const auto& server = wireCase.at("server");
      const auto& expected = wireCase.at("expected");
      const auto unknownGiven = firstUnknownField(given, kKnownGivenFields);
      const auto unknownExpected = firstUnknownField(expected, kKnownExpectedFields);
      INFO("unknown given." << unknownGiven.value_or("") << " / expected."
                            << unknownExpected.value_or("") << " — this consumer must read it");
      REQUIRE_FALSE(unknownGiven.has_value());
      REQUIRE_FALSE(unknownExpected.has_value());

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

      std::optional<std::string> prevEtag;
      if (given.contains("previousEtag") && !given["previousEtag"].is_null()) {
        prevEtag = given["previousEtag"].get<std::string>();
      }

      std::string sdkKey = kWireTestSdkKey;
      if (given.contains("sdkKey")) {
        sdkKey = given["sdkKey"].get<std::string>();
      }

      ConfigFetcher fetcher(sdkKey, "0.0.0-wire-test", baseUrlFor(mock), requestTimeout, nullptr);
      const FetchResult result = fetcher.fetch(prevEtag);

      mock.stop();

      // ---- Request-side invariants ------------------------------------
      const auto request = mock.lastRequest();
      REQUIRE_FALSE(request.empty());
      // The parsed path as sent (still escaped, query excluded), compared
      // EXACTLY: the corpus's requestPath when the case pins one, else
      // ConfigCat's /configuration-files/<sdkKey>/config_v6.json for the
      // default legacy key, which FR-001 sends verbatim.
      std::string wantPath = "/configuration-files/" + sdkKey + "/config_v6.json";
      if (expected.contains("requestPath")) {
        wantPath = expected["requestPath"].get<std::string>();
      }
      REQUIRE(requestPath(request) == wantPath);

      // A custom base must lead the request URL (custom-base-url). The mock
      // stands in for the network, so the custom-base fetcher's URL is
      // checked without sending it.
      REQUIRE(given.contains("baseUrl") == expected.contains("requestUrlPrefix"));
      if (given.contains("baseUrl")) {
        const ConfigFetcher custom(sdkKey, "0.0.0-wire-test", given["baseUrl"].get<std::string>(),
                                   requestTimeout, nullptr);
        REQUIRE(custom.url().has_value());
        const auto prefix = expected["requestUrlPrefix"].get<std::string>();
        INFO("url=" << *custom.url() << " prefix=" << prefix);
        REQUIRE(custom.url()->rfind(prefix, 0) == 0);
      }

      // If-None-Match round-trip: corpus uses three-state semantics —
      // explicit null means the header MUST be absent; a string value
      // means the header MUST equal it verbatim. Absent key = unasserted.
      if (expected.contains("requestHeaderIfNoneMatch")) {
        const auto& expectedHeader = expected["requestHeaderIfNoneMatch"];
        if (expectedHeader.is_null()) {
          REQUIRE(request.find("If-None-Match:") == std::string::npos);
        } else {
          const std::string wantLine = "If-None-Match: " + expectedHeader.get<std::string>();
          REQUIRE(request.find(wantLine) != std::string::npos);
        }
      }

      // ---- Outcome assertions -----------------------------------------
      const auto outcome = expected.at("outcome").get<std::string>();
      if (outcome == "fetched") {
        REQUIRE(result.status == FetchStatus::Fetched);
        REQUIRE(result.body.has_value());
        if (expected.contains("resultingEtag") && !expected["resultingEtag"].is_null()) {
          REQUIRE(result.etag.has_value());
          REQUIRE(result.etag.value() == expected["resultingEtag"].get<std::string>());
        }
      } else if (outcome == "notModified") {
        REQUIRE(result.status == FetchStatus::NotModified);
        REQUIRE_FALSE(result.body.has_value());
        if (expected.contains("resultingEtag") && !expected["resultingEtag"].is_null()) {
          REQUIRE(result.etag.has_value());
          REQUIRE(result.etag.value() == expected["resultingEtag"].get<std::string>());
        }
      } else if (outcome == "failed") {
        REQUIRE(result.status == FetchStatus::Failed);
        REQUIRE(result.error.has_value());
        const auto mapped = cppErrorToClass(result.error.value());
        const auto wantClass = expected.at("errorClass").get<std::string>();
        INFO("raw error=" << result.error.value() << " mapped=" << mapped << " want=" << wantClass);
        REQUIRE(mapped == wantClass);
      } else {
        FAIL("unknown outcome in corpus: " << outcome);
      }
      if (expected.contains("hasConfig")) {
        REQUIRE(result.body.has_value() == expected["hasConfig"].get<bool>());
      }
    }
  }
}
