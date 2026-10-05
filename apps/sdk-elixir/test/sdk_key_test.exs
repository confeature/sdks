# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.SdkKeyTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.SdkKey
  alias Confeature.TestHelpers

  @new_shape_key "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

  # The one accept/reject list every SDK's validator is tested from (#802).
  @external_resource TestHelpers.fixture_path("sdk-key-shapes.json")
  @sdk_key_shapes TestHelpers.sdk_key_shapes()

  describe "derive_cache_key/1" do
    test "prefixes with confeature:cache:v1:" do
      assert SdkKey.derive_cache_key("abc") |> String.starts_with?("confeature:cache:v1:")
    end

    test "produces a 32-char base64url body" do
      "confeature:cache:v1:" <> body = SdkKey.derive_cache_key("abc")
      assert String.length(body) == 32
      assert String.match?(body, ~r/\A[A-Za-z0-9_-]{32}\z/)
    end

    test "is deterministic" do
      assert SdkKey.derive_cache_key("seed") == SdkKey.derive_cache_key("seed")
    end

    test "is sensitive to a single-byte change" do
      assert SdkKey.derive_cache_key("seed-A") != SdkKey.derive_cache_key("seed-B")
    end

    test "handles the empty string" do
      assert SdkKey.derive_cache_key("") ==
               "confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM"
    end
  end

  describe "scrub/2" do
    # The request URL of @new_shape_key: it holds the key.
    @url "https://cdn.example/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/config_v6.json"

    test "replaces every occurrence in a binary with the redacted form" do
      assert SdkKey.scrub("a #{@new_shape_key} b #{@new_shape_key}", [@new_shape_key]) ==
               "a ***ea02 b ***ea02"
    end

    test "a short secret is replaced by a full mask" do
      assert SdkKey.scrub("pre-abc-post", ["abc"]) == "pre-***-post"
    end

    test "a secret holding another is replaced whole, whatever the order (longest first)" do
      # Key first would leave the URL as
      # "https://cdn.example/configuration-files/***ea02/config_v6.json".
      for secrets <- [[@new_shape_key, @url], [@url, @new_shape_key]] do
        assert SdkKey.scrub("GET #{@url} (#{@new_shape_key})", secrets) ==
                 "GET ***json (***ea02)"
      end
    end

    test "walks tuples, lists, improper lists, maps (keys too) and structs" do
      key = @new_shape_key
      pid = self()

      term =
        {:call, [key, {key}], %{key => [key | key]}, %URI{path: "/#{key}"}, 42, :atom, pid}

      assert SdkKey.scrub(term, [key]) ==
               {:call, ["***ea02", {"***ea02"}], %{"***ea02" => ["***ea02" | "***ea02"]},
                %URI{path: "/***ea02"}, 42, :atom, pid}
    end

    test "a printable charlist stays a charlist; a non-printable list is walked" do
      charlist = String.to_charlist("x #{@new_shape_key}")
      assert SdkKey.scrub(charlist, [@new_shape_key]) == ~c"x ***ea02"

      untouched = ~c"nothing secret here"
      assert SdkKey.scrub(untouched, [@new_shape_key]) == untouched

      assert SdkKey.scrub([-1, @new_shape_key], [@new_shape_key]) == [-1, "***ea02"]
    end

    test "empty, blank or non-binary secrets leave the term unchanged" do
      term = {"abc", ~c"abc", [abc: "abc"]}

      for secrets <- [[], [""], [nil, :abc, 42], ["", nil]] do
        assert SdkKey.scrub(term, secrets) == term
      end
    end

    test "other terms are kept as they are" do
      fun = fn -> @new_shape_key end
      ref = make_ref()

      for term <- [42, 1.5, :atom, nil, fun, ref, self()] do
        assert SdkKey.scrub(term, [@new_shape_key]) === term
      end
    end
  end

  describe "redact/1" do
    test "never returns the raw key for long inputs" do
      sdk_key = "confeature-sdk-1-AAAAAAAAAAAA-BBBBBBBBBBBB"
      redacted = SdkKey.redact(sdk_key)
      refute redacted == sdk_key
      assert String.starts_with?(redacted, "***")
    end

    test "a configcat-shaped key shows no more than its last 4 chars" do
      redacted = SdkKey.redact(@new_shape_key)
      assert redacted == "***ea02"
      refute String.contains?(redacted, "/")
      refute String.contains?(redacted, "FAKEfixtureKeyNotRea01")
      refute String.contains?(redacted, "FAKEfixtureKeyNotRea02")
    end

    test "falls back to *** for short / nil / non-binary inputs" do
      assert SdkKey.redact("abc") == "***"
      assert SdkKey.redact(nil) == "***"
      assert SdkKey.redact(42) == "***"
    end
  end

  describe "valid_confeature_key_format?/1" do
    test "matches a well-formed v1 key" do
      key =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

      assert SdkKey.valid_confeature_key_format?(key)
    end

    test "matches a configcat-shaped key" do
      assert SdkKey.valid_confeature_key_format?(@new_shape_key)
    end

    for %{"name" => name, "key" => key} <- Map.fetch!(@sdk_key_shapes, "valid") do
      @key key
      test "accepts #{name} (sdk-key-shapes.json)" do
        assert SdkKey.valid_confeature_key_format?(@key)
      end
    end

    for %{"name" => name, "key" => key} <- Map.fetch!(@sdk_key_shapes, "invalid") do
      @key key
      test "rejects #{name} (sdk-key-shapes.json)" do
        refute SdkKey.valid_confeature_key_format?(@key)
      end
    end

    test "rejects nil / short / non-binary" do
      refute SdkKey.valid_confeature_key_format?(nil)
      refute SdkKey.valid_confeature_key_format?("nope")
      refute SdkKey.valid_confeature_key_format?(42)
    end
  end
end
