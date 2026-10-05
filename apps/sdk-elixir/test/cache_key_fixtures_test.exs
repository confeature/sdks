# SPDX-License-Identifier: MIT

defmodule Confeature.CacheKeyFixturesTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.SdkKey
  alias Confeature.TestHelpers

  @moduletag :parity

  describe "derive_cache_key/1 vs shared fixture corpus" do
    test "matches every (sdkKey, expectedCacheKey) pair byte-identically" do
      fixtures = TestHelpers.cache_key_fixtures()
      assert fixtures != [], "fixture corpus must be non-empty"
      assert length(fixtures) >= 5, "fixture corpus must have ≥ 5 entries"

      failures =
        for %{"sdkKey" => sdk_key, "expectedCacheKey" => expected} <- fixtures,
            (actual = SdkKey.derive_cache_key(sdk_key)) != expected do
          "sdk_key=#{inspect(sdk_key)}\n  expected=#{expected}\n  actual=  #{actual}"
        end

      assert failures == [], """
      Cache-key fixture drift — Constitution Principle II NON-NEGOTIABLE.
      Investigate Confeature.Internal.SdkKey.derive_cache_key/1 — DO NOT
      mutate the fixture corpus to make the test pass.

      #{Enum.join(failures, "\n\n")}
      """
    end
  end
end
