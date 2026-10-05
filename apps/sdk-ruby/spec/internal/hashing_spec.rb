# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Cross-checks the spec-120 Ruby hash port against `hash.ts`.
# `percentage_bucket` is SHA-1 UNSALTED on `key + attr_value`;
# `hash_comparison_value` is SHA-256 SALTED on
# `value + config_salt + context_salt`. Known vectors below are computed
# directly from `Digest`, matching the byte concatenation the TS reference
# uses (verified against `packages/sdk-shared/src/hash.ts`).

RSpec.describe Confeature::Internal::Hashing do
  describe ".percentage_bucket" do
    it "is SHA-1 unsalted: hexdigest(key+attr)[0,7].to_i(16) % 100" do
      expected = Digest::SHA1.hexdigest("keyvalue")[0, 7].to_i(16) % 100
      expect(described_class.percentage_bucket("key", "value")).to eq(expected)
    end

    it "stays within [0, 99]" do
      100.times do |i|
        bucket = described_class.percentage_bucket("flag", "user-#{i}")
        expect(bucket).to be_between(0, 99)
      end
    end

    it "is deterministic for the same input" do
      a = described_class.percentage_bucket("flag", "alice")
      b = described_class.percentage_bucket("flag", "alice")
      expect(a).to eq(b)
    end

    it "concatenates key + attr_value with no separator" do
      expect(described_class.percentage_bucket("x", "y"))
        .to eq(Digest::SHA1.hexdigest("xy")[0, 7].to_i(16) % 100)
    end
  end

  describe ".hash_comparison_value" do
    it "is SHA-256 salted lowercase hex of value+config_salt+context_salt" do
      expected = Digest::SHA256.hexdigest("valuesaltctx")
      expect(described_class.hash_comparison_value("value", "salt", "ctx")).to eq(expected)
    end

    it "produces lowercase hex" do
      h = described_class.hash_comparison_value("x", "s", "c")
      expect(h).to match(/\A[0-9a-f]{64}\z/)
    end

    it "is salt-sensitive (context salt changes the digest)" do
      a = described_class.hash_comparison_value("v", "s", "ctxA")
      b = described_class.hash_comparison_value("v", "s", "ctxB")
      expect(a).not_to eq(b)
    end
  end

  describe ".hash_comparison_value_slice" do
    it "hashes the raw byte slice concatenated with salt bytes" do
      slice = "äöü".encode("UTF-8").b[0, 2] # first 2 bytes of a multibyte cut
      expected = Digest::SHA256.hexdigest(slice + "salt".b + "ctx".b)
      expect(described_class.hash_comparison_value_slice(slice, "salt", "ctx")).to eq(expected)
    end
  end

  describe ".sha256_hex / .sha1_hex" do
    it "match Digest output for known vectors" do
      expect(described_class.sha256_hex("abc"))
        .to eq("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
      expect(described_class.sha1_hex(""))
        .to eq("da39a3ee5e6b4b0d3255bfef95601890afd80709")
    end
  end
end
