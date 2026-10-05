# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Sealed do
  @moduledoc false
  # A secret — the SDK key, or the request URL that carries it (#803) —
  # held behind a closure.
  #
  # `@derive Inspect` only hides a field from Elixir's `inspect/1`. A
  # crash report is also rendered by Erlang's `~p` (`logger_formatter`,
  # or any non-Elixir formatter), and a `function_clause` stacktrace
  # carries the failing call's ARGUMENTS — a GenServer state included —
  # into the `proc_lib` crash report, the supervisor report and the
  # `crash_reason` metadata, none of which `format_status/1` reaches.
  # Every renderer prints a fun as `#Fun<...>` / `#Function<...>`, never
  # the value it captured, so a sealed secret stays out of all of them.

  @derive {Inspect, only: []}
  @enforce_keys [:read]
  defstruct [:read]

  @opaque t :: %__MODULE__{read: (-> term())}

  @doc "Seal `value`; an already sealed value is returned as is."
  @spec seal(term()) :: t()
  def seal(%__MODULE__{} = sealed), do: sealed
  def seal(value), do: %__MODULE__{read: fn -> value end}

  @doc "The sealed value; any other term is returned as is."
  @spec unseal(t() | term()) :: term()
  def unseal(%__MODULE__{read: read}), do: read.()
  def unseal(value), do: value
end
