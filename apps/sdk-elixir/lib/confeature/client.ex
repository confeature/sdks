# SPDX-License-Identifier: MIT

defmodule Confeature.Client do
  @moduledoc """
  Top-level entry point — drop-in equivalent of the upstream `configcat`
  Elixir package's `ConfigCat` client.

  Implementation strategy: a `GenServer` owns the per-client mutable
  state (last-known config + ETag), an Agent owns the cache, and an
  optional internal timer drives `AutoPoll` refreshes via
  `Process.send_after/3`. All public API calls (`get_value/4`,
  `force_refresh/1`, `snapshot/1`, `stop/1`) are synchronous from the
  caller's point of view — they translate to `GenServer.call/3`.

  ## Lifecycle

      {:ok, pid} = Confeature.Client.start_link(
        sdk_key: "configcat-sdk-1/<22 chars>/<22 chars>",
        polling_mode: Confeature.PollingMode.auto_poll()
      )

      Confeature.Client.get_value(pid, "feature.dark-mode", false)
      Confeature.Client.force_refresh(pid)
      Confeature.Client.stop(pid)

  `stop/1` is idempotent — calling it twice (or against a pid that has
  already terminated) is safe.

  ## The SDK key is never rendered (#803)

  `start_link/1` and `child_spec/1` seal `:sdk_key` (`Confeature.Internal.Sealed`)
  before it reaches a supervisor's child spec or the process's init
  arguments, and the client holds it sealed. A supervisor report, a
  `proc_lib` crash report, a stacktrace's arguments, `:sys.get_state/1`
  and every formatter, Erlang's included, print the closure, never the
  key. `format_status/1` further redacts the status and crash report.
  """

  use GenServer

  alias Confeature.{EvaluationDetails, FlagOverrides, PollingMode, Snapshot, User, Version}

  alias Confeature.Internal.{
    ConfigFetcher,
    Evaluator,
    FilesystemCache,
    InMemoryCache,
    Options,
    OverrideEval,
    SdkKey,
    Sealed
  }

  alias Confeature.Logger, as: ConfLogger
  alias Confeature.PollingMode.{AutoPoll, LazyLoad}

  @default_base_url "https://cdn-global.confeature.io"

  @type opts :: [
          sdk_key: String.t(),
          polling_mode: PollingMode.t(),
          cache_directory: String.t() | :memory | nil,
          request_timeout_seconds: number(),
          logger: ConfLogger.t(),
          flag_overrides: FlagOverrides.t() | nil,
          base_url: String.t() | nil,
          default_user: User.t() | nil,
          http_client: module(),
          name: GenServer.name()
        ]

  defmodule State do
    @moduledoc false
    # `sdk_key` is sealed (#803); `inspect/1` omits it as well.
    @derive {Inspect, except: [:sdk_key]}
    defstruct [
      :sdk_key,
      :cache_key,
      :logger,
      :flag_overrides,
      :default_user,
      :polling_mode,
      :fetcher,
      :cache_pid,
      :cache_module,
      :config,
      :etag,
      :poll_timer,
      :last_fetched_at_ms,
      :fetch_time,
      # Spec 110 / #268 slice 8/14 — mirrors ConfigCat.Hooks. The agent
      # pid stores the four subscription lists.
      :hooks,
      closed: false,
      client_ready_fired: false,
      # Spec 100 / #267 slice 11/14 — mirrors configcat's :offline?
      offline: false
    ]
  end

  # ---- Public API --------------------------------------------------

  @doc """
  Start a Confeature client. Returns `{:ok, pid}` on success.

  ## Options

  See `t:opts/0`. Required: `:sdk_key`.
  """
  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, server_opts} =
      opts |> sealed_opts("Confeature.Client.start_link/1") |> Keyword.pop(:name)

    gen_opts = if name, do: [name: name], else: []
    GenServer.start_link(__MODULE__, server_opts, gen_opts)
  end

  @doc """
  The child spec for `{Confeature.Client, opts}` under a supervisor. Its
  `:sdk_key` is sealed, so a supervisor report (`start_error`,
  `child_terminated`, …), which quotes the child's start arguments, never
  quotes the key (#803).
  """
  @spec child_spec(opts()) :: Supervisor.child_spec()
  def child_spec(opts) do
    super(sealed_opts(opts, "Confeature.Client.child_spec/1"))
  end

  # `opts` with `:sdk_key` sealed. Options that are no keyword list (a map,
  # a string-keyed list) cannot be sealed, and would carry the raw key into
  # the child spec and, through `Keyword`'s `FunctionClauseError`, into the
  # start error and the supervisor report: they are rejected with a fixed
  # message instead (#803).
  defp sealed_opts(opts, caller) do
    opts = Options.keyword!(opts, caller)

    case Keyword.fetch(opts, :sdk_key) do
      {:ok, sdk_key} -> Keyword.put(opts, :sdk_key, Sealed.seal(sdk_key))
      :error -> opts
    end
  end

  @doc """
  Resolve `key`. Falls back to `default` on every miss, error, or
  closed-client call.

  The four `SettingType` discriminators all resolve through this
  function (spec 072 / issue #259): `t=0` returns a `boolean`, `t=1`
  a `String` (binary), `t=2` an `integer` (strict — `is_integer/1`
  rejects floats), `t=3` a `float` (strict — `is_float/1` rejects
  integers; pass `0.0`, not `0`). The `any()` return type is preserved
  for backward compatibility — callers narrow the return at the
  call-site.
  """
  @spec get_value(GenServer.server(), String.t(), any(), User.t() | nil) :: any()
  def get_value(client, key, default, user \\ nil) do
    GenServer.call(client, {:get_value, key, default, user})
  catch
    :exit, _ -> default
  end

  @doc """
  Spec 089 / #266 — typed-envelope mirror of `get_value/4`. Returns an
  `EvaluationDetails` struct carrying value + variation_id + error +
  user + fetch_time.

  Closed clients return
  `EvaluationDetails.make_error(key, default, "CLIENT_CLOSED", user)`.
  """
  @spec get_value_details(GenServer.server(), String.t(), any(), User.t() | nil) ::
          EvaluationDetails.t()
  def get_value_details(client, key, default, user \\ nil) do
    GenServer.call(client, {:get_value_details, key, default, user})
  catch
    :exit, _ -> EvaluationDetails.make_error(key, default, "CLIENT_CLOSED", user)
  end

  @doc """
  Spec 089 / #266 — evaluates every known flag for `user` and returns
  a `%{String.t() => term()}` map.

  Iterates the union of cached-config flag keys + override keys. The
  per-key value is the native typed value (from the override map first,
  then from the cached config). Keys whose resolved native value is
  `nil` are omitted, mirroring upstream's exclusion semantics. Closed
  clients return `%{}`.
  """
  @spec get_all_values(GenServer.server(), User.t() | nil) :: %{optional(String.t()) => term()}
  def get_all_values(client, user \\ nil) do
    GenServer.call(client, {:get_all_values, user})
  catch
    :exit, _ -> %{}
  end

  @doc """
  Force a synchronous refresh. Returns `:ok` on a successful 200 / 304,
  or `{:error, reason}` otherwise.
  """
  @spec force_refresh(GenServer.server()) :: :ok | {:error, String.t()}
  def force_refresh(client) do
    GenServer.call(client, :force_refresh)
  catch
    :exit, _ -> {:error, "CLIENT_CLOSED"}
  end

  @doc "Return a `Confeature.Snapshot` of the current state."
  @spec snapshot(GenServer.server()) :: Snapshot.t()
  def snapshot(client) do
    GenServer.call(client, :snapshot)
  catch
    :exit, _ -> %Snapshot{}
  end

  @doc "Idempotent shutdown."
  @spec stop(GenServer.server()) :: :ok
  def stop(client) do
    GenServer.stop(client, :normal, 5_000)
  catch
    :exit, _ -> :ok
  end

  @doc """
  Re-enables HTTP polling. Idempotent.

  Mirrors `ConfigCat.set_online/1` (spec 100 / #267 slice 11/14). Closed clients log a
  warning and no-op. LocalOnly clients log a warning and no-op (LocalOnly never polls).
  """
  @spec set_online(GenServer.server()) :: :ok
  def set_online(client) do
    GenServer.call(client, :set_online)
  catch
    :exit, _ -> :ok
  end

  @doc """
  Suspends HTTP polling; serves the cached config. Idempotent.

  Mirrors `ConfigCat.set_offline/1` (spec 100 / #267 slice 11/14). Closed clients log a
  warning + no-op. LocalOnly clients are a silent no-op.
  """
  @spec set_offline(GenServer.server()) :: :ok
  def set_offline(client) do
    GenServer.call(client, :set_offline)
  catch
    :exit, _ -> :ok
  end

  @doc """
  Returns `true` when HTTP polling is suspended.

  Mirrors `ConfigCat.offline?/1` (spec 100 / #267 slice 11/14). Closed clients return
  `true`. LocalOnly clients return `true`.
  """
  @spec offline?(GenServer.server()) :: boolean()
  def offline?(client) do
    GenServer.call(client, :offline?)
  catch
    :exit, _ -> true
  end

  @doc """
  Returns the `Confeature.Hooks` agent for this client. Mirrors
  `ConfigCat.get_hooks/1` (Principle II, epic #268).
  """
  @spec hooks(GenServer.server()) :: pid() | nil
  def hooks(client) do
    GenServer.call(client, :hooks)
  catch
    :exit, _ -> nil
  end

  # ---- GenServer callbacks -----------------------------------------

  # A caller of `GenServer.start_link(Confeature.Client, opts)` skips
  # `start_link/1`'s check: options that are no keyword list are refused
  # here with the same fixed message, before `Keyword` raises a
  # `FunctionClauseError` that would carry them, the key among them, into
  # the start error and the crash report (#803).
  @impl true
  def init(opts) do
    opts = Options.keyword!(opts, "Confeature.Client.init/1")
    Process.flag(:trap_exit, true)

    case opts |> Keyword.get(:sdk_key) |> Sealed.unseal() |> validate_sdk_key() do
      {:ok, sdk_key} -> do_init(Sealed.seal(sdk_key), opts)
      {:error, reason} -> {:stop, {:invalid_sdk_key, reason}}
    end
  end

  # `sdk_key` stays sealed throughout: a stacktrace argument (a
  # `function_clause` in a callee, say) shows the closure, never the key.
  defp do_init(sdk_key, opts) do
    logger = Keyword.get(opts, :logger) || ConfLogger.new()
    flag_overrides = Keyword.get(opts, :flag_overrides)
    default_user = Keyword.get(opts, :default_user)
    polling_mode = Keyword.get(opts, :polling_mode) || PollingMode.auto_poll()
    base_url = Keyword.get(opts, :base_url) || @default_base_url
    request_timeout_seconds = Keyword.get(opts, :request_timeout_seconds, 30.0)
    http_client = Keyword.get(opts, :http_client, HTTPoison)
    cache_directory = Keyword.get(opts, :cache_directory)

    cache_key = sdk_key |> Sealed.unseal() |> SdkKey.derive_cache_key()
    log_invalid_format(logger, sdk_key)

    {cache_module, {:ok, cache_pid}} = start_cache(cache_directory, cache_key, sdk_key, logger)

    fetcher =
      ConfigFetcher.new(
        sdk_key: sdk_key,
        version: Version.version(),
        logger: logger,
        base_url: base_url,
        request_timeout_seconds: request_timeout_seconds,
        http_client: http_client
      )

    {config, etag, fetched_at_ms, fetch_time} = read_initial_cache(cache_module, cache_pid)

    {:ok, hooks_pid} = Confeature.Hooks.start_link(logger: logger)

    state = %State{
      sdk_key: sdk_key,
      cache_key: cache_key,
      logger: logger,
      flag_overrides: flag_overrides,
      default_user: default_user,
      polling_mode: polling_mode,
      fetcher: fetcher,
      cache_pid: cache_pid,
      cache_module: cache_module,
      config: config,
      etag: etag,
      last_fetched_at_ms: fetched_at_ms,
      fetch_time: fetch_time,
      hooks: hooks_pid
    }

    # Hook bus (spec 110 / #268) — cache hit fires client_ready once.
    state =
      if config do
        fire_client_ready_once(state)
      else
        state
      end

    if local_only?(flag_overrides) do
      # LocalOnly: never fetch. Every get_value goes through override-eval.
      {:ok, state}
    else
      {:ok, schedule_initial(state, polling_mode)}
    end
  end

  defp fire_client_ready_once(%State{client_ready_fired: true} = state), do: state

  defp fire_client_ready_once(%State{hooks: hooks} = state) when not is_nil(hooks) do
    Confeature.Hooks.invoke_on_client_ready(hooks)
    %State{state | client_ready_fired: true}
  end

  defp fire_client_ready_once(state), do: state

  @impl true
  def handle_call({:get_value, _key, default, _user}, _from, %State{closed: true} = state) do
    {:reply, default, state}
  end

  def handle_call({:get_value, key, default, user}, _from, %State{} = state) do
    # Spec 135 / #438 (US3): route through evaluate_override/4 so a
    # full-config override source (ConfigOverrideDataSource) resolves
    # targeting rules / segments / % options through the real evaluator
    # with the user threaded; every other source keeps the byte-identical
    # flat-map path.
    effective_user = user || state.default_user

    case OverrideEval.evaluate_override(state.flag_overrides, key, default, effective_user) do
      {true, value} ->
        {:reply, value, state}

      {false, _} ->
        state = maybe_lazy_fetch(state)
        result = Evaluator.evaluate(state.config, key, default, effective_user)
        {:reply, result.value, state}
    end
  end

  def handle_call({:get_value_details, key, default, user}, _from, %State{closed: true} = state) do
    effective_user = user || state.default_user
    details = EvaluationDetails.make_error(key, default, "CLIENT_CLOSED", effective_user)
    Confeature.Hooks.invoke_on_flag_evaluated(state.hooks, details)
    {:reply, details, state}
  end

  def handle_call({:get_value_details, key, default, user}, _from, %State{} = state) do
    state = maybe_lazy_fetch(state)
    snapshot = snapshot_of(state)
    details = Snapshot.get_value_details(snapshot, key, default, user)
    Confeature.Hooks.invoke_on_flag_evaluated(state.hooks, details)
    {:reply, details, state}
  end

  def handle_call({:get_all_values, _user}, _from, %State{closed: true} = state) do
    {:reply, %{}, state}
  end

  def handle_call({:get_all_values, _user}, _from, %State{} = state) do
    state = maybe_lazy_fetch(state)
    snapshot = snapshot_of(state)

    values =
      snapshot
      |> Snapshot.get_all_keys()
      |> Enum.reduce(%{}, fn key, acc ->
        case Snapshot.get_native_value(snapshot, key) do
          nil -> acc
          value -> Map.put(acc, key, value)
        end
      end)

    {:reply, values, state}
  end

  def handle_call(:force_refresh, _from, %State{closed: true} = state) do
    {:reply, {:error, "CLIENT_CLOSED"}, state}
  end

  def handle_call(:force_refresh, _from, %State{} = state) do
    cond do
      local_only?(state.flag_overrides) ->
        {:reply, :ok, state}

      state.offline ->
        # Spec 100 / #267 — no HTTP while offline. Mirrors upstream OFFLINE_MODE.
        {:reply, {:error, "OFFLINE_MODE"}, state}

      true ->
        {reply, state} = fetch_and_apply(state)
        {:reply, reply, state}
    end
  end

  # Spec 100 / #267 slice 11/14 — online/offline triplet handlers.
  def handle_call(:set_online, _from, %State{closed: true} = state) do
    ConfLogger.warning(
      state.logger,
      "Client.set_online: called after stop (sdkKey=#{SdkKey.redact(state.sdk_key)})"
    )

    {:reply, :ok, state}
  end

  def handle_call(:set_online, _from, %State{} = state) do
    if local_only?(state.flag_overrides) do
      ConfLogger.warning(
        state.logger,
        "Client is configured to use the LOCAL_ONLY override behaviour, thus set_online has no" <>
          " effect (sdkKey=#{SdkKey.redact(state.sdk_key)})"
      )

      {:reply, :ok, state}
    else
      {:reply, :ok, %{state | offline: false}}
    end
  end

  def handle_call(:set_offline, _from, %State{closed: true} = state) do
    ConfLogger.warning(
      state.logger,
      "Client.set_offline: called after stop (sdkKey=#{SdkKey.redact(state.sdk_key)})"
    )

    {:reply, :ok, state}
  end

  def handle_call(:set_offline, _from, %State{} = state) do
    if local_only?(state.flag_overrides) do
      {:reply, :ok, state}
    else
      {:reply, :ok, %{state | offline: true}}
    end
  end

  def handle_call(:offline?, _from, %State{closed: true} = state) do
    {:reply, true, state}
  end

  def handle_call(:offline?, _from, %State{} = state) do
    if local_only?(state.flag_overrides) do
      {:reply, true, state}
    else
      {:reply, state.offline, state}
    end
  end

  def handle_call(:snapshot, _from, %State{} = state) do
    {:reply, snapshot_of(state), state}
  end

  def handle_call(:hooks, _from, %State{} = state) do
    {:reply, state.hooks, state}
  end

  @impl true
  def handle_info(:poll, %State{closed: true} = state), do: {:noreply, state}

  def handle_info(:poll, %State{polling_mode: %AutoPoll{} = mode} = state) do
    state =
      if state.offline do
        # Spec 100 / #267 — skip HTTP while offline; keep the poll cadence so resume is fast.
        state
      else
        {_reply, state} = fetch_and_apply(state)
        state
      end

    {:noreply, schedule_next_poll(state, mode)}
  end

  def handle_info(:initial_poll, %State{closed: true} = state), do: {:noreply, state}

  def handle_info(:initial_poll, %State{polling_mode: %AutoPoll{} = mode} = state) do
    state =
      if state.offline do
        state
      else
        {_reply, state} = fetch_and_apply(state)
        state
      end

    {:noreply, schedule_next_poll(state, mode)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @doc false
  # #803: a status (`:sys.get_status/1`) or a crash report renders the
  # state with the key's redacted form in place of the sealed key and
  # URL, and every other part — last message, reason, debug log, queue —
  # with any copy of the key, its request path or URL redacted (an
  # exception message may quote one).
  #
  # OTP 25+ calls this callback whenever it is exported. Elixir declares
  # it from 1.17 only, so `@impl` is set from 1.17: on 1.15 / 1.16 it would
  # be an "@impl for no callback" warning.
  if Elixir.Version.match?(System.version(), ">= 1.17.0"), do: @impl(true)

  def format_status(%{state: %State{} = state} = status) do
    secrets = state_secrets(state)

    Map.new(status, fn
      {:state, state} -> {:state, redact_status_state(state)}
      {field, value} -> {field, SdkKey.scrub(value, secrets)}
    end)
  end

  def format_status(status), do: status

  @doc false
  # #803, the legacy callback. `mix.exs` allows Elixir 1.15, whose OTP 24
  # never calls `format_status/1`: OTP 24's `:sys.get_status/1` and its
  # gen_server crash report call this one, which sees the state only, so
  # it redacts the state. OTP 25+ ignores it while `format_status/1` is
  # exported. (The floor stays at 1.15 for the drop-in: the `configcat`
  # package allows Elixir `~> 1.12`.) On OTP 24 the crash report's reason
  # and last message are printed unformatted; the sealed key keeps them
  # key-free.
  @impl true
  def format_status(:terminate, [_pdict, state]), do: redact_status_state(state)
  def format_status(_reason, [_pdict, state]), do: [data: [{~c"State", redact_status_state(state)}]]

  defp redact_status_state(%State{} = state),
    do: state |> redact_state() |> SdkKey.scrub(state_secrets(state))

  defp redact_status_state(state), do: state

  defp state_secrets(%State{sdk_key: sdk_key, fetcher: fetcher}) do
    fetcher_secrets =
      case fetcher do
        %ConfigFetcher{} -> ConfigFetcher.secrets(fetcher)
        _ -> []
      end

    case Sealed.unseal(sdk_key) do
      key when is_binary(key) -> Enum.uniq([key | fetcher_secrets])
      _ -> fetcher_secrets
    end
  end

  defp redact_state(%State{} = state) do
    fetcher =
      case state.fetcher do
        %ConfigFetcher{} = fetcher ->
          %{fetcher | sdk_key: SdkKey.redact(fetcher.sdk_key), url: redact_url(fetcher)}

        other ->
          other
      end

    %{state | sdk_key: SdkKey.redact(state.sdk_key), fetcher: fetcher}
  end

  defp redact_url(%ConfigFetcher{url: nil}), do: nil
  defp redact_url(%ConfigFetcher{}), do: "<redacted: carries the sdk key>"

  @impl true
  def terminate(_reason, %State{} = state) do
    cancel_timer(state.poll_timer)
    %{state | closed: true}
    :ok
  end

  # ---- Internals ---------------------------------------------------

  defp validate_sdk_key(sdk_key) when is_binary(sdk_key) and byte_size(sdk_key) > 0,
    do: {:ok, sdk_key}

  # A fixed reason: the rejected value may be the key in another type
  # (a charlist, say) and `inspect/1` would quote it.
  defp validate_sdk_key(_sdk_key), do: {:error, "sdk_key must be a non-empty String"}

  defp local_only?(%FlagOverrides{behaviour: :local_only}), do: true
  defp local_only?(_), do: false

  defp log_invalid_format(logger, sdk_key) do
    unless SdkKey.valid_confeature_key_format?(Sealed.unseal(sdk_key)) do
      ConfLogger.warning(
        logger,
        "INVALID_SDK_KEY format for sdkKey=#{SdkKey.redact(sdk_key)}. " <>
          "Continuing — the SDK is lenient about key format at runtime."
      )
    end
  end

  defp start_cache(:memory, _cache_key, _sdk_key, _logger),
    do: {InMemoryCache, InMemoryCache.start_link([])}

  defp start_cache(nil, _cache_key, _sdk_key, _logger),
    do: {InMemoryCache, InMemoryCache.start_link([])}

  defp start_cache(dir, cache_key, sdk_key, logger) when is_binary(dir) do
    {FilesystemCache,
     FilesystemCache.start_link(
       cache_dir: dir,
       cache_key: cache_key,
       sdk_key: sdk_key,
       logger: logger
     )}
  end

  # Without this clause a bad `:cache_directory` is a FunctionClauseError,
  # whose report lists every argument — the raw SDK key included.
  defp start_cache(_dir, _cache_key, _sdk_key, _logger),
    do: raise(ArgumentError, "cache_directory must be a path String, :memory or nil")

  defp read_initial_cache(cache_module, cache_pid) do
    case cache_module.read(cache_pid) do
      nil ->
        {nil, nil, 0, nil}

      %{body: body, etag: etag} = entry ->
        fetched_at_seconds = Map.get(entry, :fetched_at, 0.0)
        fetched_at_ms = trunc(fetched_at_seconds * 1000)
        fetch_time = epoch_seconds_to_datetime(fetched_at_seconds)
        {body, etag, fetched_at_ms, fetch_time}

      _ ->
        {nil, nil, 0, nil}
    end
  end

  defp epoch_seconds_to_datetime(seconds) when is_number(seconds) and seconds > 0 do
    case DateTime.from_unix(trunc(seconds * 1000), :millisecond) do
      {:ok, dt} -> dt
      _ -> nil
    end
  end

  defp epoch_seconds_to_datetime(_), do: nil

  defp schedule_initial(%State{} = state, %AutoPoll{} = mode) do
    # Eager first fetch via send_after(self(), :initial_poll, 0) so init/1
    # returns immediately and the GenServer is responsive for tests.
    timer = Process.send_after(self(), :initial_poll, 0)
    %{state | poll_timer: timer, polling_mode: mode}
  end

  defp schedule_initial(%State{} = state, _mode), do: state

  defp schedule_next_poll(%State{closed: true} = state, _mode), do: state

  defp schedule_next_poll(%State{} = state, %AutoPoll{poll_interval_seconds: secs}) do
    timer = Process.send_after(self(), :poll, secs * 1000)
    %{state | poll_timer: timer}
  end

  defp cancel_timer(nil), do: :ok

  defp cancel_timer(timer) when is_reference(timer) do
    Process.cancel_timer(timer)
    :ok
  end

  defp maybe_lazy_fetch(%State{polling_mode: %LazyLoad{} = mode} = state) do
    now_ms = System.monotonic_time(:millisecond)
    stale_threshold_ms = mode.cache_refresh_interval_seconds * 1000

    if now_ms - state.last_fetched_at_ms >= stale_threshold_ms do
      {_reply, state} = fetch_and_apply(state)
      state
    else
      state
    end
  end

  defp maybe_lazy_fetch(state), do: state

  defp fetch_and_apply(%State{} = state) do
    case ConfigFetcher.fetch(state.fetcher, state.etag) do
      %ConfigFetcher.Result{status: :fetched, body: body, etag: etag} when is_map(body) ->
        now_seconds = :erlang.system_time(:millisecond) / 1000.0

        state.cache_module.write(state.cache_pid, %{
          body: body,
          etag: etag,
          fetched_at: now_seconds
        })

        state = %{
          state
          | config: body,
            etag: etag,
            last_fetched_at_ms: System.monotonic_time(:millisecond),
            fetch_time: DateTime.utc_now()
        }

        # Hook bus (spec 110 / #268) — fire config_changed + client_ready.
        if state.hooks, do: Confeature.Hooks.invoke_on_config_changed(state.hooks, body)
        state = fire_client_ready_once(state)

        {:ok, state}

      %ConfigFetcher.Result{status: :not_modified, etag: etag} ->
        state = %{
          state
          | etag: etag || state.etag,
            last_fetched_at_ms: System.monotonic_time(:millisecond),
            fetch_time: DateTime.utc_now()
        }

        state = fire_client_ready_once(state)
        {:ok, state}

      %ConfigFetcher.Result{status: :failed, error: reason} ->
        # Hook bus (spec 110 / #268) — fire error on fetch failure.
        if state.hooks,
          do: Confeature.Hooks.invoke_on_error(state.hooks, reason || "Config fetch failed.")

        {{:error, reason || "FETCH_FAILED"}, state}
    end
  end

  defp snapshot_of(%State{} = state) do
    %Snapshot{
      config: state.config,
      flag_overrides: state.flag_overrides,
      default_user: state.default_user,
      fetch_time: state.fetch_time
    }
  end
end
