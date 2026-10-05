# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.InMemoryCache do
  @moduledoc """
  Process-local in-memory cache.

  Backed by an Agent so multiple GenServer ticks and `get_value/4`
  callers see a coherent view of the latest entry.
  """
  @behaviour Confeature.ConfigCache

  use Agent

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> nil end)
  end

  @impl true
  def read(pid) when is_pid(pid) do
    Agent.get(pid, & &1)
  end

  @impl true
  def write(pid, entry) when is_pid(pid) and is_map(entry) do
    Agent.update(pid, fn _ -> entry end)
  end
end
