// SPDX-License-Identifier: MIT

// The one set of rules a wire-case is judged by, shared by the hermetic
// suite (wire_cases_test.cpp, a loopback mock) and the live suite
// (wire_cases_live_test.cpp, the running live-contract harness, #924), so
// the two cannot drift: what the offline suite proves against a mock is
// what the live suite proves against the reference origin.
//
// Header-only and test-only: each including translation unit gets its own
// copy of these inline functions, with Catch2's assertion macros.

#pragma once

#include <algorithm>
#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "internal/config_fetcher.h"
#include "require_value.h"
#include "workspace_root.h"

namespace confeature::tests::wire {

using nlohmann::json;

// What one fetch sent, as the suite observed it: the request target's path
// (still escaped, query excluded) and the If-None-Match header (nullopt
// when absent).
struct SentRequest {
  std::string path;
  std::optional<std::string> ifNoneMatch;
};

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
inline std::string cppErrorToClass(const std::string& reason) {
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
inline const std::vector<std::string> kKnownGivenFields = {"previousEtag", "sdkKey", "baseUrl"};
inline const std::vector<std::string> kKnownExpectedFields = {
    "requestHeaderIfNoneMatch", "outcome",    "resultingEtag", "hasConfig", "errorClass",
    "requestUrlPrefix",         "requestPath"};

// Returns the first field of `block` this consumer does not read.
inline std::optional<std::string> firstUnknownField(const json& block,
                                                    const std::vector<std::string>& known) {
  for (auto it = block.begin(); it != block.end(); ++it) {
    if (std::find(known.begin(), known.end(), it.key()) == known.end()) {
      return it.key();
    }
  }
  return std::nullopt;
}

// A request target's PATH (still escaped, query excluded), so #807's query
// parameter never breaks a path pin.
inline std::string pathOf(const std::string& target) { return target.substr(0, target.find('?')); }

// Loads the wire-cases corpus from the shared fixtures package (see
// wire-cases.json's $schema for the authoritative shape).
inline json loadCorpus() {
  std::ifstream stream(fixturesPath() / "wire-cases.json");
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  return json::parse(buf.str());
}

// The key a suite configures its fetcher with: the corpus's given.sdkKey
// when the case pins one, else the suite's own default (a legacy-shaped
// key offline, the case id live — the key the harness seeds).
inline std::string sdkKeyFor(const json& wireCase, const std::string& fallback) {
  const auto& given = wireCase.at("given");
  return given.contains("sdkKey") ? given["sdkKey"].get<std::string>() : fallback;
}

// given.previousEtag, explicitly nullable in the corpus.
inline std::optional<std::string> previousEtagOf(const json& wireCase) {
  const auto& given = wireCase.at("given");
  if (given.contains("previousEtag") && !given["previousEtag"].is_null()) {
    return given["previousEtag"].get<std::string>();
  }
  return std::nullopt;
}

// The exact path a case's request must carry (#803 FR-001): the corpus's
// requestPath when the case pins one, else ConfigCat's
// /configuration-files/<sdkKey>/config_v6.json with the key verbatim —
// which is how a suite proves the SDK sent the key it was configured with.
inline std::string requestPathFor(const json& wireCase, const std::string& sdkKey) {
  const auto& expected = wireCase.at("expected");
  if (expected.contains("requestPath")) {
    return expected["requestPath"].get<std::string>();
  }
  return "/configuration-files/" + sdkKey + "/config_v6.json";
}

// Fails the case when it carries a field this consumer does not read.
inline void requireKnownFields(const json& wireCase) {
  const auto unknownGiven = firstUnknownField(wireCase.at("given"), kKnownGivenFields);
  const auto unknownExpected = firstUnknownField(wireCase.at("expected"), kKnownExpectedFields);
  INFO("unknown given." << unknownGiven.value_or("") << " / expected."
                        << unknownExpected.value_or("") << " — this consumer must read it");
  REQUIRE_FALSE(unknownGiven.has_value());
  REQUIRE_FALSE(unknownExpected.has_value());
}

// The request side: the exact path as sent, no legacy /v2/, a custom base
// leading the fetcher's URL, and the If-None-Match three-state round-trip
// (explicit null = absent, a string = verbatim, no key = unasserted).
inline void assertRequest(const json& wireCase, const std::string& sdkKey,
                          const SentRequest& sent) {
  const auto& given = wireCase.at("given");
  const auto& expected = wireCase.at("expected");
  CHECK(sent.path == requestPathFor(wireCase, sdkKey));
  CHECK(sent.path.find("/v2/") == std::string::npos);
  // A custom base must lead the request URL (custom-base-url). Checked on
  // the fetcher's url(), the one place the GET's URL is formed, because the
  // case's host is not routable from a test.
  REQUIRE(given.contains("baseUrl") == expected.contains("requestUrlPrefix"));
  if (given.contains("baseUrl")) {
    const confeature::internal::ConfigFetcher custom(
        sdkKey, "0.0.0-wire-test", given["baseUrl"].get<std::string>(), std::chrono::seconds(1),
        nullptr);
    const auto url = confeature::tests::requireValue(custom.url(), "the custom base url");
    const auto prefix = expected["requestUrlPrefix"].get<std::string>();
    INFO("url=" << url << " prefix=" << prefix);
    CHECK(url.rfind(prefix, 0) == 0);
  }
  if (expected.contains("requestHeaderIfNoneMatch")) {
    const auto& want = expected["requestHeaderIfNoneMatch"];
    if (want.is_null()) {
      CHECK_FALSE(sent.ifNoneMatch.has_value());
    } else {
      REQUIRE(sent.ifNoneMatch.has_value());
      CHECK(sent.ifNoneMatch == want.get<std::string>());
    }
  }
}

// The outcome side: the fetcher's status and reason code against the
// corpus's {fetched, notModified, failed} x errorClass vocabulary, and
// hasConfig: the round-trip did / did not yield a config body.
inline void assertOutcome(const json& wireCase, const confeature::internal::FetchResult& result) {
  using confeature::internal::FetchStatus;
  const auto& expected = wireCase.at("expected");
  const auto outcome = expected.at("outcome").get<std::string>();
  INFO("error=" << result.error.value_or("<none>"));
  if (outcome == "fetched" || outcome == "notModified") {
    const bool fetched = outcome == "fetched";
    REQUIRE(result.status == (fetched ? FetchStatus::Fetched : FetchStatus::NotModified));
    CHECK(result.body.has_value() == fetched);
    if (expected.contains("resultingEtag") && !expected["resultingEtag"].is_null()) {
      REQUIRE(result.etag.has_value());
      CHECK(result.etag == expected["resultingEtag"].get<std::string>());
    }
  } else if (outcome == "failed") {
    REQUIRE(result.status == FetchStatus::Failed);
    CHECK(cppErrorToClass(confeature::tests::requireValue(result.error, "the fetch error")) ==
          expected.at("errorClass").get<std::string>());
  } else {
    FAIL("unknown outcome in corpus: " << outcome);
  }
  if (expected.contains("hasConfig")) {
    CHECK(result.body.has_value() == expected["hasConfig"].get<bool>());
  }
}

// Judges one fetch of a case — the request it sent and the result it
// returned — by the corpus's expectations.
inline void assertWireCase(const json& wireCase, const std::string& sdkKey,
                           const SentRequest& sent,
                           const confeature::internal::FetchResult& result) {
  assertRequest(wireCase, sdkKey, sent);
  assertOutcome(wireCase, result);
}

}  // namespace confeature::tests::wire
