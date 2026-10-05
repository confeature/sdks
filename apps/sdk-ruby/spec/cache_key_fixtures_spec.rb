# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Cross-language cache-key fixture gate (FR-010 / SC-003).
#
# Consumes
# `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
# and asserts that this SDK's `Confeature.derive_cache_key` produces
# byte-identical output to TS / Python / Go / .NET / Rust for every
# recorded SDK key. Mirrors apps/sdk-rust/tests/cache_key_fixtures.rs
# and apps/sdk-go/internal/sdkkey/sdkkey_test.go::TestCrossLanguageCacheKey
# 1:1.

RSpec.describe "cross-language cache-key fixtures" do
  let(:fixtures) { SpecHelpers.cache_key_fixtures }

  it "has at least 5 entries (cross-language minimum)" do
    expect(fixtures.size).to be >= 5
  end

  # #802: keys minted today are ConfigCat-shaped and contain `/`. The
  # `/` is hashed as plain bytes — never encoded, never replaced — so a
  # fixture row carrying it MUST be present and MUST match like any other.
  it "includes a ConfigCat-shaped key (contains '/')" do
    expect(fixtures.map { |fx| fx["sdkKey"] })
      .to include(a_string_starting_with("configcat-sdk-1/"))
  end

  it "matches every fixture byte-for-byte" do
    failures = fixtures.filter_map do |fx|
      actual = Confeature.derive_cache_key(fx["sdkKey"])
      next if actual == fx["expectedCacheKey"]

      redacted = Confeature.redact_sdk_key(fx["sdkKey"])
      "cache-key drift\n  input (redacted): #{redacted}\n  " \
        "expected: #{fx["expectedCacheKey"]}\n  got:      #{actual}"
    end

    expect(failures).to be_empty, lambda {
      "Cross-language cache-key drift (Constitution Principle II " \
        "NON-NEGOTIABLE):\n\n#{failures.join("\n\n")}"
    }
  end
end
