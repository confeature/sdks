// SPDX-License-Identifier: MIT

#include "internal/config_fetcher.h"

#include <arpa/inet.h>
#include <curl/curl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "internal/sdk_key.h"

using confeature::LogLevel;
using confeature::internal::buildConfigUrl;
using confeature::internal::ConfigFetcher;
using confeature::internal::FetchResult;
using confeature::internal::FetchStatus;
using confeature::internal::kMaxBodyBytes;
using confeature::internal::redactSdkKey;
using confeature::internal::redirectProtocolsFor;
using namespace std::chrono_literals;

namespace {

// Minimal blocking HTTP/1.1 server tailored to ConfigFetcher's surface.
// We serve at most N canned responses and capture the request line +
// headers so the test can assert on them.
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

  void enqueue(std::string response) {
    std::lock_guard<std::mutex> guard(responsesMutex_);
    responses_.push_back(std::move(response));
  }

  // Served on every connection once the queue is empty (default: 500).
  void setFallback(std::string response) {
    std::lock_guard<std::mutex> guard(responsesMutex_);
    fallback_ = std::move(response);
  }

  void start() {
    thread_ = std::thread([this]() { run(); });
  }

  void stop() {
    if (!thread_.joinable()) {
      return;
    }
    stopping_.store(true);
    // Open a self-connection to unblock accept(). Any failure means
    // the loop already exited.
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

    std::string response;
    {
      std::lock_guard<std::mutex> guard(responsesMutex_);
      response = fallback_;
      if (!responses_.empty()) {
        response = std::move(responses_.front());
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
    sendAll(client, response);
  }

  // Sends the whole response; a peer that hangs up early (a body the
  // fetcher refuses) ends it without SIGPIPE killing the test process.
  static void sendAll(int client, const std::string& response) {
#ifdef SO_NOSIGPIPE
    int yes = 1;
    ::setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
#endif
#ifdef MSG_NOSIGNAL
    constexpr int kFlags = MSG_NOSIGNAL;
#else
    constexpr int kFlags = 0;
#endif
    std::size_t sent = 0;
    while (sent < response.size()) {
      const ssize_t n = ::send(client, response.data() + sent, response.size() - sent, kFlags);
      if (n <= 0) {
        return;
      }
      sent += static_cast<std::size_t>(n);
    }
  }

  int sock_{-1};
  std::uint16_t port_{0};
  std::thread thread_;
  std::atomic<bool> stopping_{false};

  mutable std::mutex responsesMutex_;
  std::vector<std::string> responses_;
  std::string fallback_;

  mutable std::mutex requestsMutex_;
  std::vector<std::string> requests_;
};

std::string baseUrlFor(const MockServer& server) {
  std::ostringstream os;
  os << "http://127.0.0.1:" << server.port();
  return os.str();
}

// The request target's PATH as sent (still escaped, query excluded), so a
// later query parameter (#807) never breaks a path pin.
std::string requestPath(const std::string& rawRequest) {
  const auto start = rawRequest.find(' ');
  const auto end = rawRequest.find(' ', start + 1);
  if (start == std::string::npos || end == std::string::npos) {
    return {};
  }
  const auto target = rawRequest.substr(start + 1, end - start - 1);
  return target.substr(0, target.find('?'));
}

// Records every log line so a test can assert what never reaches one.
class CapturingLogger : public confeature::Logger {
 public:
  void log(LogLevel /*level*/, std::string_view message) override {
    std::lock_guard<std::mutex> guard(mutex_);
    lines_.emplace_back(message);
  }

  std::vector<std::string> lines() const {
    std::lock_guard<std::mutex> guard(mutex_);
    return lines_;
  }

 private:
  mutable std::mutex mutex_;
  std::vector<std::string> lines_;
};

// Valid shapes from sdk-key-shapes.json.
constexpr const char* kLegacyKey =
    "confeature-sdk-1-FAKE_fixtureKeyN-otRealFAKEfi-03-FAKEfixtureKeyNotRealFAKEfixtu04";
constexpr const char* kConfigCatKey =
    "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";

constexpr const char* kFetchedResponse =
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: application/json\r\n"
    "Content-Length: 8\r\n"
    "Connection: close\r\n"
    "\r\n"
    "{\"f\":{}}";

// Fetches once with `sdkKey` against a fresh mock; returns the parsed path.
std::string fetchedPathFor(const std::string& sdkKey) {
  MockServer server;
  server.enqueue(kFetchedResponse);
  server.start();
  ConfigFetcher fetcher(sdkKey, "1.0.0", baseUrlFor(server), 5s, nullptr);
  const auto result = fetcher.fetch(std::nullopt);
  server.stop();
  REQUIRE(result.status == FetchStatus::Fetched);
  return requestPath(server.lastRequest());
}

// Asserts neither the full key nor any of its 22-char parts reached a log
// line or the fetch result's error, and that the only log line is the
// fixed one: no library text (curl_easy_strerror, the error buffer, the
// effective URL) rides along.
void requireKeyFree(const std::string& sdkKey, const CapturingLogger& logger,
                    const FetchResult& result) {
  const std::vector<std::string> secrets = {sdkKey, sdkKey.substr(16, 22), sdkKey.substr(39, 22)};
  REQUIRE(result.error.has_value());
  const std::string error = result.error.value_or("");
  const auto lines = logger.lines();
  REQUIRE(lines == std::vector<std::string>{"ConfigFetcher: fetch raised (sdkKey=" +
                                            redactSdkKey(sdkKey) + ", reason=" + error + ")"});
  for (const auto& secret : secrets) {
    INFO("secret part: " << secret.size() << " chars");
    REQUIRE(error.find(secret) == std::string::npos);
    for (const auto& line : lines) {
      REQUIRE(line.find(secret) == std::string::npos);
    }
  }
}

}  // namespace

TEST_CASE("ConfigFetcher resolves a 200 fetch + captures the ETag", "[config_fetcher]") {
  MockServer server;
  server.enqueue(
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/json\r\n"
      "Content-Length: 12\r\n"
      "ETag: \"abc123\"\r\n"
      "Connection: close\r\n"
      "\r\n"
      "{\"f\":{}}    ");
  server.start();

  ConfigFetcher fetcher(kLegacyKey, "9.9.9", baseUrlFor(server), 5s, nullptr);
  auto result = fetcher.fetch(std::nullopt);
  REQUIRE(result.status == FetchStatus::Fetched);
  REQUIRE(result.body.has_value());
  REQUIRE(result.etag.has_value());
  REQUIRE(result.etag.value() == "\"abc123\"");

  const auto request = server.lastRequest();
  REQUIRE(request.find("confeature-cpp-sdk/9.9.9") != std::string::npos);
  REQUIRE(requestPath(request) ==
          std::string("/configuration-files/") + kLegacyKey + "/config_v6.json");
}

TEST_CASE("ConfigFetcher routes through If-None-Match for 304", "[config_fetcher]") {
  MockServer server;
  server.enqueue(
      "HTTP/1.1 304 Not Modified\r\n"
      "ETag: \"abc123\"\r\n"
      "Connection: close\r\n"
      "\r\n");
  server.start();

  ConfigFetcher fetcher("confeature-sdk-1-test", "1.0.0", baseUrlFor(server), 5s, nullptr);
  auto result = fetcher.fetch(std::string("\"abc123\""));
  REQUIRE(result.status == FetchStatus::NotModified);
  REQUIRE(result.etag.value() == "\"abc123\"");

  const auto request = server.lastRequest();
  REQUIRE(request.find("If-None-Match: \"abc123\"") != std::string::npos);
}

TEST_CASE("ConfigFetcher surfaces non-2xx as Failed", "[config_fetcher]") {
  MockServer server;
  server.enqueue(
      "HTTP/1.1 500 Internal Server Error\r\n"
      "Content-Length: 0\r\n"
      "Connection: close\r\n"
      "\r\n");
  server.start();

  ConfigFetcher fetcher("confeature-sdk-1-test", "1.0.0", baseUrlFor(server), 5s, nullptr);
  auto result = fetcher.fetch(std::nullopt);
  REQUIRE(result.status == FetchStatus::Failed);
  REQUIRE(result.error.has_value());
}

TEST_CASE("ConfigFetcher reports MALFORMED_JSON on garbled body", "[config_fetcher]") {
  MockServer server;
  server.enqueue(
      "HTTP/1.1 200 OK\r\n"
      "Content-Length: 7\r\n"
      "Connection: close\r\n"
      "\r\n"
      "{ broke");
  server.start();

  ConfigFetcher fetcher("confeature-sdk-1-test", "1.0.0", baseUrlFor(server), 5s, nullptr);
  auto result = fetcher.fetch(std::nullopt);
  REQUIRE(result.status == FetchStatus::Failed);
  REQUIRE(result.error.value() == "MALFORMED_JSON");
}

TEST_CASE("ConfigFetcher sends a legacy key raw, as ConfigCat does", "[config_fetcher]") {
  // configcat/cpp-sdk src/configfetcher.cpp:110 —
  // `url + "/configuration-files/" + sdkKey + "/" + kConfigJsonName` (#803).
  REQUIRE(fetchedPathFor(kLegacyKey) ==
          std::string("/configuration-files/") + kLegacyKey + "/config_v6.json");
}

TEST_CASE("ConfigFetcher sends a ConfigCat-shaped key raw, its '/' kept", "[config_fetcher]") {
  REQUIRE(fetchedPathFor(kConfigCatKey) ==
          "/configuration-files/configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d/"
          "config_v6.json");
}

TEST_CASE("ConfigFetcher escapes a malformed key into ONE path segment", "[config_fetcher]") {
  // sdk-key-shapes.json `new shape, bad character`: fails the shape check,
  // so its '/' and '!' are escaped (Go's url.PathEscape bytes).
  REQUIRE(fetchedPathFor("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3n!/pQ5rS7tU9vW1xY3zA5bC7d") ==
          "/configuration-files/configcat-sdk-1%2FaB3_-dE5fG7hI9jK1lM3n%21%2F"
          "pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json");
  REQUIRE(buildConfigUrl("https://cdn.example", " a b\n") ==
          "https://cdn.example/configuration-files/%20a%20b%0A/config_v6.json");
}

TEST_CASE("ConfigFetcher sends Go's url.PathEscape bytes on the wire, unaltered by libcurl",
          "[config_fetcher]") {
  // The RAW request line the mock received — libcurl must not re-encode
  // or normalise it. Literal = real `go run` output of url.PathEscape
  // (wire-cases.json `request-path-malformed-key`).
  MockServer server;
  server.enqueue(kFetchedResponse);
  server.start();
  // The key's UTF-8 bytes are spelled out: e-acute (2 bytes), euro sign
  // (3 bytes) and U+1F600 (4 bytes), each escaped byte by byte.
  ConfigFetcher fetcher("bad key$&+:=@,;!'()*~/x?y#z%\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80..",
                        "1.0.0", baseUrlFor(server), 5s, nullptr);
  const auto result = fetcher.fetch(std::nullopt);
  server.stop();
  REQUIRE(result.status == FetchStatus::Fetched);
  const auto request = server.lastRequest();
  REQUIRE(request.substr(0, request.find("\r\n")) ==
          "GET /configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25"
          "%C3%A9%E2%82%AC%F0%9F%98%80../config_v6.json HTTP/1.1");
}

TEST_CASE("ConfigFetcher never requests /v2/ nor a hash of the key", "[config_fetcher]") {
  const auto url = buildConfigUrl("https://cdn.example", kConfigCatKey);
  REQUIRE(url == std::string("https://cdn.example/configuration-files/") + kConfigCatKey +
                     "/config_v6.json");
  REQUIRE(url->find("/v2/") == std::string::npos);
}

TEST_CASE("ConfigFetcher refuses to fetch for an empty, '.' or '..' key", "[config_fetcher]") {
  for (const std::string key : {"", ".", ".."}) {
    DYNAMIC_SECTION("key '" << key << "'") {
      MockServer server;
      server.start();
      auto logger = std::make_shared<CapturingLogger>();
      ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 5s, logger);
      REQUIRE_FALSE(fetcher.url().has_value());
      const auto result = fetcher.fetch(std::nullopt);
      server.stop();
      REQUIRE(result.status == FetchStatus::Failed);
      REQUIRE(result.error == "INVALID_SDK_KEY");
      REQUIRE(server.requestCount() == 0);
      const auto lines = logger->lines();
      REQUIRE(lines.size() == 1);
      REQUIRE(lines.front().find("INVALID_SDK_KEY") != std::string::npos);
    }
  }
}

TEST_CASE("ConfigFetcher keeps the key out of logs and errors on transport failures",
          "[config_fetcher]") {
  // #803 FR-002/FR-004: the URL now carries the key, so a library message
  // quoting it must never reach a log line or FetchResult.error.
  const std::string key = kConfigCatKey;

  SECTION("timeout") {
    MockServer server;  // listening, never accepting: the request hangs
    auto logger = std::make_shared<CapturingLogger>();
    ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 1s, logger);
    const auto result = fetcher.fetch(std::nullopt);
    REQUIRE(result.status == FetchStatus::Failed);
    REQUIRE(result.error == "timeout");
    requireKeyFree(key, *logger, result);
  }

  SECTION("mid-body reset") {
    MockServer server;
    server.enqueue(
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: 4096\r\n"
        "\r\n"
        "{\"f\":{\"partial");
    server.start();
    auto logger = std::make_shared<CapturingLogger>();
    ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 5s, logger);
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.status == FetchStatus::Failed);
    REQUIRE(result.error == "body_read_failed");
    requireKeyFree(key, *logger, result);
  }

  SECTION("redirect loop") {
    MockServer server;
    auto logger = std::make_shared<CapturingLogger>();
    ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 5s, logger);
    // Every response redirects to the key-bearing URL itself.
    server.setFallback("HTTP/1.1 302 Found\r\nLocation: " + fetcher.url().value() +
                       "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    server.start();
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.status == FetchStatus::Failed);
    REQUIRE(result.error == "too_many_redirects");
    REQUIRE(server.requestCount() ==
            static_cast<std::size_t>(confeature::internal::kMaxRedirects) + 1);
    requireKeyFree(key, *logger, result);
  }
}

TEST_CASE("ConfigFetcher never follows an https redirect to clear-text http", "[config_fetcher]") {
  REQUIRE(std::string(redirectProtocolsFor(
              "https://cdn-global.confeature.io/configuration-files/k/config_v6.json")) == "https");
  REQUIRE(std::string(redirectProtocolsFor("HTTPS://cdn.example/x")) == "https");
  REQUIRE(std::string(redirectProtocolsFor("http://127.0.0.1:8080/x")) == "http,https");
  REQUIRE(std::string(redirectProtocolsFor("https:/cdn.example")) == "http,https");
}

TEST_CASE("ConfigFetcher applies its redirect protocol list to the transfer", "[config_fetcher]") {
  // libcurl's default list also follows ftp; ConfigFetcher's never does.
  // Without the option the fetcher would connect to the ftp target (a
  // second request at the mock) and wait for a greeting that never comes.
  bool ftpBuiltIn = false;
  for (const char* const* proto = curl_version_info(CURLVERSION_NOW)->protocols; *proto != nullptr;
       ++proto) {
    ftpBuiltIn = ftpBuiltIn || std::string_view(*proto) == "ftp";
  }
  REQUIRE(ftpBuiltIn);  // else this test would pass without proving anything

  MockServer server;
  const auto key = std::string(kConfigCatKey);
  auto logger = std::make_shared<CapturingLogger>();
  ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 2s, logger);
  server.setFallback(
      "HTTP/1.1 302 Found\r\nLocation: ftp://127.0.0.1:" + std::to_string(server.port()) + "/" +
      key + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  server.start();
  const auto result = fetcher.fetch(std::nullopt);
  server.stop();
  REQUIRE(result.status == FetchStatus::Failed);
  REQUIRE(result.error == "network_error");
  REQUIRE(server.requestCount() == 1);
  requireKeyFree(key, *logger, result);
}

TEST_CASE("ConfigFetcher follows no redirect when libcurl rejects the protocol restriction",
          "[config_fetcher]") {
  // A libcurl build that rejects CURLOPT_REDIR_PROTOCOLS[_STR] must not
  // fall back to libcurl's own list (http included): the fetcher then
  // follows no redirect at all.
  const auto key = std::string(kConfigCatKey);
  MockServer server;
  server.setFallback("HTTP/1.1 302 Found\r\nLocation: " + baseUrlFor(server) +
                     "/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  server.start();
  auto logger = std::make_shared<CapturingLogger>();

  SECTION("the restriction is rejected: the 302 ends the fetch") {
    ConfigFetcher fetcher(
        key, "1.0.0", baseUrlFor(server), 5s, logger,
        [](CURL* /*curl*/, const char* /*protocols*/) { return CURLE_UNKNOWN_OPTION; });
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.status == FetchStatus::Failed);
    REQUIRE(result.error == "HTTP 302");
    REQUIRE(server.requestCount() == 1);
    const std::string redacted = redactSdkKey(key);
    REQUIRE(logger->lines() ==
            std::vector<std::string>{
                "ConfigFetcher: redirect protocols could not be restricted, no redirect will be "
                "followed (sdkKey=" +
                    redacted + ")",
                "ConfigFetcher: fetch failed (sdkKey=" + redacted + ", reason=HTTP 302)"});
  }

  SECTION("the restriction is accepted: the same 302 is followed") {
    ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 5s, logger);
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.error == "too_many_redirects");
    REQUIRE(server.requestCount() ==
            static_cast<std::size_t>(confeature::internal::kMaxRedirects) + 1);
  }
}

TEST_CASE("ConfigFetcher reports MALFORMED_JSON for a number past double, never throws",
          "[config_fetcher]") {
  MockServer server;
  server.enqueue(
      "HTTP/1.1 200 OK\r\n"
      "Content-Length: 18\r\n"
      "Connection: close\r\n"
      "\r\n"
      "{\"f\":{},\"x\":1e400}");
  server.start();
  ConfigFetcher fetcher("confeature-sdk-1-test", "1.0.0", baseUrlFor(server), 5s, nullptr);
  FetchResult result;
  REQUIRE_NOTHROW(result = fetcher.fetch(std::nullopt));
  server.stop();
  REQUIRE(result.status == FetchStatus::Failed);
  REQUIRE(result.error == "MALFORMED_JSON");
}

TEST_CASE("ConfigFetcher caps the response body at kMaxBodyBytes", "[config_fetcher]") {
  // A close-delimited body (no Content-Length), so only the fetcher's own
  // count can stop it.
  const auto responseOf = [](std::size_t bodySize) {
    std::string body = "{\"f\":{}}";
    body.append(bodySize - body.size(), ' ');
    return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + body;
  };

  SECTION("exactly the cap is read") {
    MockServer server;
    server.enqueue(responseOf(kMaxBodyBytes));
    server.start();
    ConfigFetcher fetcher(kConfigCatKey, "1.0.0", baseUrlFor(server), 10s, nullptr);
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.status == FetchStatus::Fetched);
  }

  SECTION("one byte more fails with a fixed code") {
    MockServer server;
    server.enqueue(responseOf(kMaxBodyBytes + 1));
    server.start();
    const auto key = std::string(kConfigCatKey);
    auto logger = std::make_shared<CapturingLogger>();
    ConfigFetcher fetcher(key, "1.0.0", baseUrlFor(server), 10s, logger);
    const auto result = fetcher.fetch(std::nullopt);
    server.stop();
    REQUIRE(result.status == FetchStatus::Failed);
    REQUIRE(result.error == "body_too_large");
    requireKeyFree(key, *logger, result);
  }
}
