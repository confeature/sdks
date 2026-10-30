// SPDX-License-Identifier: MIT

// sdk-cpp live wire-cases (#924, after sdk-go's #921).
//
// sdk-cpp's own `confeature::internal::ConfigFetcher` — its real libcurl
// stack — against a RUNNING live-contract harness serving the reference
// origin of the CDN read path. Every seeded wire-case is replayed and judged
// by wire_case_assertions.h, the SAME rules the hermetic suite
// (wire_cases_test.cpp) applies to a loopback mock. Nothing is hand-built
// and no admin write is made:
//
//   - the case set comes from the running harness (`GET /admin/state` ->
//     `keys`), never recomputed from the corpus — `http-403` among them, an
//     unseeded key answered by the Worker itself;
//   - the request each case sent is read back from the harness
//     (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
//     judged on the wire, and each fetch must add exactly one entry;
//   - a timeout case is ended by the SDK's OWN deadline (the fetcher's
//     timeout: a quarter of the harness's hold, but at least 1 s, because
//     CURLOPT_TIMEOUT takes whole seconds and reads 0 as no timeout);
//   - US4: one unseeded key reaches the Worker's own unknown-key answer.
//
// The test cases are HIDDEN (`[.live]`): `ctest` (catch_discover_tests) and
// a bare `confeature_tests` never run them. The manifest's
// `liveSuite.runner` runs them by tag, through the harness wrapper:
//
//   confeature_tests "[live]"
//
// and Catch2 v3 exits non-zero when that tag matches nothing or every
// case skips; the runner also requires Catch2's "All tests passed" line.
//
// GATING (fail closed): skipped only when CONFEATURE_LIVE is unset. Set
// without LIVE_HARNESS_URL, or with a harness that does not answer, it
// FAILS; it never skips.

#include <curl/curl.h>

#include <algorithm>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdlib>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "internal/config_fetcher.h"
#include "wire_case_assertions.h"

using confeature::internal::ConfigFetcher;
using confeature::internal::FetchResult;
using confeature::internal::FetchStatus;
using nlohmann::json;
namespace wire = confeature::tests::wire;

namespace {

constexpr const char* kLiveSdkVersion = "0.0.0-live-wire";

// The running harness's base URL; SKIPs a hermetic run and FAILs a live
// run that names no harness.
std::string harnessBase() {
  const char* live = std::getenv("CONFEATURE_LIVE");
  if (live == nullptr || std::string(live) != "1") {
    SKIP("hermetic run: CONFEATURE_LIVE is not set");
  }
  const char* url = std::getenv("LIVE_HARNESS_URL");
  if (url == nullptr || std::string(url).empty()) {
    FAIL(
        "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through "
        "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by "
        "skipping");
  }
  std::string base(url);
  while (!base.empty() && base.back() == '/') {
    base.pop_back();
  }
  return base;
}

size_t appendBody(char* data, size_t size, size_t count, void* out) {
  static_cast<std::string*>(out)->append(data, size * count);
  return size * count;
}

// The harness's JSON answer to GET <base><path>; FAILs on any other answer.
json harnessJson(const std::string& base, const std::string& path) {
  std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
  REQUIRE(curl != nullptr);
  const std::string url = base + path;
  std::string body;
  curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, appendBody);
  curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &body);
  curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 10L);
  const CURLcode code = curl_easy_perform(curl.get());
  long status = 0;
  curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
  INFO("GET " << path << ": " << curl_easy_strerror(code) << ", status " << status << ": " << body);
  REQUIRE(code == CURLE_OK);
  REQUIRE(status == 200);
  return json::parse(body);
}

// The requests the harness logged for sdkKey, oldest first.
json requestsFor(const std::string& base, const std::string& sdkKey) {
  std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
  REQUIRE(curl != nullptr);
  std::unique_ptr<char, decltype(&curl_free)> escaped(
      curl_easy_escape(curl.get(), sdkKey.c_str(), static_cast<int>(sdkKey.size())), curl_free);
  REQUIRE(escaped != nullptr);
  const auto body = harnessJson(base, std::string("/admin/requests?sdkKey=") + escaped.get());
  INFO("harness /admin/requests: " << body.dump());
  REQUIRE(body.value("ok", false));
  REQUIRE(body.at("requests").is_array());
  return body["requests"];
}

}  // namespace

TEST_CASE("wire-cases live — every seeded case against the harness (sdk-cpp)", "[.live]") {
  const auto base = harnessBase();
  const auto state = harnessJson(base, "/admin/state");
  std::vector<std::string> ids = state.value("keys", std::vector<std::string>{});
  std::sort(ids.begin(), ids.end());
  REQUIRE_FALSE(ids.empty());  // an empty run checks nothing
  const auto corpus = wire::loadCorpus();

  for (const auto& id : ids) {
    // Each case is its own section: one that fails is reported and the
    // next one still runs.
    DYNAMIC_SECTION(id) {
      const auto found = std::find_if(corpus["cases"].begin(), corpus["cases"].end(),
                                      [&](const json& c) { return c.at("id") == id; });
      INFO("seeded key " << id << " must be a corpus case");
      REQUIRE(found != corpus["cases"].end());
      const json& wireCase = *found;
      wire::requireKnownFields(wireCase);

      // A timeout case: the SDK's own deadline, at most a quarter of the
      // hold, must end the fetch, not the harness releasing it (#783 A8).
      std::chrono::milliseconds hold{0};
      std::chrono::seconds deadline{10};
      if (wireCase.at("server").value("behavior", "respond") == "timeout") {
        const auto fault = state.value("faults", json::object()).value(id, json::object());
        hold = std::chrono::milliseconds(fault.value("ms", 0));
        INFO(id << " is seeded with fault " << fault.dump());
        // CURLOPT_TIMEOUT takes whole seconds and reads 0 as "no timeout",
        // so the deadline is a quarter of the hold, but never under 1 s;
        // it must still end the fetch before the hold does.
        deadline = std::max(std::chrono::seconds(1),
                            std::chrono::duration_cast<std::chrono::seconds>(hold / 4));
        REQUIRE(deadline < hold);
      }

      // The harness seeds each case under its id; a case pinning
      // given.sdkKey is configured with that key instead (#803 FR-003).
      const auto sdkKey = wire::sdkKeyFor(wireCase, id);
      const auto before = requestsFor(base, sdkKey).size();
      ConfigFetcher fetcher(sdkKey, kLiveSdkVersion, base, deadline, nullptr);
      const auto started = std::chrono::steady_clock::now();
      const FetchResult result = fetcher.fetch(wire::previousEtagOf(wireCase));
      const auto elapsed = std::chrono::steady_clock::now() - started;

      const auto log = requestsFor(base, sdkKey);
      // Exactly one request per fetch: a retrying SDK, or a request an
      // earlier run logged, must not stand in for the one under test.
      REQUIRE(log.size() - before == 1);
      if (hold.count() > 0) {
        CHECK(elapsed < hold);
      }
      const auto& last = log.back();
      std::optional<std::string> ifNoneMatch;
      if (last.contains("ifNoneMatch") && !last["ifNoneMatch"].is_null()) {
        ifNoneMatch = last["ifNoneMatch"].get<std::string>();
      }
      wire::assertWireCase(
          wireCase, sdkKey,
          wire::SentRequest{wire::pathOf(last.at("url").get<std::string>()), ifNoneMatch}, result);
    }
  }
}

TEST_CASE("wire-cases live — an unseeded key is the CDN's own 403 (sdk-cpp)", "[.live]") {
  // US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
  // 403 since #785, classed like a 404 as invalidSdkKey.
  const auto base = harnessBase();
  ConfigFetcher fetcher("never-seeded-924", kLiveSdkVersion, base, std::chrono::seconds(10),
                        nullptr);
  const FetchResult result = fetcher.fetch(std::nullopt);
  REQUIRE(result.status == FetchStatus::Failed);
  const auto error = confeature::tests::requireValue(result.error, "the fetch error");
  INFO("raw error=" << error);
  CHECK(wire::cppErrorToClass(error) == "invalidSdkKey");
}
