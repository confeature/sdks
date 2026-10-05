# SPDX-License-Identifier: MIT

defmodule Confeature.PollingMode do
  @moduledoc """
  Polling-mode factory + value types.

  Mirrors the upstream `configcat` Elixir package's `PollingMode`
  module: three factory functions produce immutable structs that the
  client wires into the matching internal poll loop (AutoPoll →
  GenServer interval-driven, LazyLoad → on-demand staleness check,
  ManualPoll → caller-driven).
  """

  defmodule AutoPoll do
    @moduledoc "Configures periodic background polling."
    @enforce_keys [:poll_interval_seconds, :max_init_wait_time_seconds]
    defstruct [:poll_interval_seconds, :max_init_wait_time_seconds]

    @type t :: %__MODULE__{
            poll_interval_seconds: pos_integer(),
            max_init_wait_time_seconds: non_neg_integer()
          }
  end

  defmodule LazyLoad do
    @moduledoc "Configures on-demand staleness-driven polling."
    @enforce_keys [:cache_refresh_interval_seconds]
    defstruct [:cache_refresh_interval_seconds]

    @type t :: %__MODULE__{cache_refresh_interval_seconds: pos_integer()}
  end

  defmodule ManualPoll do
    @moduledoc "Configures caller-driven polling (no background fetches)."
    defstruct []
    @type t :: %__MODULE__{}
  end

  @type t :: AutoPoll.t() | LazyLoad.t() | ManualPoll.t()

  @doc """
  Build an AutoPoll value with the standard ConfigCat defaults.

  ## Options

    * `:poll_interval` — seconds between background fetches (default 60).
    * `:max_init_wait_time` — seconds to wait for the initial fetch
      before letting `get_value/4` proceed with the cached/empty body
      (default 5).
  """
  @spec auto_poll(keyword()) :: AutoPoll.t()
  def auto_poll(opts \\ []) do
    %AutoPoll{
      poll_interval_seconds: Keyword.get(opts, :poll_interval, 60),
      max_init_wait_time_seconds: Keyword.get(opts, :max_init_wait_time, 5)
    }
  end

  @doc """
  Build a LazyLoad value with the standard ConfigCat default
  (60 seconds).
  """
  @spec lazy_load(keyword()) :: LazyLoad.t()
  def lazy_load(opts \\ []) do
    %LazyLoad{
      cache_refresh_interval_seconds: Keyword.get(opts, :cache_refresh_interval, 60)
    }
  end

  @doc "Build a ManualPoll value."
  @spec manual_poll() :: ManualPoll.t()
  def manual_poll, do: %ManualPoll{}
end
