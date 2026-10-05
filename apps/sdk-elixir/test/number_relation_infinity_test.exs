# SPDX-License-Identifier: MIT

defmodule Confeature.NumberRelationInfinityTest do
  @moduledoc """
  Regression for the ±Infinity number-comparator ordering (spec 124 review).

  Erlang term order sorts every number before every atom, so a naive
  `atom < number` comparison made `-Infinity` compare as GREATER than all
  finite numbers. The number relations must instead follow JS numeric
  semantics: `-Infinity < finite < +Infinity`, and every relation involving
  `NaN` (except `!=`) is false. The vendored corpus exercises ±Infinity only
  in the attribute→string conversion path, not as a relational operand, so
  this guards the gap directly.
  """
  use ExUnit.Case, async: true

  alias Confeature.Internal.Comparators

  # Comparator discriminators (config-json.ts): 10=eq 11=ne 12=lt 13=le 14=gt 15=ge
  @lt 12
  @le 13
  @gt 14
  @ge 15
  @eq 10
  @ne 11

  test "-Infinity is less than every finite number" do
    assert Comparators.number_relation(:neg_infinity, @lt, 5.0)
    assert Comparators.number_relation(:neg_infinity, @lt, -1.0e308)
    refute Comparators.number_relation(5.0, @lt, :neg_infinity)
    assert Comparators.number_relation(5.0, @gt, :neg_infinity)
  end

  test "+Infinity is greater than every finite number" do
    assert Comparators.number_relation(:infinity, @gt, 5.0)
    refute Comparators.number_relation(:infinity, @lt, 5.0)
    assert Comparators.number_relation(5.0, @lt, :infinity)
    refute Comparators.number_relation(5.0, @gt, :infinity)
  end

  test "infinities relate to each other like JS" do
    assert Comparators.number_relation(:neg_infinity, @lt, :infinity)
    refute Comparators.number_relation(:infinity, @lt, :neg_infinity)
    assert Comparators.number_relation(:infinity, @eq, :infinity)
    assert Comparators.number_relation(:neg_infinity, @eq, :neg_infinity)
    refute Comparators.number_relation(:infinity, @eq, :neg_infinity)
    assert Comparators.number_relation(:infinity, @ge, :infinity)
    assert Comparators.number_relation(:neg_infinity, @le, :neg_infinity)
  end

  test "every NaN relation is false except !=" do
    for cmp <- [@lt, @le, @gt, @ge, @eq] do
      refute Comparators.number_relation(:nan, cmp, 5.0)
      refute Comparators.number_relation(5.0, cmp, :nan)
      refute Comparators.number_relation(:nan, cmp, :nan)
    end

    assert Comparators.number_relation(:nan, @ne, 5.0)
    assert Comparators.number_relation(5.0, @ne, :nan)
    assert Comparators.number_relation(:nan, @ne, :nan)
  end
end
