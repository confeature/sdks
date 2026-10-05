# SPDX-License-Identifier: MIT

defmodule Confeature.EvaluationDetails do
  @moduledoc """
  Typed result envelope returned by `Confeature.get_value_details/4`,
  `Confeature.Client.get_value_details/4`, and
  `Confeature.Snapshot.get_value_details/3`.

  Field layout mirrors upstream `ConfigCat.EvaluationDetails` 1:1
  (`TypedStruct` with the same 9 fields, including the `:default_value?`
  predicate name and `DateTime.t()` for `:fetch_time`). A consumer
  migrating from `configcat` reads the same field names in the same
  positions: only the module alias changes.

  Stable error codes populating `:error` on fail branches match the
  evaluator's tier-0 set:
    `KEY_NOT_FOUND` / `TYPE_MISMATCH` / `MALFORMED_VALUE` /
    `UNSUPPORTED_TYPE` / `NO_CONFIG` / `MALFORMED_CONFIG` /
    `VALUE_NOT_BOOL` / `CLIENT_CLOSED`.

  `:fetch_time` is a `DateTime` (UTC) stamped on the last successful
  fetch / cache restore. `nil` until any config has loaded.

  `:matched_targeting_rule` + `:matched_percentage_option` are v1
  placeholders (always `nil`); a future spec lands the wire-level
  targeting tree and populates them.
  """

  use TypedStruct

  alias Confeature.User

  typedstruct do
    field(:default_value?, boolean(), default: false)
    field(:error, String.t())
    field(:fetch_time, DateTime.t())
    field(:key, String.t(), enforce: true)
    field(:matched_targeting_rule, map())
    field(:matched_percentage_option, map())
    field(:user, User.t())
    field(:value, term(), enforce: true)
    field(:variation_id, String.t())
  end

  @doc "Build an `EvaluationDetails` struct from keyword opts."
  @spec new(keyword()) :: t()
  def new(options), do: struct!(__MODULE__, options)

  @doc """
  Convenience factory for fail-closed branches (closed client,
  caller-supplied invalid input, etc.). Stamps `:default_value?` to
  `true` and propagates the supplied error code.
  """
  @spec make_error(String.t(), term(), String.t(), User.t() | nil) :: t()
  def make_error(key, default_value, error, user) do
    new(key: key, value: default_value, default_value?: true, error: error, user: user)
  end
end
