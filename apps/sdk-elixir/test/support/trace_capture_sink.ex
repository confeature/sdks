# SPDX-License-Identifier: MIT

defmodule Confeature.TraceCaptureSink do
  @moduledoc false
  # INFO-level eval-log capture sink (#501): accumulates each emitted
  # `(level, event_id, message)` into an Agent (Elixir is immutable, so the
  # sink holds a process the trace logger writes to).
  #
  # Defined under test/support (an elixirc_path) — NOT in the test file —
  # so its `Sink` protocol implementation is compiled BEFORE protocol
  # consolidation. A defimpl inside a `*_test.exs` file is loaded after
  # consolidation and is silently ignored.
  defstruct [:agent]
end

defimpl Confeature.Internal.EvalLogger.Sink, for: Confeature.TraceCaptureSink do
  def level(_sink), do: 3

  def log(%{agent: agent}, level, event_id, message) do
    Agent.update(agent, fn acc -> [{level, event_id, message} | acc] end)
    :ok
  end
end
