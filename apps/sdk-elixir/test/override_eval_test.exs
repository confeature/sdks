# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.OverrideEvalTest do
  use ExUnit.Case, async: true

  alias Confeature.{FlagOverrides, MapOverrideDataSource}
  alias Confeature.Internal.OverrideEval

  defp local_only(map) do
    FlagOverrides.new(
      data_source: MapOverrideDataSource.new(map),
      behaviour: :local_only
    )
  end

  describe "evaluate_sync/3 — 7-branch tree" do
    test "branch 1 — nil overrides falls through" do
      assert OverrideEval.evaluate_sync(nil, "k", false) == {false, nil}
    end

    test "branch 2 — non-local_only behaviour falls through" do
      fo =
        FlagOverrides.new(
          data_source: MapOverrideDataSource.new(%{"k" => true}),
          behaviour: :local_over_remote
        )

      assert OverrideEval.evaluate_sync(fo, "k", false) == {false, nil}
    end

    test "branch 3 — nil data source falls through" do
      fo = %FlagOverrides{data_source: nil, behaviour: :local_only}
      assert OverrideEval.evaluate_sync(fo, "k", false) == {false, nil}
    end

    test "branch 4 — key absent returns default (LocalOnly contract)" do
      assert OverrideEval.evaluate_sync(local_only(%{"a" => true}), "b", :sentinel) ==
               {true, :sentinel}
    end

    test "branch 5 — empty SettingValue slot returns default" do
      fo =
        FlagOverrides.new(
          data_source: %MapOverrideDataSource{
            map: %{"k" => %Confeature.SettingValue{}}
          },
          behaviour: :local_only
        )

      assert OverrideEval.evaluate_sync(fo, "k", "fallback") == {true, "fallback"}
    end

    test "branch 6 — TYPE_MISMATCH returns default when both default and candidate non-nil" do
      assert OverrideEval.evaluate_sync(local_only(%{"k" => "abc"}), "k", false) ==
               {true, false}
    end

    test "branch 6 — nil default bypasses the type check" do
      assert OverrideEval.evaluate_sync(local_only(%{"k" => "abc"}), "k", nil) ==
               {true, "abc"}
    end

    test "branch 7 — happy path returns the typed override value" do
      assert OverrideEval.evaluate_sync(local_only(%{"k" => true}), "k", false) == {true, true}
      assert OverrideEval.evaluate_sync(local_only(%{"k" => 42}), "k", 0) == {true, 42}
      assert OverrideEval.evaluate_sync(local_only(%{"k" => "hi"}), "k", "x") == {true, "hi"}
      assert OverrideEval.evaluate_sync(local_only(%{"k" => 1.5}), "k", 0.0) == {true, 1.5}
    end
  end
end
