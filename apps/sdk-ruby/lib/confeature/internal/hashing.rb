# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "digest"

module Confeature
  module Internal
    # ConfigCat evaluation hashes — SHA-1 (unsalted %) + SHA-256 (salted
    # sensitive). Ported field-for-field from the spec-117 TS reference
    # (`packages/sdk-shared/src/hash.ts`) and the spec-118 Python port
    # (`apps/sdk-python/src/confeature_client/hash.py`). The flag evaluator
    # needs two synchronous hashes:
    #
    #   - **SHA-1, UNSALTED** for percentage bucketing —
    #     `Digest::SHA1.hexdigest(key + attr_value)[0, 7].to_i(16) % 100`.
    #   - **SHA-256, SALTED** for sensitive comparators —
    #     `sha256(utf8(value) + utf8(config_salt) + utf8(context_salt))`.
    #
    # Unlike the TS reference (which vendors a pure-JS implementation because
    # `crypto.subtle` is async on every runtime), Ruby's stdlib `Digest` is
    # synchronous and present everywhere, so we use it directly. The bytes
    # hashed are identical to the TS / Python implementations — UTF-8-encoded
    # text for the text paths, raw byte slices for the startsWith/endsWith
    # slice scheme — so every bucket / hash comes out byte-identical across the
    # federation (the parity corpus requires this).
    # Named `Hashing` (not `Hash`) to avoid shadowing Ruby's core `::Hash`
    # class for any unqualified `Hash` reference elsewhere in
    # `Confeature::Internal` (e.g. `body.is_a?(Hash)` in `config_fetcher.rb`).
    module Hashing
      module_function

      # Lowercase-hex SHA-1 of raw bytes (mirrors `hash.ts::sha1`).
      def sha1_hex(data)
        Digest::SHA1.hexdigest(data)
      end

      # Lowercase-hex SHA-256 of raw bytes (mirrors `hash.ts::sha256Bytes`).
      def sha256_hex(data)
        Digest::SHA256.hexdigest(data)
      end

      # Hash a user-attribute value for a **sensitive** comparator. Mirrors
      # `hash.ts::hashComparisonValue` (common-js `hashComparisonValue`):
      #
      #     sha256( utf8(value) + utf8(config_json_salt) + utf8(context_salt) )
      #
      # concatenated with no separators, output as lowercase hex.
      #
      # @param value [String] attribute value as text (after conversion).
      # @param config_json_salt [String] top-level config salt (`config["p"]["s"]`).
      # @param context_salt [String] per-evaluation discriminator — the setting
      #   key for a user condition, the segment name for a segment condition.
      def hash_comparison_value(value, config_json_salt, context_salt)
        sha256_hex(b("#{value}#{config_json_salt}#{context_salt}"))
      end

      # Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator.
      # Mirrors `comparators.ts::hashComparisonValueSlice`:
      #
      #     sha256( slice_bytes ++ utf8(config_salt) ++ utf8(context_salt) )
      #
      # The slice is **raw bytes** — a byte-boundary cut of the attribute, which
      # may land mid-codepoint — so the hash runs over the concatenated byte
      # sequence (re-encoding a binary string as UTF-8 would corrupt multibyte
      # attributes, the `testmatrix_unicode` `*Hashed` rows). `slice_utf8` is an
      # ASCII-8BIT (binary) string.
      def hash_comparison_value_slice(slice_utf8, config_json_salt, context_salt)
        sha256_hex(slice_utf8 + b(config_json_salt) + b(context_salt))
      end

      # Compute a ConfigCat percentage bucket in `[0, 99]` for
      # `key + attr_value`. Mirrors `hash.ts::percentageBucket`:
      #
      #     sha1(key + attr_value).hexdigest[0, 7].to_i(16) % 100
      #
      # SHA-1, **unsalted**. 7 hex chars = 28 bits, well within a safe integer.
      def percentage_bucket(key, attr_value)
        sha1_hex(b("#{key}#{attr_value}"))[0, 7].to_i(16) % 100
      end

      # Force a string to its UTF-8 bytes as a binary blob so `Digest` hashes
      # the exact byte sequence (and concatenation with binary slices works).
      def b(str)
        str.encode(Encoding::UTF_8).b
      end
    end
  end
end
