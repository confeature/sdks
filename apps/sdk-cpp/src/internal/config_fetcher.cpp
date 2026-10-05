// SPDX-License-Identifier: MIT

#include "internal/config_fetcher.h"

#include <curl/curl.h>

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "confeature/logger.h"
#include "internal/sdk_key.h"

namespace confeature::internal {

namespace {

// The response body, bounded at kMaxBodyBytes.
struct BodySink {
  std::string bytes;
  bool tooLarge{false};
};

// libcurl write callback: appends the response body chunk, or aborts the
// transfer (a short count = CURLE_WRITE_ERROR) once it would pass
// kMaxBodyBytes.
std::size_t writeToBody(char* ptr, std::size_t size, std::size_t nmemb, void* userdata) {
  auto* sink = static_cast<BodySink*>(userdata);
  const std::size_t total = size * nmemb;
  if (total > kMaxBodyBytes - sink->bytes.size()) {
    sink->tooLarge = true;
    return 0;
  }
  sink->bytes.append(ptr, total);
  return total;
}

// libcurl header callback: captures the ETag header (case-insensitive
// match) for `If-None-Match` re-use on the next fetch.
std::size_t writeEtagHeader(char* ptr, std::size_t size, std::size_t nmemb, void* userdata) {
  auto* etag = static_cast<std::optional<std::string>*>(userdata);
  std::size_t total = size * nmemb;
  std::string line(ptr, total);
  // Header lines arrive terminated with "\r\n"; strip them.
  while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) {
    line.pop_back();
  }
  // ASCII case-insensitive "ETag:" prefix match.
  if (line.size() >= 5) {
    auto eq = [](char a, char b) {
      auto lower = [](char c) { return static_cast<char>((c >= 'A' && c <= 'Z') ? (c + 32) : c); };
      return lower(a) == lower(b);
    };
    if (eq(line[0], 'e') && eq(line[1], 't') && eq(line[2], 'a') && eq(line[3], 'g') &&
        line[4] == ':') {
      auto pos = line.find_first_not_of(" \t", 5);
      *etag = (pos == std::string::npos) ? std::string() : line.substr(pos);
    }
  }
  return total;
}

// Reduces a libcurl failure to a FIXED, key-free reason code (#803
// FR-002) — sdk-go's `classifyError` pattern. The request URL carries the
// SDK key, so no library text (`curl_easy_strerror`, an error buffer, a
// redirect's Location) is ever passed on: only the code picks the reason.
const char* classifyCurlError(CURLcode code) {
  switch (code) {
    case CURLE_OPERATION_TIMEDOUT:
      return "timeout";
    case CURLE_TOO_MANY_REDIRECTS:
      return "too_many_redirects";
    case CURLE_PARTIAL_FILE:
    case CURLE_RECV_ERROR:
    case CURLE_GOT_NOTHING:
    case CURLE_WRITE_ERROR:
      return "body_read_failed";
    default:
      return "network_error";
  }
}

}  // namespace

std::string escapePathSegment(std::string_view segment) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(segment.size());
  for (const char ch : segment) {
    const auto byte = static_cast<unsigned char>(ch);
    const bool alnum = (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
                       (byte >= '0' && byte <= '9');
    if (alnum || std::string_view("-_.~$&+:=@").find(ch) != std::string_view::npos) {
      out.push_back(ch);
    } else {
      out.push_back('%');
      out.push_back(kHex[byte >> 4]);
      out.push_back(kHex[byte & 0x0F]);
    }
  }
  return out;
}

const char* redirectProtocolsFor(std::string_view url) {
  constexpr std::string_view kHttps = "https://";
  if (url.size() >= kHttps.size()) {
    bool https = true;
    for (std::size_t i = 0; i < kHttps.size(); ++i) {
      const char c = url[i];
      const char lower = (c >= 'A' && c <= 'Z') ? static_cast<char>(c + ('a' - 'A')) : c;
      https = https && lower == kHttps[i];
    }
    if (https) {
      return "https";
    }
  }
  return "http,https";
}

CURLcode setRedirectProtocols(CURL* curl, const char* protocols) {
#if LIBCURL_VERSION_NUM >= 0x075500  // 7.85.0 added the _STR form
  return curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS_STR, protocols);
#else
  return curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS,
                          std::string_view(protocols) == "https"
                              ? static_cast<long>(CURLPROTO_HTTPS)
                              : static_cast<long>(CURLPROTO_HTTP | CURLPROTO_HTTPS));
#endif
}

std::optional<std::string> buildConfigUrl(std::string_view baseUrl, std::string_view sdkKey) {
  std::string keyPath;
  if (isValidConfeatureKeyFormat(sdkKey)) {
    // ConfigCat's exact bytes: each '/'-separated part escaped on its own
    // (a no-op for a well-shaped key), the separators kept.
    std::size_t start = 0;
    while (true) {
      const auto slash = sdkKey.find('/', start);
      keyPath += escapePathSegment(sdkKey.substr(start, slash - start));
      if (slash == std::string_view::npos) {
        break;
      }
      keyPath.push_back('/');
      start = slash + 1;
    }
  } else {
    keyPath = escapePathSegment(sdkKey);
    // No escaper keeps these in their segment: the request would leave
    // the key's path (or name none), so refuse to fetch.
    if (keyPath.empty() || keyPath == "." || keyPath == "..") {
      return std::nullopt;
    }
  }
  std::string url;
  url.reserve(baseUrl.size() + keyPath.size() + 40);
  url.append(baseUrl).append("/configuration-files/").append(keyPath).append("/config_v6.json");
  return url;
}

ConfigFetcher::ConfigFetcher(std::string sdkKey, const std::string& version,
                             std::optional<std::string> baseUrl, std::chrono::seconds timeout,
                             std::shared_ptr<Logger> logger,
                             RedirectProtocolSetter redirectProtocolSetter)
    : sdkKey_(std::move(sdkKey)),
      userAgent_("confeature-cpp-sdk/" + version),
      timeout_(timeout.count() <= 0 ? kDefaultTimeout : timeout),
      logger_(std::move(logger)),
      redirectProtocolSetter_(redirectProtocolSetter) {
  std::string base = baseUrl.has_value() && !baseUrl->empty() ? *baseUrl : kDefaultBaseUrl;
  while (!base.empty() && base.back() == '/') {
    base.pop_back();
  }
  url_ = buildConfigUrl(base, sdkKey_);
}

FetchResult ConfigFetcher::fetch(std::optional<std::string> prevEtag) {
  FetchResult result;
  if (!url_.has_value()) {
    if (logger_) {
      logger_->error(
          "ConfigFetcher: INVALID_SDK_KEY, no request sent (sdkKey=" + redactSdkKey(sdkKey_) + ")");
    }
    result.status = FetchStatus::Failed;
    result.error = "INVALID_SDK_KEY";
    return result;
  }
  CURL* curl = curl_easy_init();
  if (curl == nullptr) {
    if (logger_) {
      logger_->error(
          "ConfigFetcher: curl_easy_init returned null (sdkKey=" + redactSdkKey(sdkKey_) + ")");
    }
    result.status = FetchStatus::Failed;
    result.error = "curl_init_failed";
    return result;
  }

  BodySink body;
  std::optional<std::string> etag;
  curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, ("User-Agent: " + userAgent_).c_str());
  headers = curl_slist_append(headers, "Accept: application/json");
  if (prevEtag.has_value() && !prevEtag->empty()) {
    headers = curl_slist_append(headers, ("If-None-Match: " + *prevEtag).c_str());
  }

  curl_easy_setopt(curl, CURLOPT_URL, url_->c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToBody);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, writeEtagHeader);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &etag);
  // A redirect never downgrades https to clear-text http: the URL it
  // re-sends carries the SDK key. Redirects are switched on only once that
  // restriction took. libcurl follows none by default, so a build that
  // rejects the option fails closed: a 3xx ends the fetch as `HTTP 3xx`,
  // while the CDN's direct 200/304 still work.
  if (redirectProtocolSetter_(curl, redirectProtocolsFor(*url_)) == CURLE_OK) {
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, kMaxRedirects);
  } else if (logger_) {
    logger_->warning(
        "ConfigFetcher: redirect protocols could not be restricted, no redirect will be "
        "followed (sdkKey=" +
        redactSdkKey(sdkKey_) + ")");
  }
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(timeout_.count()));
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  const CURLcode rc = curl_easy_perform(curl);
  long httpCode = 0;
  if (rc == CURLE_OK) {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
  }

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  if (rc != CURLE_OK) {
    const std::string reason = body.tooLarge ? "body_too_large" : classifyCurlError(rc);
    if (logger_) {
      logger_->error("ConfigFetcher: fetch raised (sdkKey=" + redactSdkKey(sdkKey_) +
                     ", reason=" + reason + ")");
    }
    result.status = FetchStatus::Failed;
    result.error = reason;
    return result;
  }

  if (httpCode == 304) {
    result.status = FetchStatus::NotModified;
    result.etag = etag;
    return result;
  }
  if (httpCode < 200 || httpCode >= 300) {
    const std::string reason = "HTTP " + std::to_string(httpCode);
    if (logger_) {
      logger_->error("ConfigFetcher: fetch failed (sdkKey=" + redactSdkKey(sdkKey_) +
                     ", reason=" + reason + ")");
    }
    result.status = FetchStatus::Failed;
    result.error = reason;
    return result;
  }

  nlohmann::json parsed;
  try {
    parsed = nlohmann::json::parse(body.bytes);
  } catch (const nlohmann::json::exception&) {
    // parse_error, and out_of_range for a number past double (`1e400`).
    // A fixed reason only — the parser's message quotes body bytes.
    if (logger_) {
      logger_->error("ConfigFetcher: fetch returned non-JSON body (sdkKey=" +
                     redactSdkKey(sdkKey_) + ", reason=MALFORMED_JSON)");
    }
    result.status = FetchStatus::Failed;
    result.error = "MALFORMED_JSON";
    return result;
  }

  // Top-level shape guard — config-v6 documents are objects carrying at
  // least one of {p, f, s}. Valid JSON of the wrong shape (e.g. a bare
  // array or `{"foo":"bar"}`) cannot become a config and surfaces with
  // the same MALFORMED_JSON class as a JSON.parse failure — see
  // wire-cases.json `wrong-shape-200` (spec 112 / epic #146).
  if (!parsed.is_object() ||
      (!parsed.contains("p") && !parsed.contains("f") && !parsed.contains("s"))) {
    if (logger_) {
      logger_->error("ConfigFetcher: fetch returned JSON of unexpected shape (sdkKey=" +
                     redactSdkKey(sdkKey_) + ")");
    }
    result.status = FetchStatus::Failed;
    result.error = "MALFORMED_JSON";
    return result;
  }

  result.status = FetchStatus::Fetched;
  result.body = std::move(parsed);
  result.etag = std::move(etag);
  return result;
}

}  // namespace confeature::internal
