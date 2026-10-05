# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Segments do
  @moduledoc """
  Segment-condition resolution (spec 124, US4/FR-006).

  Ported from `packages/sdk-shared/src/segments.ts`. A segment condition
  (`%{"s" => index, "c" => comparator}`) references a segment by index into the
  config's top-level `s[]` (`%{"n" => name, "r" => [user_condition]}`). The
  segment's `r[]` entries are BARE user conditions, AND-grouped: the user
  IS-IN the segment iff every condition matches; the membership decision is
  then optionally negated by `IsNotIn`.

  The sensitive-comparator context salt is the segment NAME (`segment.n`), not
  the setting key — getting this wrong silently breaks every hashed segment row.

  Three-valued outcome: `true` / `false` / `{:error, msg}`. An error is
  returned un-negated — `IsNotIn` never flips an error into a match. A malformed
  segment reference RAISES (caught by the evaluator's fail-closed frame).
  """

  @segment_is_not_in 1

  @doc """
  Resolve one segment condition. `eval_user_condition` is injected (the
  evaluator owns it): it evaluates one segment `r[]` user condition with the
  segment name as the context salt, threading the surfaced eval-error
  accumulator. It receives `(user_condition, context_salt, err)` and returns
  `{outcome, next_err}`.

  Returns `{outcome, next_err}` where outcome is `true | false | {:error, msg}`.
  """
  @spec evaluate(
          map(),
          [map()],
          boolean(),
          (term() -> term()),
          (map(), String.t(), term() -> {term(), term()}),
          term()
        ) :: {boolean() | {:error, String.t()}, term()}
  def evaluate(condition, segments, has_user, surface_missing_user, eval_user_condition, err) do
    if not has_user do
      next_err = surface_missing_user.(err)
      {{:error, missing_user_message()}, next_err}
    else
      index = Map.get(condition, "s")

      unless is_integer(index) and index >= 0 and index < length(segments) do
        raise "Segment reference is invalid."
      end

      segment = Enum.at(segments, index)
      segment_name = Map.get(segment, "n")

      unless is_binary(segment_name) and segment_name != "" do
        raise "Segment name is missing."
      end

      {in_segment, next_err} =
        walk_conditions(Map.get(segment, "r", []), segment_name, eval_user_condition, err)

      {negate_if_needed(in_segment, Map.get(condition, "c")), next_err}
    end
  end

  defp missing_user_message, do: "cannot evaluate, User Object is missing"

  defp walk_conditions(conditions, segment_name, eval_user_condition, err) do
    Enum.reduce_while(conditions, {true, err}, fn uc, {_acc, acc_err} ->
      case eval_user_condition.(uc, segment_name, acc_err) do
        {true, next_err} -> {:cont, {true, next_err}}
        {other, next_err} -> {:halt, {other, next_err}}
      end
    end)
  end

  defp negate_if_needed({:error, _} = err, _comparator), do: err

  defp negate_if_needed(in_segment, comparator) when is_boolean(in_segment) do
    if comparator == @segment_is_not_in, do: not in_segment, else: in_segment
  end
end
