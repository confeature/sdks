# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.EvaluatorTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.Evaluator
  alias Confeature.Internal.Evaluator.EvaluationResult

  defp config_with(settings), do: %{"f" => settings}

  describe "evaluate/4 — common failure modes" do
    test "nil config fails closed with NO_CONFIG" do
      result = Evaluator.evaluate(nil, "k", false)
      assert %EvaluationResult{value: false, error: "NO_CONFIG"} = result
    end

    test "malformed config (non-map at root) fails closed" do
      result = Evaluator.evaluate("not-a-map", "k", false)
      assert %EvaluationResult{value: false, error: "MALFORMED_CONFIG"} = result
    end

    test "missing 'f' fails closed with MALFORMED_CONFIG" do
      result = Evaluator.evaluate(%{}, "k", false)
      assert %EvaluationResult{value: false, error: "MALFORMED_CONFIG"} = result
    end

    test "key absent fails closed with KEY_NOT_FOUND" do
      cfg = config_with(%{"a" => %{"t" => 0, "v" => %{"b" => true}}})
      result = Evaluator.evaluate(cfg, "missing", false)
      assert %EvaluationResult{value: false, error: "KEY_NOT_FOUND"} = result
    end

    # Spec 072 (#259) reshape: UNSUPPORTED_TYPE now applies only to a
    # GENUINELY unknown `t` discriminator (not 0/1/2/3). The pre-existing
    # "non-boolean setting → UNSUPPORTED_TYPE" check is replaced — t=1/2/3
    # settings resolve via the widened evaluator below.
    test "genuinely unknown setting type (t=99) fails closed with UNSUPPORTED_TYPE" do
      cfg = config_with(%{"k" => %{"t" => 99, "v" => %{"b" => true}}})
      result = Evaluator.evaluate(cfg, "k", false)
      assert %EvaluationResult{value: false, error: "UNSUPPORTED_TYPE"} = result
    end
  end

  describe "evaluate/4 — t=0 boolean" do
    test "happy path returns the cached boolean value + variation_id" do
      cfg = config_with(%{"k" => %{"t" => 0, "v" => %{"b" => true}, "i" => "v-1"}})
      result = Evaluator.evaluate(cfg, "k", false)
      assert %EvaluationResult{value: true, error: nil, variation_id: "v-1"} = result
      assert EvaluationResult.ok?(result)
    end

    test "non-boolean default with boolean setting fails closed with TYPE_MISMATCH" do
      cfg = config_with(%{"k" => %{"t" => 0, "v" => %{"b" => true}}})
      result = Evaluator.evaluate(cfg, "k", "string-default")
      assert %EvaluationResult{value: "string-default", error: "TYPE_MISMATCH"} = result
    end

    test "value-slot missing 'b' fails closed with VALUE_NOT_BOOL" do
      cfg = config_with(%{"k" => %{"t" => 0, "v" => %{"s" => "foo"}}})
      result = Evaluator.evaluate(cfg, "k", false)
      assert %EvaluationResult{value: false, error: "VALUE_NOT_BOOL"} = result
    end
  end

  describe "evaluate/4 — t=1 string" do
    test "happy path returns the cached binary value" do
      cfg = config_with(%{"k" => %{"t" => 1, "v" => %{"s" => "hello"}}})
      result = Evaluator.evaluate(cfg, "k", "fallback")
      assert %EvaluationResult{value: "hello", error: nil} = result
    end

    test "integer default against t=1 fails closed with TYPE_MISMATCH" do
      cfg = config_with(%{"k" => %{"t" => 1, "v" => %{"s" => "hello"}}})
      result = Evaluator.evaluate(cfg, "k", -1)
      assert %EvaluationResult{value: -1, error: "TYPE_MISMATCH"} = result
    end

    test "missing v.s fails closed with MALFORMED_VALUE" do
      cfg = config_with(%{"k" => %{"t" => 1, "v" => %{"b" => true}}})
      result = Evaluator.evaluate(cfg, "k", "fallback")
      assert %EvaluationResult{value: "fallback", error: "MALFORMED_VALUE"} = result
    end
  end

  describe "evaluate/4 — t=2 int" do
    test "happy path returns the cached integer value" do
      cfg = config_with(%{"k" => %{"t" => 2, "v" => %{"i" => 5}}})
      result = Evaluator.evaluate(cfg, "k", -1)
      assert %EvaluationResult{value: 5, error: nil} = result
      assert is_integer(result.value)
    end

    test "binary default against t=2 fails closed with TYPE_MISMATCH" do
      cfg = config_with(%{"k" => %{"t" => 2, "v" => %{"i" => 5}}})
      result = Evaluator.evaluate(cfg, "k", "fallback")
      assert %EvaluationResult{value: "fallback", error: "TYPE_MISMATCH"} = result
    end

    test "float default against t=2 resolves (int/double are one number type)" do
      # Spec 152 / #475 (US2): Int (2) and Double (3) both map to the
      # canonical "number" expected type, so a float default against a t=2
      # setting is NOT a TYPE_MISMATCH — it resolves to the served int.
      # This matches the upstream `configcat` Elixir SDK, whose
      # `check_type_mismatch/2` treats `[int, double]` as interchangeable
      # (Principle II), and the canonical TS evaluator (single JS `number`).
      cfg = config_with(%{"k" => %{"t" => 2, "v" => %{"i" => 5}}})
      result = Evaluator.evaluate(cfg, "k", -1.0)
      assert %EvaluationResult{value: 5, error: nil} = result
    end

    test "missing v.i fails closed with MALFORMED_VALUE" do
      cfg = config_with(%{"k" => %{"t" => 2, "v" => %{"s" => "5"}}})
      result = Evaluator.evaluate(cfg, "k", -1)
      assert %EvaluationResult{value: -1, error: "MALFORMED_VALUE"} = result
    end
  end

  describe "evaluate/4 — t=3 double" do
    test "happy path returns the cached float value" do
      cfg = config_with(%{"k" => %{"t" => 3, "v" => %{"d" => 0.25}}})
      result = Evaluator.evaluate(cfg, "k", -1.0)
      assert %EvaluationResult{value: 0.25, error: nil} = result
      assert is_float(result.value)
    end

    test "integer default against t=3 resolves (int/double are one number type)" do
      # Spec 152 / #475 (US2): an integer default against a t=3 (double)
      # setting is NOT a TYPE_MISMATCH — both Int and Double are the single
      # canonical "number" type. The served double value is returned. This
      # matches the upstream `configcat` Elixir SDK's `check_type_mismatch/2`
      # (`[int, double]` interchangeable — Principle II) and the canonical
      # TS evaluator; consumers may pass `0` against a double setting.
      cfg = config_with(%{"k" => %{"t" => 3, "v" => %{"d" => 0.25}}})
      result = Evaluator.evaluate(cfg, "k", 0)
      assert %EvaluationResult{value: 0.25, error: nil} = result
    end

    test "missing v.d fails closed with MALFORMED_VALUE" do
      cfg = config_with(%{"k" => %{"t" => 3, "v" => %{"s" => "0.25"}}})
      result = Evaluator.evaluate(cfg, "k", -1.0)
      assert %EvaluationResult{value: -1.0, error: "MALFORMED_VALUE"} = result
    end
  end
end
