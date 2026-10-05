// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_CONFIG_FETCHER_H_
#define CONFEATURE_INTERNAL_CONFIG_FETCHER_H_

// HTTP wrapper around libcurl for the Confeature CDN.
//
// Responsibilities:
//   - User-Agent: `confeature-cpp-sdk/{VERSION}` (FR-012).
//   - `If-None-Match` support for 304 reuse (FR-011).
//   - Configurable request timeout (default 30 s).
//   - SDK key redaction in EVERY log line + error message (FR-013).
//   - Every transport / body failure reduced to a FIXED, key-free reason
//     code (#803 FR-002): the request URL carries the SDK key, so no
//     library message is ever passed on.
//
// libcurl is the de-facto C HTTP client on POSIX. We use the easy
// interface synchronously — the SDK's polling thread already provides
// concurrency, so multi/event-loop integration is overkill in v0.1.

#include <curl/curl.h>

#include <chrono>
#include <cstddef>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>

#include "confeature/logger.h"

namespace confeature::internal {

inline constexpr auto kDefaultBaseUrl = "https://cdn-global.confeature.io";
inline constexpr std::chrono::seconds kDefaultTimeout{30};
// Redirects followed before a fetch fails with `too_many_redirects`
// (net/http's default, as in sdk-go).
inline constexpr long kMaxRedirects = 10;
// Largest response body read before a fetch fails with `body_too_large`
// (a config_v6 document is kilobytes; this only bounds a hostile or
// broken server).
inline constexpr std::size_t kMaxBodyBytes = std::size_t{16} * 1024 * 1024;

enum class FetchStatus { Fetched, NotModified, Failed };

struct FetchResult {
  FetchStatus status{FetchStatus::Failed};
  std::optional<nlohmann::json> body;
  std::optional<std::string> etag;
  std::optional<std::string> error;
};

// Escapes `segment` for ONE URL path segment — the byte set Go's
// `url.PathEscape` keeps (RFC 3986 unreserved plus `$&+:=@`); every
// other byte, `/` included, becomes `%XX`.
std::string escapePathSegment(std::string_view segment);

// The ONE function that builds the config URL (#803 FR-001), mirroring
// ConfigCat's `<base>/configuration-files/<sdkKey>/config_v6.json`
// (configcat/cpp-sdk src/configfetcher.cpp:110 sends the key raw):
//   - a key of the shared shape (`isValidConfeatureKeyFormat`) goes in
//     RAW — its `/`-separated parts, each segment-escaped (a no-op);
//   - any other key is escaped into ONE segment, and `std::nullopt`
//     (no fetch) is returned when that segment is empty, `.` or `..`.
// `baseUrl` is used as given (the caller strips trailing slashes).
std::optional<std::string> buildConfigUrl(std::string_view baseUrl, std::string_view sdkKey);

// The protocols a redirect from `url` may follow (libcurl's
// CURLOPT_REDIR_PROTOCOLS_STR syntax). The URL carries the SDK key, so an
// https URL follows https only — never a downgrade to clear-text http.
const char* redirectProtocolsFor(std::string_view url);

// Restricts the protocols `curl` may follow a redirect to (`protocols` in
// `redirectProtocolsFor` syntax); returns libcurl's code. ConfigFetcher
// follows redirects only when this returns CURLE_OK.
using RedirectProtocolSetter = CURLcode (*)(CURL* curl, const char* protocols);

// The production setter: CURLOPT_REDIR_PROTOCOLS_STR (libcurl >= 7.85.0),
// else the CURLOPT_REDIR_PROTOCOLS bitmask.
CURLcode setRedirectProtocols(CURL* curl, const char* protocols);

class ConfigFetcher {
 public:
  // `redirectProtocolSetter` is a test seam: a setter that fails stands in
  // for a libcurl build that rejects the redirect protocol option.
  ConfigFetcher(std::string sdkKey, const std::string& version, std::optional<std::string> baseUrl,
                std::chrono::seconds timeout, std::shared_ptr<Logger> logger,
                RedirectProtocolSetter redirectProtocolSetter = setRedirectProtocols);

  // Returns the resolved CDN URL the fetcher targets, or `std::nullopt`
  // when the key cannot be sent (see `buildConfigUrl`).
  const std::optional<std::string>& url() const { return url_; }
  const std::string& userAgent() const { return userAgent_; }

  // Issues a single synchronous GET. NEVER throws; failure lands in
  // FetchResult{status=Failed, error=...} with the SDK key redacted in
  // any log line.
  FetchResult fetch(std::optional<std::string> prevEtag);

 private:
  std::string sdkKey_;
  std::optional<std::string> url_;
  std::string userAgent_;
  std::chrono::seconds timeout_;
  std::shared_ptr<Logger> logger_;
  RedirectProtocolSetter redirectProtocolSetter_;
};

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_CONFIG_FETCHER_H_
