# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.FilesystemCache do
  @moduledoc """
  Persists a cache entry as JSON at
  `{cache_dir}/confeature-{cache_key_tail}.json`.

  On any IO error during write, switches the instance into memory-only
  mode and emits a single WARNING log entry. Subsequent reads/writes
  use the in-memory entry — the filesystem is never retried (FR-014).

  Backed by an Agent so multiple writers cannot collide on the temp-
  rename atomicity sequence.
  """
  @behaviour Confeature.ConfigCache

  use Agent

  alias Confeature.Internal.{Options, SdkKey}
  alias Confeature.Logger, as: ConfLogger

  # The agent never holds the SDK key (#803): only its `SdkKey.redact/1`
  # form, for log lines. Its state — rendered by `:sys.get_status/1`, a
  # crash report or any formatter — has no key to quote.
  defstruct [
    :cache_dir,
    :file_path,
    :redacted_sdk_key,
    :logger,
    fallback_triggered: false,
    memory_entry: nil
  ]

  @type state :: %__MODULE__{
          cache_dir: String.t(),
          file_path: String.t(),
          redacted_sdk_key: String.t(),
          logger: ConfLogger.t(),
          fallback_triggered: boolean(),
          memory_entry: map() | nil
        }

  @doc """
  Spawn the agent. Options:
    * `:cache_dir` — required.
    * `:cache_key` — required (full key, e.g. `"confeature:cache:v1:..."`).
    * `:sdk_key` — required (a String or a `Confeature.Internal.Sealed`
      one); only its redacted form is kept.
    * `:logger` — required `Confeature.Logger.t()`.
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts) do
    cache_dir = required!(opts, :cache_dir)
    cache_key = required!(opts, :cache_key)
    redacted_sdk_key = opts |> required!(:sdk_key) |> SdkKey.redact()
    logger = required!(opts, :logger)

    tail = cache_key |> String.split(":") |> List.last()
    file_path = Path.join(cache_dir, "confeature-#{tail}.json")

    Agent.start_link(fn ->
      %__MODULE__{
        cache_dir: cache_dir,
        file_path: file_path,
        redacted_sdk_key: redacted_sdk_key,
        logger: logger
      }
    end)
  end

  # A missing option, or options that are no keyword list, is a fixed
  # message: the options carry the SDK key (`Confeature.Internal.Options`).
  defp required!(opts, name), do: Options.required!(opts, name, "FilesystemCache.start_link/1")

  @impl true
  def read(pid) when is_pid(pid) do
    Agent.get(pid, &do_read/1)
  end

  @impl true
  def write(pid, entry) when is_pid(pid) and is_map(entry) do
    Agent.update(pid, fn state -> do_write(state, entry) end)
  end

  @doc "Inspect-only — return the resolved file path the agent owns."
  @spec file_path(pid()) :: String.t()
  def file_path(pid) when is_pid(pid) do
    Agent.get(pid, & &1.file_path)
  end

  defp do_read(%__MODULE__{fallback_triggered: true, memory_entry: entry}), do: entry

  defp do_read(%__MODULE__{file_path: file_path, logger: logger} = state) do
    case File.read(file_path) do
      {:ok, content} ->
        decode_entry(content, file_path, logger, state.redacted_sdk_key)

      {:error, :enoent} ->
        nil

      {:error, reason} ->
        ConfLogger.warning(
          logger,
          "FilesystemCache.read: failed to load #{file_path} " <>
            "(sdkKey=#{state.redacted_sdk_key}): #{inspect(reason)}"
        )

        nil
    end
  end

  defp decode_entry(content, file_path, logger, redacted_sdk_key) do
    case Jason.decode(content) do
      {:ok, %{"body" => body} = decoded} when is_map(body) ->
        %{
          body: body,
          etag: Map.get(decoded, "etag"),
          fetched_at: Map.get(decoded, "fetched_at", 0.0) * 1.0
        }

      _ ->
        ConfLogger.warning(
          logger,
          "FilesystemCache.read: malformed cache file #{file_path} " <>
            "(sdkKey=#{redacted_sdk_key})"
        )

        nil
    end
  end

  defp do_write(%__MODULE__{fallback_triggered: true} = state, entry) do
    %{state | memory_entry: entry}
  end

  defp do_write(%__MODULE__{} = state, entry) do
    payload =
      Jason.encode!(%{
        "body" => Map.get(entry, :body),
        "etag" => Map.get(entry, :etag),
        "fetched_at" => Map.get(entry, :fetched_at, 0.0)
      })

    with :ok <- ensure_dir(state.cache_dir),
         tmp_path = state.file_path <> ".tmp",
         :ok <- File.write(tmp_path, payload),
         :ok <- File.rename(tmp_path, state.file_path) do
      %{state | memory_entry: entry}
    else
      {:error, reason} ->
        ConfLogger.warning(
          state.logger,
          "FilesystemCache.write: filesystem unwritable for #{state.file_path} " <>
            "(sdkKey=#{state.redacted_sdk_key}): #{inspect(reason)}. " <>
            "Falling back to memory-only cache for this client."
        )

        %{state | fallback_triggered: true, memory_entry: entry}
    end
  end

  defp ensure_dir(dir) do
    case File.mkdir_p(dir) do
      :ok -> :ok
      {:error, _} = err -> err
    end
  end
end
