# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Prerequisites do
  @moduledoc """
  Prerequisite-flag condition resolution + circular-dependency detection
  (spec 124, US4/FR-007/SC-004).

  Ported from `packages/sdk-shared/src/prerequisites.ts`. A prerequisite
  condition (`%{"f" => key, "c" => comparator, "v" => value_envelope}`) is
  resolved by re-evaluating the prerequisite flag `f` (in the same config /
  user), then comparing its resolved value to the expected `v` read through the
  prerequisite flag's declared `SettingType`.

  Cycle detection uses an IMMUTABLE `visited_flags` accumulator threaded
  through recursion (NOT a mutable stack): each recursion gets its own extended
  list, sidestepping any stack-unwind concern entirely. Before recursing we
  push the CURRENT key and check whether the prerequisite key is already
  present — if so we RAISE `CircularDependencyError`, caught by the evaluator's
  fail-closed frame → fallback + error, bounded, no infinite recursion.
  """

  defmodule CircularDependencyError do
    @moduledoc false
    # `cycle` carries the `key -> … -> key` chain so the trace logger can emit
    # ConfigCat's distinct ERROR 1002 line (`[<cycle>]`) without re-parsing the
    # message (parity with the Go / Ruby ports' `cycle` field).
    defexception [:message, :cycle]
  end

  @prereq_equals 0
  @prereq_not_equals 1

  @doc """
  Resolve one prerequisite-flag condition.

    * `condition`    — `%{"f" => key, "c" => cmp, "v" => envelope}`.
    * `current_key`  — the key currently being evaluated.
    * `visited_flags` — the immutable cycle-detection accumulator.
    * `prereq_type`  — `(key -> setting_type | nil)`.
    * `eval_prereq`  — `(key, extended_visited, acc -> {value_envelope, acc})`;
      re-evaluates the prerequisite flag, threading the EXTENDED visited list
      and the opaque trace accumulator (the eval-log context).
    * `select_value` — `(envelope, type -> primitive | nil)`.
    * `acc`          — the threaded trace accumulator returned alongside the
      boolean outcome so the caller's eval-log builder propagates.

  Returns `{boolean(), acc}`. Raises `CircularDependencyError` on a detected
  cycle or a runtime error on a missing prerequisite flag.
  """
  @spec evaluate(
          map(),
          String.t(),
          [String.t()],
          (String.t() -> integer() | nil),
          (String.t(), [String.t()], acc -> {map(), acc}),
          (map() | nil, integer() -> term()),
          acc
        ) ::
          {boolean(), acc}
        when acc: term()
  def evaluate(condition, current_key, visited_flags, prereq_type, eval_prereq, select_value, acc) do
    prereq_key = Map.get(condition, "f")

    unless is_binary(prereq_key) do
      raise "Prerequisite flag key is missing or invalid."
    end

    declared_type = prereq_type.(prereq_key)

    if is_nil(declared_type) do
      raise "Prerequisite flag is missing or invalid."
    end

    comparison_value = select_value.(Map.get(condition, "v"), declared_type)

    extended = visited_flags ++ [current_key]

    if prereq_key in extended do
      cycle = Enum.join(extended ++ [prereq_key], " -> ")

      raise CircularDependencyError,
        message: "Circular dependency detected between the following depending flags: #{cycle}.",
        cycle: cycle
    end

    {resolved_envelope, acc} = eval_prereq.(prereq_key, extended, acc)
    resolved_value = select_value.(resolved_envelope, declared_type)

    outcome =
      case Map.get(condition, "c") do
        @prereq_equals -> resolved_value === comparison_value
        @prereq_not_equals -> resolved_value !== comparison_value
        _ -> raise "Comparison operator is missing or invalid."
      end

    {outcome, acc}
  end
end
