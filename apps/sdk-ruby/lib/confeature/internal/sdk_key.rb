# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "base64"
require "digest"

module Confeature
  module Internal
    # SDK-key format helpers + cache-key derivation.
    #
    # SECURITY (Constitution security clause + spec 037 FR-008): SDK
    # keys are secrets. They MUST NEVER appear verbatim in any log
    # line. Every log site routes through `redact` first.
    #
    # The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`
    # (SHA-256 → base64url → first 32 chars). Cross-language fixture
    # verification lives in `spec/cache_key_fixtures_spec.rb`.
    module SdkKey
      # Wire formats of a valid Confeature SDK key — both are accepted
      # (#802):
      #
      #   - `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` —
      #     minted today; ConfigCat's own shape, so the stock `configcat`
      #     gem accepts the key too.
      #   - `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>` —
      #     minted before #802; still served until the key is rotated.
      #
      # Mirrors `CONFEATURE_SDK_KEY_PATTERN` in
      # `packages/sdk-shared/src/sdk-key.ts`. The shared accept/reject
      # cases live in
      # `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
      CONFEATURE_SDK_KEY_PATTERN = %r{
        \A
        (?:
          configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}
          |
          confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32}
        )
        \z
      }x

      # Envelope prefix for derived cache keys. Identical across every
      # Confeature SDK; mirrors the TS implementation's constant.
      CACHE_KEY_PREFIX = "confeature:cache:v1:"

      # Return true iff `sdk_key` matches either Confeature SDK-key format
      # (the ConfigCat-shaped `configcat-sdk-1/...` key or the legacy
      # `confeature-sdk-1-...` key).
      #
      # A `false` result does NOT cause the SDK to raise; it triggers an
      # `INVALID_SDK_KEY` log line (which, per the security clause,
      # includes only the redacted form).
      def self.valid_confeature_key_format?(sdk_key)
        return false unless sdk_key.is_a?(String)

        # Matched on the raw bytes: a key in a broken or non-ASCII-
        # compatible encoding is simply not well-shaped, never an
        # `ArgumentError` / `Encoding::CompatibilityError` (#803).
        CONFEATURE_SDK_KEY_PATTERN.match?(sdk_key.b)
      end

      # Return a privacy-preserving rendering of `sdk_key` for logs.
      #
      # Strategy: keep ~10% of the key visible at each end (minimum 4
      # chars), mask the middle. For short / unusual keys (< 16 chars)
      # and nil, fall back to a full mask. NEVER returns the raw key.
      #
      # The `/` separators of a ConfigCat-shaped key are plain characters
      # here: for a 61-char `configcat-sdk-1/<22>/<22>` key the head is
      # `config` (no secret) and the tail is the last 6 secret chars —
      # fewer than the 8 shown for a legacy 83-char key.
      #
      # Mirrors `redactSdkKey` from packages/sdk-shared/src/sdk-key.ts.
      def self.redact(sdk_key)
        return "[redacted]" if sdk_key.nil? || !sdk_key.is_a?(String) || sdk_key.empty?

        key = printable(sdk_key)
        return "[redacted]" if key.nil? || key.length < 16

        visible = [4, (key.length / 10.0).floor].max
        head = key[0, visible]
        tail = key[-visible, visible]
        "#{head}…[redacted]…#{tail}"
      end

      # `sdk_key` as valid UTF-8 (bad bytes replaced), so interpolating
      # it next to the UTF-8 "…" never raises an encoding error (#803).
      # A valid UTF-8 key is returned unchanged. nil when no conversion
      # exists.
      def self.printable(sdk_key)
        return sdk_key.scrub if sdk_key.encoding == Encoding::UTF_8

        sdk_key.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      rescue EncodingError
        nil
      end
      private_class_method :printable

      # Derive a stable, opaque cache key from an SDK key.
      #
      # Format: `confeature:cache:v1:<base64url(sha256(sdk_key))[0, 32]>`.
      #
      # Output is byte-identical to the TS workspace's async
      # `deriveCacheKey` (Web Crypto's `subtle.digest("SHA-256")`).
      # The cross-language fixture at
      # `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
      # pins ≥ 5 (sdkKey, expectedCacheKey) pairs and the Ruby unit test
      # asserts string equality for every entry.
      #
      # SECURITY: the SDK key is HASHED, never stored raw. Even an
      # attacker with filesystem access to the cache directory cannot
      # read the SDK key from a written cache file's name.
      def self.derive_cache_key(sdk_key)
        digest = Digest::SHA256.digest(sdk_key.to_s.b)
        b64 = Base64.urlsafe_encode64(digest, padding: false)
        "#{CACHE_KEY_PREFIX}#{b64[0, 32]}"
      end
    end
  end
end
