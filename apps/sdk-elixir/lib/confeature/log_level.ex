# SPDX-License-Identifier: MIT

defmodule Confeature.LogLevel do
  @moduledoc """
  Confeature log levels. Atom-based to align with Elixir's `Logger`
  level convention; numeric helpers for ordering comparisons.

  Levels in ascending verbosity-to-noise order: `:debug` <
  `:info` < `:warning` < `:error` < `:off`. `:off` suppresses every
  level — used by the silent test logger.
  """

  @type t :: :debug | :info | :warning | :error | :off

  @levels [:debug, :info, :warning, :error, :off]

  @spec all() :: [t()]
  def all, do: @levels

  @doc """
  Map a level atom to a monotone integer for `<=` comparisons.

  Higher integers mean less verbose. `:off` returns the largest value
  so no message passes the `level <= configured` gate.
  """
  @spec to_int(t()) :: non_neg_integer()
  def to_int(:debug), do: 0
  def to_int(:info), do: 1
  def to_int(:warning), do: 2
  def to_int(:error), do: 3
  def to_int(:off), do: 99
end
