# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.HashingTest do
  @moduledoc """
  Unit tests for the evaluation hashes (spec 124 T002). Vectors cross-checked
  against the spec-117 TS reference (`packages/sdk-shared/src/hash.ts`) and the
  spec-118..123 Python / Go / Ruby / PHP / .NET / Dart ports.
  """

  use ExUnit.Case, async: true

  alias Confeature.Internal.Hashing

  describe "sha1/1 and sha256/1 known vectors" do
    test "empty string" do
      assert Hashing.sha1("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709"

      assert Hashing.sha256("") ==
               "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    end

    test "\"abc\"" do
      assert Hashing.sha1("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d"

      assert Hashing.sha256("abc") ==
               "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    end

    test "output is lowercase hex of the right length" do
      assert byte_size(Hashing.sha1("x")) == 40
      assert byte_size(Hashing.sha256("x")) == 64
      assert Hashing.sha1("x") == String.downcase(Hashing.sha1("x"))
      assert Hashing.sha256("x") == String.downcase(Hashing.sha256("x"))
    end
  end

  describe "sha256_bytes/1 (byte-level entry point)" do
    test "matches sha256 over the same byte sequence" do
      assert Hashing.sha256_bytes("abSC") == Hashing.sha256("abSC")
    end

    test "hashes a mid-codepoint byte slice (unicode parity)" do
      # A 4-byte emoji sliced at byte 2 yields a binary that is NOT valid UTF-8;
      # the hash must still run over the raw bytes (testmatrix_unicode parity).
      <<first_two::binary-size(2), _rest::binary>> = "😀"
      assert Hashing.sha256_bytes(first_two) == Hashing.sha256(first_two)
    end
  end

  describe "percentage_bucket/2 (SHA-1 unsalted, hex[0,7] rem 100)" do
    test "is in 0..99" do
      for id <- ["12345", "a@b.com", "", "Bob"] do
        bucket = Hashing.percentage_bucket("someKey", id)
        assert bucket >= 0 and bucket <= 99
      end
    end

    test "is deterministic" do
      assert Hashing.percentage_bucket("k", "v") == Hashing.percentage_bucket("k", "v")
    end

    test "matches the explicit hex computation (key <> attr, UNSALTED)" do
      key = "percentageKey"
      attr = "12345"
      hex = (key <> attr) |> Hashing.sha1() |> binary_part(0, 7)
      assert Hashing.percentage_bucket(key, attr) == rem(String.to_integer(hex, 16), 100)
    end
  end

  describe "hash_comparison_value/3 (SHA-256 salted)" do
    test "equals sha256(value <> config_salt <> context_salt)" do
      assert Hashing.hash_comparison_value("v", "cfg", "ctx") == Hashing.sha256("vcfgctx")
    end

    test "salt order is value, then config salt, then context salt" do
      # Distinct from any other concatenation order — proves byte layout parity.
      assert Hashing.hash_comparison_value("a", "b", "c") == Hashing.sha256("abc")
      refute Hashing.hash_comparison_value("a", "b", "c") == Hashing.sha256("acb")
    end
  end
end
