# SPDX-License-Identifier: MIT

defmodule Confeature.EvaluationDetails do
  @moduledoc """
  Typed result envelope returned by `Confeature.get_value_details/4`,
  `Confeature.Client.get_value_details/4`, and
  `Confeature.Snapshot.get_value_details/3`.

  Field layout mirrors upstream `ConfigCat.EvaluationDetails` 1:1
  (the same 9 fields as its `TypedStruct`, including the `:default_value?`
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

  # A plain struct, not `use TypedStruct`: that macro reached this package
  # only as a test-only transitive dependency of the `configcat` oracle, so
  # a customer's `mix deps.compile` failed with "module TypedStruct is not
  # loaded" (#805). Same 9 fields, same defaults, same enforced keys and the
  # same `t()` TypedStruct generated (a non-enforced field with no default
  # is nilable), with no new dependency.

  alias Confeature.User

  @enforce_keys [:key, :value]
  defstruct [
    :error,
    :fetch_time,
    :key,
    :matched_targeting_rule,
    :matched_percentage_option,
    :user,
    :value,
    :variation_id,
    default_value?: false
  ]

  @type t() :: %__MODULE__{
          default_value?: boolean(),
          error: String.t() | nil,
          fetch_time: DateTime.t() | nil,
          key: String.t(),
          matched_targeting_rule: map() | nil,
          matched_percentage_option: map() | nil,
          user: User.t() | nil,
          value: term(),
          variation_id: String.t() | nil
        }

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
