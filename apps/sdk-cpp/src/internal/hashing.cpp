// SPDX-License-Identifier: MIT

#include "internal/hashing.h"

#include <openssl/evp.h>

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace confeature::internal {

namespace {

constexpr char kHex[] = "0123456789abcdef";

// Lowercase-hex-encode `len` bytes of `digest`.
std::string toHex(const unsigned char* digest, unsigned int len) {
  std::string out;
  out.reserve(static_cast<std::size_t>(len) * 2);
  for (unsigned int i = 0; i < len; ++i) {
    out.push_back(kHex[(digest[i] >> 4) & 0x0F]);
    out.push_back(kHex[digest[i] & 0x0F]);
  }
  return out;
}

// One-shot EVP digest of `data[0..len)` via `md`. Mirrors the EVP_MD_CTX
// pattern in `sdk_key.cpp`. Throws on any OpenSSL failure (the evaluator's
// boundary try/catch converts that to a fail-closed default).
std::string digestHex(const EVP_MD* md, const unsigned char* data, std::size_t len) {
  std::array<unsigned char, EVP_MAX_MD_SIZE> hash{};
  unsigned int outlen = 0;
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (ctx == nullptr) {
    throw std::runtime_error("EVP_MD_CTX_new failed");
  }
  if (EVP_DigestInit_ex(ctx, md, nullptr) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestInit_ex failed");
  }
  if (len > 0 && EVP_DigestUpdate(ctx, data, len) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestUpdate failed");
  }
  if (EVP_DigestFinal_ex(ctx, hash.data(), &outlen) != 1) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("EVP_DigestFinal_ex failed");
  }
  EVP_MD_CTX_free(ctx);
  return toHex(hash.data(), outlen);
}

}  // namespace

std::string sha1Hex(const std::string& input) {
  return digestHex(EVP_sha1(), reinterpret_cast<const unsigned char*>(input.data()), input.size());
}

std::string sha256HexBytes(const unsigned char* data, std::size_t len) {
  return digestHex(EVP_sha256(), data, len);
}

std::string sha256Hex(const std::string& input) {
  return sha256HexBytes(reinterpret_cast<const unsigned char*>(input.data()), input.size());
}

std::uint64_t percentageBucket(const std::string& key, const std::string& attrValue) {
  const std::string hex = sha1Hex(key + attrValue).substr(0, 7);
  // 7 hex chars = 28 bits — well within an unsigned 64-bit parse.
  const std::uint64_t hashValue = std::stoull(hex, nullptr, 16);
  return hashValue % 100ULL;
}

std::string hashComparisonValue(const std::string& value, const std::string& configJsonSalt,
                                const std::string& contextSalt) {
  return sha256Hex(value + configJsonSalt + contextSalt);
}

std::string hashComparisonValueSlice(const std::string& slice, const std::string& configJsonSalt,
                                     const std::string& contextSalt) {
  // The slice is raw UTF-8 bytes (may land mid-codepoint); concatenate the
  // salt bytes and hash the whole byte sequence. Re-encoding would corrupt
  // multibyte attributes (the `testmatrix_unicode` *Hashed rows).
  std::string buf;
  buf.reserve(slice.size() + configJsonSalt.size() + contextSalt.size());
  buf.append(slice);
  buf.append(configJsonSalt);
  buf.append(contextSalt);
  return sha256HexBytes(reinterpret_cast<const unsigned char*>(buf.data()), buf.size());
}

}  // namespace confeature::internal
