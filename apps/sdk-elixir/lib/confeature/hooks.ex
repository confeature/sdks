# SPDX-License-Identifier: MIT

defmodule Confeature.Hooks do
  @moduledoc """
  Subscribe to client lifecycle events. Mirrors `ConfigCat.Hooks` 1:1 at the public API
  surface (constitution Principle II, epic #268).

  Four hook points match the JS-family reference contract: `client_ready`,
  `config_changed`, `flag_evaluated`, `error`. Listener exceptions are caught + logged
  by the `invoke_on_*` paths — never escape to the emitter.

  Obtain via `Confeature.Client.hooks/1`.
  """

  use Agent

  alias Confeature.EvaluationDetails

  @type t :: pid() | atom()
  @type on_client_ready_callback :: (-> any())
  @type on_config_changed_callback :: (map() -> any())
  @type on_flag_evaluated_callback :: (EvaluationDetails.t() -> any())
  @type on_error_callback :: (String.t() -> any())

  defmodule State do
    @moduledoc false
    defstruct on_client_ready: [],
              on_config_changed: [],
              on_flag_evaluated: [],
              on_error: [],
              logger: nil
  end

  @doc """
  Start a Hooks agent. Returns `{:ok, pid}`.
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    logger = Keyword.get(opts, :logger)
    Agent.start_link(fn -> %State{logger: logger} end)
  end

  @doc "Subscribe to the first successful config load."
  @spec add_on_client_ready(t(), on_client_ready_callback()) :: :ok
  def add_on_client_ready(hooks, callback) when is_function(callback, 0) do
    Agent.update(hooks, fn s ->
      %State{s | on_client_ready: [callback | s.on_client_ready]}
    end)
  end

  @doc "Subscribe to every fetched config. The callback receives the settings map."
  @spec add_on_config_changed(t(), on_config_changed_callback()) :: :ok
  def add_on_config_changed(hooks, callback) when is_function(callback, 1) do
    Agent.update(hooks, fn s ->
      %State{s | on_config_changed: [callback | s.on_config_changed]}
    end)
  end

  @doc "Subscribe to every `EvaluationDetails` produced by `get_value_details`."
  @spec add_on_flag_evaluated(t(), on_flag_evaluated_callback()) :: :ok
  def add_on_flag_evaluated(hooks, callback) when is_function(callback, 1) do
    Agent.update(hooks, fn s ->
      %State{s | on_flag_evaluated: [callback | s.on_flag_evaluated]}
    end)
  end

  @doc "Subscribe to non-fatal SDK errors (HTTP failures, cache I/O)."
  @spec add_on_error(t(), on_error_callback()) :: :ok
  def add_on_error(hooks, callback) when is_function(callback, 1) do
    Agent.update(hooks, fn s -> %State{s | on_error: [callback | s.on_error]} end)
  end

  # --- internal invokers ---------------------------------------------------

  @doc false
  @spec invoke_on_client_ready(t()) :: :ok
  def invoke_on_client_ready(hooks) do
    state = Agent.get(hooks, & &1)

    Enum.each(
      Enum.reverse(state.on_client_ready),
      &safe_call(&1, :on_client_ready, [], state.logger)
    )
  end

  @doc false
  @spec invoke_on_config_changed(t(), map()) :: :ok
  def invoke_on_config_changed(hooks, settings) do
    state = Agent.get(hooks, & &1)

    Enum.each(
      Enum.reverse(state.on_config_changed),
      &safe_call(&1, :on_config_changed, [settings], state.logger)
    )
  end

  @doc false
  @spec invoke_on_flag_evaluated(t(), EvaluationDetails.t()) :: :ok
  def invoke_on_flag_evaluated(hooks, details) do
    state = Agent.get(hooks, & &1)

    Enum.each(
      Enum.reverse(state.on_flag_evaluated),
      &safe_call(&1, :on_flag_evaluated, [details], state.logger)
    )
  end

  @doc false
  @spec invoke_on_error(t(), String.t()) :: :ok
  def invoke_on_error(hooks, message) do
    state = Agent.get(hooks, & &1)

    Enum.each(
      Enum.reverse(state.on_error),
      &safe_call(&1, :on_error, [message], state.logger)
    )
  end

  defp safe_call(callback, hook_name, args, logger) do
    apply(callback, args)
    :ok
  rescue
    error ->
      log_error(logger, hook_name, error)
      :ok
  end

  defp log_error(nil, _hook, _error), do: :ok

  defp log_error(logger, hook_name, error) do
    Confeature.Logger.error(
      logger,
      "Hooks: #{hook_name} listener raised: #{inspect(error)}"
    )
  end
end
