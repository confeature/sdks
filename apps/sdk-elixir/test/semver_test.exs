# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.SemverTest do
  @moduledoc """
  Unit tests for the ConfigCat-semantics semver (spec 124 T003), cross-checked
  against the spec-117 TS reference (`packages/sdk-shared/src/semver.ts`) and the
  spec-118..123 ports. NOT Elixir `Version` — its loose-parse and precedence edge
  cases diverge from ConfigCat.
  """

  use ExUnit.Case, async: true

  alias Confeature.Internal.Semver

  describe "parse/1" do
    test "valid full versions" do
      assert %Semver{} = Semver.parse("1.2.3")
      assert %Semver{} = Semver.parse("v1.2.3")
      assert %Semver{} = Semver.parse("1.0.0-alpha.1")
      assert %Semver{} = Semver.parse("1.0.0+build.5")
      # parse on trim
      assert %Semver{} = Semver.parse("  1.2.3  ")
    end

    test "rejects malformed versions → nil" do
      assert Semver.parse("1.2") == nil
      assert Semver.parse("1.2.3.4") == nil
      # leading zero
      assert Semver.parse("01.2.3") == nil
      assert Semver.parse("abc") == nil
      assert Semver.parse("") == nil
    end

    test "non-string input → nil (never raises)" do
      assert Semver.parse(123) == nil
      assert Semver.parse(nil) == nil
    end

    test "canonical drops build metadata" do
      assert Semver.parse("1.2.3+meta").version == "1.2.3"
      assert Semver.parse("1.2.3-rc.1+meta").version == "1.2.3-rc.1"
    end
  end

  describe "compare/2 (ConfigCat precedence)" do
    defp cmp(a, b), do: Semver.compare(Semver.parse(a), Semver.parse(b))

    test "numeric major.minor.patch ordering" do
      assert cmp("1.0.0", "2.0.0") < 0
      assert cmp("1.2.0", "1.1.0") > 0
      assert cmp("1.0.1", "1.0.1") == 0
    end

    test "a release ranks higher than a pre-release" do
      assert cmp("1.0.0", "1.0.0-alpha") > 0
      assert cmp("1.0.0-alpha", "1.0.0") < 0
    end

    test "pre-release identifier precedence" do
      # numeric < alphanumeric
      assert cmp("1.0.0-1", "1.0.0-alpha") < 0
      # numeric compared numerically (not lexically: 2 < 10)
      assert cmp("1.0.0-2", "1.0.0-10") < 0
      # more fields rank higher when prefixes equal
      assert cmp("1.0.0-alpha", "1.0.0-alpha.1") < 0
      # alphanumeric ASCII-lexical
      assert cmp("1.0.0-alpha", "1.0.0-beta") < 0
    end

    test "build metadata is ignored for precedence" do
      assert cmp("1.0.0+a", "1.0.0+b") == 0
    end
  end
end
