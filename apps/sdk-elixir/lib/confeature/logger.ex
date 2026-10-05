# SPDX-License-Identifier: MIT

defmodule Confeature.Logger do
  @moduledoc """
  Pluggable logger surface.

  Customers integrate by either:
    - keeping the default Elixir `Logger`-backed implementation, or
    - passing a struct with a `:level` atom + a custom `:io_device`,
      or
    - implementing the same callback shape themselves and passing the
      struct.

  The default level is `:warning` (mirrors `configcat`'s default).

  SECURITY (constitution security clause + FR-013): SDK keys are
  secrets. Every log site MUST route through
  `Confeature.Internal.SdkKey.redact/1`. The raw key NEVER appears in
  any log line.
  """

  alias Confeature.LogLevel

  defstruct level: :warning, io_device: :stderr

  @type t :: %__MODULE__{
          level: LogLevel.t(),
          io_device: :stderr | :stdio | atom() | pid()
        }

  @doc """
  Build a logger struct with sensible defaults.

  ## Options

    * `:level` — minimum level to emit (default `:warning`).
    * `:io_device` — `:stderr` (default), `:stdio`, or a registered
      device / pid for tests.

  """
  @spec new(keyword()) :: t()
  def new(opts \\ []) do
    %__MODULE__{
      level: Keyword.get(opts, :level, :warning),
      io_device: Keyword.get(opts, :io_device, :stderr)
    }
  end

  @doc "Emit at ERROR if configured level <= :error."
  @spec error(t(), iodata()) :: :ok
  def error(%__MODULE__{} = logger, message), do: emit(logger, :error, message)

  @doc "Emit at WARNING if configured level <= :warning."
  @spec warning(t(), iodata()) :: :ok
  def warning(%__MODULE__{} = logger, message), do: emit(logger, :warning, message)

  @doc "Emit at INFO if configured level <= :info."
  @spec info(t(), iodata()) :: :ok
  def info(%__MODULE__{} = logger, message), do: emit(logger, :info, message)

  @doc "Emit at DEBUG if configured level <= :debug."
  @spec debug(t(), iodata()) :: :ok
  def debug(%__MODULE__{} = logger, message), do: emit(logger, :debug, message)

  @doc "Build a silent logger — drops every level. Useful in tests."
  @spec silent() :: t()
  def silent, do: %__MODULE__{level: :off, io_device: :stderr}

  defp emit(%__MODULE__{level: configured, io_device: io}, level, message) do
    if LogLevel.to_int(level) >= LogLevel.to_int(configured) do
      prefix = "[confeature][#{level}] "
      IO.puts(io, [prefix, message])
    else
      :ok
    end
  end
end
