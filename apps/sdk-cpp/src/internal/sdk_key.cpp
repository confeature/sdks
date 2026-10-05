// SPDX-License-Identifier: MIT

#include "internal/sdk_key.h"

#include <openssl/evp.h>
#include <openssl/sha.h>

#include <algorithm>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>

namespace confeature::internal {

namespace {

constexpr char kB64UrlAlphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

bool isB64UrlByte(unsigned char b) {
  return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_' ||
         b == '-';
}

bool allB64Url(std::string_view s) {
  return std::all_of(s.begin(), s.end(),
                     [](char c) { return isB64UrlByte(static_cast<unsigned char>(c)); });
}

// `<prefix><segmentLen b64url bytes><separator><segmentLen b64url bytes>`
// and nothing else.
bool matchesKeyShape(std::string_view sdkKey, std::string_view prefix, char separator,
                     std::size_t segmentLen) {
  if (sdkKey.size() != prefix.size() + (2 * segmentLen) + 1 ||
      sdkKey.substr(0, prefix.size()) != prefix) {
    return false;
  }
  const std::string_view rest = sdkKey.substr(prefix.size());
  return rest[segmentLen] == separator && allB64Url(rest.substr(0, segmentLen)) &&
         allB64Url(rest.substr(segmentLen + 1));
}

}  // namespace

std::string base64UrlEncode(const unsigned char* data, std::size_t len) {
  // Manual encoder — OpenSSL's EVP_EncodeBlock emits standard base64
  // with '+' / '/', so we'd still need post-processing. A 30-line
  // implementation with the URL-safe alphabet is faster + clearer.
  std::string out;
  out.reserve(((len + 2) / 3) * 4);

  std::size_t i = 0;
  for (; i + 3 <= len; i += 3) {
    const auto a = static_cast<unsigned>(data[i]);
    const auto b = static_cast<unsigned>(data[i + 1]);
    const auto c = static_cast<unsigned>(data[i + 2]);
    out.push_back(kB64UrlAlphabet[(a >> 2) & 0x3F]);
    out.push_back(kB64UrlAlphabet[((a << 4) | (b >> 4)) & 0x3F]);
    out.push_back(kB64UrlAlphabet[((b << 2) | (c >> 6)) & 0x3F]);
    out.push_back(kB64UrlAlphabet[c & 0x3F]);
  }

  const std::size_t rem = len - i;
  if (rem == 1) {
    auto a = static_cast<unsigned>(data[i]);
    out.push_back(kB64UrlAlphabet[(a >> 2) & 0x3F]);
    out.push_back(kB64UrlAlphabet[(a << 4) & 0x3F]);
  } else if (rem == 2) {
    auto a = static_cast<unsigned>(data[i]);
    auto b = static_cast<unsigned>(data[i + 1]);
    out.push_back(kB64UrlAlphabet[(a >> 2) & 0x3F]);
    out.push_back(kB64UrlAlphabet[((a << 4) | (b >> 4)) & 0x3F]);
    out.push_back(kB64UrlAlphabet[(b << 2) & 0x3F]);
  }
  // No-pad — matches the canonical TS `URL_SAFE_NO_PAD`.
  return out;
}

bool isValidConfeatureKeyFormat(std::string_view sdkKey) {
  // Mirrors `CONFEATURE_SDK_KEY_PATTERN` in packages/sdk-shared/src/sdk-key.ts:
  //   configcat-sdk-1/<22>/<22> | confeature-sdk-1-<32>-<32>
  // Positional (not split-on-separator): '-' is itself a base64url byte,
  // so it may appear inside a legacy segment.
  return matchesKeyShape(sdkKey, "configcat-sdk-1/", '/', 22) ||
         matchesKeyShape(sdkKey, "confeature-sdk-1-", '-', 32);
}

std::string redactSdkKey(std::string_view sdkKey) {
  if (sdkKey.size() < 16) {
    return "[redacted]";
  }
  std::size_t visible = std::max<std::size_t>(sdkKey.size() / 10, 4);
  std::string out;
  out.reserve(visible * 2 + 16);
  out.append(sdkKey.substr(0, visible));
  // U+2026 (HORIZONTAL ELLIPSIS) — UTF-8 \xE2\x80\xA6 — matches the
  // Rust/Python redaction format for cross-tooling diff parity.
  out.append("\xE2\x80\xA6[redacted]\xE2\x80\xA6");
  out.append(sdkKey.substr(sdkKey.size() - visible));
  return out;
}

std::string deriveCacheKey(std::string_view sdkKey) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  unsigned int outlen = 0;
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (ctx == nullptr) {
    throw std::runtime_error("EVP_MD_CTX_new failed");
  }
  if (EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestInit_ex failed");
  }
  if (EVP_DigestUpdate(ctx, sdkKey.data(), sdkKey.size()) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestUpdate failed");
  }
  if (EVP_DigestFinal_ex(ctx, hash, &outlen) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestFinal_ex failed");
  }
  EVP_MD_CTX_free(ctx);
  std::string b64 = base64UrlEncode(hash, outlen);
  std::string out;
  out.reserve(std::string_view(kCacheKeyPrefix).size() + 32);
  out.append(kCacheKeyPrefix);
  out.append(b64.substr(0, 32));
  return out;
}

std::string_view cacheKeyTail(std::string_view cacheKey) {
  auto pos = cacheKey.rfind(':');
  if (pos == std::string_view::npos) {
    return cacheKey;
  }
  return cacheKey.substr(pos + 1);
}

}  // namespace confeature::internal
