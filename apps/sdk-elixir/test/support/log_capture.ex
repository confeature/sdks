# SPDX-License-Identifier: MIT

defmodule Confeature.LogCapture do
  @moduledoc false
  # Captures the RAW `:logger` events a block produces (#803) — crash
  # reports included — so a key-free assertion can actually fail.
  #
  # `ExUnit.CaptureLog` cannot: Elixir's primary `logger_translator`
  # filter drops every SASL-domain event (`proc_lib` crash reports,
  # supervisor reports) while `handle_sasl_reports` is false, and
  # rewrites the rest into `inspect/1` text, which honours
  # `@derive Inspect` — a formatter printing the report itself (Erlang's
  # `logger_formatter`, a JSON formatter printing `crash_reason`) does
  # not. For the block's duration this removes that primary filter and
  # silences the `:default` handler, and installs a handler that forwards
  # each untouched event here. Use only from an `async: false` module.

  @doc """
  Run `fun`, then wait (up to `timeout` ms) until an event of every
  report label in `labels` arrived. Returns `{fun_result, events}`.
  """
  def capture(fun, labels \\ [], timeout \\ 2_000) do
    id = :"confeature_log_capture_#{System.unique_integer([:positive])}"
    %{filters: filters} = :logger.get_primary_config()
    {:ok, %{level: default_level}} = :logger.get_handler_config(:default)

    :ok = :logger.update_primary_config(%{filters: Keyword.delete(filters, :logger_translator)})
    :ok = :logger.update_handler_config(:default, :level, :none)
    :ok = :logger.add_handler(id, __MODULE__, %{level: :all, config: %{owner: self(), id: id}})

    try do
      result = fun.()
      {result, await(id, labels, [], System.monotonic_time(:millisecond) + timeout)}
    after
      :logger.remove_handler(id)
      :logger.update_handler_config(:default, :level, default_level)
      :logger.update_primary_config(%{filters: filters})
    end
  end

  # `:logger` handler callback — runs in the logging process.
  def log(event, %{config: %{owner: owner, id: id}}), do: send(owner, {id, event})

  defp await(id, labels, acc, deadline) do
    if Enum.all?(labels, fn label -> Enum.any?(acc, &(label(&1) == label)) end) do
      drain(id, acc)
    else
      receive do
        {^id, event} -> await(id, labels, [event | acc], deadline)
      after
        max(deadline - System.monotonic_time(:millisecond), 0) -> Enum.reverse(acc)
      end
    end
  end

  # Collect what is already queued (a report logged alongside the awaited ones).
  defp drain(id, acc) do
    receive do
      {^id, event} -> drain(id, [event | acc])
    after
      100 -> Enum.reverse(acc)
    end
  end

  @doc "The report label of an event (`{:proc_lib, :crash}`, …), or `nil`."
  def label(%{msg: {:report, %{label: label}}}), do: label
  def label(_event), do: nil

  @doc """
  Every rendering of `event` a log pipeline might print: Erlang's
  `logger_formatter` (the report through its `report_cb`) and the raw
  event — report and metadata — inspected without struct protocols.
  """
  def render(event) do
    erlang =
      event
      |> :logger_formatter.format(%{single_line: false, template: [:msg, "\n"]})
      |> IO.chardata_to_string()

    raw = inspect(event, structs: false, limit: :infinity, printable_limit: :infinity)
    erlang <> "\n" <> raw
  end
end
