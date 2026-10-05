# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Internal::SdkKey do
  describe ".derive_cache_key" do
    it "applies the SHA-256 → base64url → 32-char → prefix recipe" do
      key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      expect(described_class.derive_cache_key(key))
        .to eq("confeature:cache:v1:bIg57I9_4ya_LRRpZZ8qZdn_gXPqQ1aY")
    end

    it "handles the empty string deterministically (SHA-256 of empty input)" do
      expect(described_class.derive_cache_key(""))
        .to eq("confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM")
    end

    it "handles non-ASCII (UTF-8) input" do
      expect(described_class.derive_cache_key("🦀-emoji-key"))
        .to eq("confeature:cache:v1:XvDGv1H4o4JUSlXWKHI0gA5l1B89H0nj")
    end
  end

  describe ".redact" do
    it "returns [redacted] for nil" do
      expect(described_class.redact(nil)).to eq("[redacted]")
    end

    it "returns [redacted] for non-strings" do
      expect(described_class.redact(123)).to eq("[redacted]")
    end

    it "returns [redacted] for the empty string" do
      expect(described_class.redact("")).to eq("[redacted]")
    end

    it "returns [redacted] for short keys (< 16 chars)" do
      expect(described_class.redact("short-key")).to eq("[redacted]")
    end

    it "never shows more than 6 secret chars of a ConfigCat-shaped key (#802)" do
      key = SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY
      out = described_class.redact(key)
      expect(out).to eq("config…[redacted]…#{key[-6, 6]}")
      _prefix, secret_a, secret_b = key.split("/")
      expect(out).not_to include(secret_a)
      expect(out).not_to include(secret_b)
      expect(out).not_to include(key)
    end

    # #803 — a key whose bytes are not valid UTF-8 is still redacted:
    # never an encoding error, the output is valid UTF-8, the bad bytes
    # are replaced by U+FFFD, and only the fixed `config` prefix and the
    # usual last 6 characters show — never a secret part, never a raw
    # bad byte. Each key is the ConfigCat shape with bad bytes in the
    # visible tail, so the bytes are actually rendered.
    describe "a key that is not valid UTF-8 (#803)" do
      def expect_redacted_safely(key, expected)
        out, raised = begin
          [described_class.redact(key), nil]
        rescue Exception => e # rubocop:disable Lint/RescueException
          [nil, e]
        end
        expect(raised).to be_nil
        expect(out).to eq(expected)
        expect(out.encoding).to eq(Encoding::UTF_8)
        expect(out).to be_valid_encoding
        _prefix, secret_a, secret_b = key.b.split("/".b)
        expect(out.b).not_to include(secret_a)
        expect(out.b).not_to include(secret_b)
        expect(out.b).not_to include(key.b)
        out
      end

      it "redacts a key with an invalid UTF-8 byte without raising" do
        key = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC\xFFd".dup.force_encoding(Encoding::UTF_8)
        expect(key).not_to be_valid_encoding
        out = expect_redacted_safely(key, "config…[redacted]…A5bC\u{FFFD}d")
        expect(out.b).not_to include("\xFF".b)
      end

      it "redacts a binary key with high bytes without raising" do
        key = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3z\xFE\xFFbC7d".b
        expect(key.encoding).to eq(Encoding::BINARY)
        out = expect_redacted_safely(key, "config…[redacted]…\u{FFFD}\u{FFFD}bC7d")
        expect(out.b).not_to include("\xFE".b)
        expect(out.b).not_to include("\xFF".b)
      end

      it "fully masks a key in an encoding with no converter to UTF-8" do
        key = SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY.dup.force_encoding(Encoding::UTF_7)
        expect(key.encoding).to be_dummy
        expect_redacted_safely(key, "[redacted]")
      end
    end

    it "preserves the head + tail and masks the middle for long keys" do
      key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      out = described_class.redact(key)
      expect(out).to start_with(key[0, 8])
      expect(out).to end_with(key[-8, 8])
      expect(out).to include("[redacted]")
      expect(out).not_to include(key) # full key never leaks
    end
  end

  describe ".valid_confeature_key_format?" do
    # The shared accept/reject list (#802) — every Confeature SDK reads
    # the same file, so the validators cannot drift apart.
    shapes = SpecHelpers.sdk_key_shapes

    it "reads a non-empty shared shape list" do
      expect(SpecHelpers.sdk_key_shapes["valid"]).not_to be_empty
      expect(SpecHelpers.sdk_key_shapes["invalid"]).not_to be_empty
    end

    shapes["valid"].each do |entry|
      it "accepts the shared valid shape: #{entry["name"]}" do
        expect(described_class.valid_confeature_key_format?(entry["key"])).to be(true)
      end
    end

    shapes["invalid"].each do |entry|
      it "rejects the shared invalid shape: #{entry["name"]}" do
        expect(described_class.valid_confeature_key_format?(entry["key"])).to be(false)
      end
    end

    it "accepts the ConfigCat-shaped format minted since #802" do
      key = SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY
      expect(described_class.valid_confeature_key_format?(key)).to be(true)
    end

    it "accepts the legacy confeature-sdk-1 format" do
      key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      expect(described_class.valid_confeature_key_format?(key)).to be(true)
    end

    it "rejects nil" do
      expect(described_class.valid_confeature_key_format?(nil)).to be(false)
    end

    it "rejects non-strings" do
      expect(described_class.valid_confeature_key_format?(42)).to be(false)
    end

    it "rejects free-form strings" do
      expect(described_class.valid_confeature_key_format?("hello")).to be(false)
    end

    it "rejects a configcat prefix with the legacy hyphen-separated body" do
      key = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      expect(described_class.valid_confeature_key_format?(key)).to be(false)
    end
  end
end
