# SPDX-License-Identifier: MIT

defmodule Confeature.ClientTest do
  use ExUnit.Case, async: false

  import Mock

  alias Confeature.{Client, FlagOverrides, Logger, MapOverrideDataSource, PollingMode, Snapshot}
  alias Confeature.Internal.{ConfigFetcher, FilesystemCache, SdkKey}
  alias Confeature.{LogCapture, TestHelpers}

  defmodule NeverHttp do
    @moduledoc false
    def get(_url, _headers, _opts), do: {:error, %{reason: :nxdomain}}
  end

  defp start_local_only_client(map) do
    Client.start_link(
      sdk_key: TestHelpers.sample_sdk_key(),
      polling_mode: PollingMode.manual_poll(),
      flag_overrides:
        FlagOverrides.new(
          data_source: MapOverrideDataSource.new(map),
          behaviour: :local_only
        ),
      cache_directory: :memory,
      logger: Logger.silent(),
      http_client: NeverHttp
    )
  end

  describe "start_link/1" do
    test "returns {:ok, pid} for a valid sdk_key" do
      {:ok, pid} = start_local_only_client(%{})
      assert is_pid(pid)
      assert Process.alive?(pid)
      Client.stop(pid)
    end

    test "returns {:error, {:invalid_sdk_key, _}} on empty sdk_key" do
      Process.flag(:trap_exit, true)

      assert {:error, {:invalid_sdk_key, _}} =
               Client.start_link(
                 sdk_key: "",
                 polling_mode: PollingMode.manual_poll(),
                 logger: Logger.silent(),
                 http_client: NeverHttp
               )
    end

    test "returns {:error, {:invalid_sdk_key, _}} when sdk_key is not a binary" do
      Process.flag(:trap_exit, true)

      assert {:error, {:invalid_sdk_key, _}} =
               Client.start_link(
                 sdk_key: :not_a_string,
                 polling_mode: PollingMode.manual_poll(),
                 logger: Logger.silent(),
                 http_client: NeverHttp
               )
    end
  end

  # #803 — the SDK key must not reach a log line, a crash report or a
  # status, whatever formatter renders it. `LogCapture` receives the RAW
  # events (SASL crash and supervisor reports included, which Elixir's
  # default handler drops) and renders each through Erlang's
  # `logger_formatter` and as a struct-free `inspect/1`, so every refute
  # below can fail.
  describe "the SDK key in reports (#803)" do
    @key "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"
    @needles [@key, "FAKEfixtureKeyNotRea01", "FAKEfixtureKeyNotRea02"]
    # `SdkKey.redact/1` of @key: "***" and the last four characters.
    @redacted "***ea02"

    defp client_opts(overrides) do
      Keyword.merge(
        [
          sdk_key: @key,
          polling_mode: PollingMode.manual_poll(),
          cache_directory: :memory,
          logger: Logger.silent(),
          http_client: NeverHttp
        ],
        overrides
      )
    end

    defp tmp_cache_dir do
      dir = Path.join(System.tmp_dir!(), "confeature-803-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf!(dir) end)
      dir
    end

    defp erlang_p(term), do: term |> then(&:io_lib.format(~c"~tp", [&1])) |> IO.chardata_to_string()

    defp raw(term), do: inspect(term, structs: false, limit: :infinity, printable_limit: :infinity)

    defp assert_key_free(text, what) do
      for needle <- @needles do
        refute String.contains?(text, needle), "#{what} quotes the SDK key (or a part of it)"
      end
    end

    defp assert_reports_key_free(events, labels) do
      captured = Enum.map(events, &LogCapture.label/1)

      for label <- labels do
        assert label in captured, "no #{inspect(label)} report captured; got #{inspect(captured)}"
      end

      for event <- events do
        rendered = LogCapture.render(event)
        assert rendered =~ "Confeature", "#{inspect(LogCapture.label(event))} rendered empty"
        assert_key_free(rendered, "the #{inspect(LogCapture.label(event))} report")
      end
    end

    test "a non-String key (the key as a charlist) is rejected with a fixed reason" do
      Process.flag(:trap_exit, true)

      {result, events} =
        LogCapture.capture(
          fn -> Client.start_link(client_opts(sdk_key: String.to_charlist(@key))) end,
          [{:proc_lib, :crash}]
        )

      # The crash report must have been captured (`assert_reports_key_free/2`
      # fails on a missing label) before its key-free check means anything.
      assert_reports_key_free(events, [{:proc_lib, :crash}])
      assert_key_free(raw(result), "the start error")
      assert {:error, {:invalid_sdk_key, "sdk_key must be a non-empty String"}} = result
    end

    test "a bad option after the key: a fixed-message start error, key-free crash report" do
      Process.flag(:trap_exit, true)

      {result, events} =
        LogCapture.capture(
          fn -> Client.start_link(client_opts(cache_directory: 123)) end,
          [{:proc_lib, :crash}]
        )

      assert_reports_key_free(events, [{:proc_lib, :crash}])
      assert_key_free(raw(result), "the start error")

      # The fixed message, not a FunctionClauseError listing start_cache/4's
      # arguments (the key among them).
      assert {:error,
              {%ArgumentError{message: "cache_directory must be a path String, :memory or nil"},
               _stacktrace}} = result
    end

    # The fixed-message clause above leaves no stack frame with arguments,
    # so that test passes whether or not the client seals the key. Here a
    # callee fails on its arguments (a FunctionClauseError, the kind a bad
    # option raises), the client's options among them: only the sealed key
    # keeps the start error and the crash report key-free.
    test "a callee that fails on its arguments during start: the key in them is sealed" do
      Process.flag(:trap_exit, true)

      {result, events} =
        with_mock FilesystemCache, [:passthrough], start_link: fn opts -> String.upcase(opts) end do
          LogCapture.capture(
            fn -> Client.start_link(client_opts(cache_directory: tmp_cache_dir())) end,
            [{:proc_lib, :crash}]
          )
        end

      assert {:error, {:function_clause, [{String, :upcase, [opts, _], _} | _]}} = result
      # The arguments did reach the stacktrace, with the key's option in them.
      assert Keyword.has_key?(opts, :sdk_key)
      assert_key_free(raw(result), "the start error")
      assert_key_free(erlang_p(result), "the start error (~p)")
      assert_reports_key_free(events, [{:proc_lib, :crash}])
    end

    test "options that are no keyword list are rejected with a fixed message, key-free" do
      Process.flag(:trap_exit, true)

      for opts <- [%{sdk_key: @key}, [{"sdk_key", @key}], [sdk_key: @key] ++ [@key]] do
        what = inspect(SdkKey.scrub(opts, [@key]))

        {result, events} =
          LogCapture.capture(fn ->
            for start <- [
                  fn -> Client.start_link(opts) end,
                  fn -> Supervisor.start_link([{Client, opts}], strategy: :one_for_one) end,
                  fn -> Client.child_spec(opts) end
                ] do
              try do
                start.()
              rescue
                error -> {:raised, error}
              end
            end
          end)

        # Unsealed options would reach the child spec, the supervisor's
        # start_error report and the start result.
        for event <- events do
          assert_key_free(
            LogCapture.render(event),
            "#{what}: the #{inspect(LogCapture.label(event))} report"
          )
        end

        assert_key_free(raw(result), "#{what}: the start result")

        # A raise in the caller, before any process starts.
        assert [
                 {:raised,
                  %ArgumentError{
                    message: "Confeature.Client.start_link/1: options must be a keyword list"
                  }},
                 {:raised,
                  %ArgumentError{
                    message: "Confeature.Client.child_spec/1: options must be a keyword list"
                  }},
                 {:raised,
                  %ArgumentError{
                    message: "Confeature.Client.child_spec/1: options must be a keyword list"
                  }}
               ] = result
      end
    end

    # `GenServer.start_link(Client, opts)` reaches init/1 without
    # start_link/1's check: init/1 refuses the options itself.
    test "init/1 refuses options that are no keyword list with a fixed message, key-free" do
      Process.flag(:trap_exit, true)

      for opts <- [%{sdk_key: @key}, [{"sdk_key", @key}]] do
        what = inspect(SdkKey.scrub(opts, [@key]))

        {result, events} =
          LogCapture.capture(
            fn -> GenServer.start_link(Client, opts) end,
            [{:proc_lib, :crash}]
          )

        assert_key_free(raw(result), "#{what}: the start error")
        assert_key_free(erlang_p(result), "#{what}: the start error (~p)")
        assert_reports_key_free(events, [{:proc_lib, :crash}])

        assert {:error,
                {%ArgumentError{
                   message: "Confeature.Client.init/1: options must be a keyword list"
                 }, _stacktrace}} = result
      end
    end

    # No report shows init/1's argument, but a call tracer (`:dbg`,
    # `recon_trace`) prints it: start_link/1 hands it the key sealed.
    test "start_link/1 hands init/1 the key sealed: a call tracer prints no key" do
      :erlang.trace_pattern({Client, :init, 1}, true, [:local])
      :erlang.trace(self(), true, [:call, :set_on_spawn])

      try do
        {:ok, pid} = Client.start_link(client_opts([]))
        Client.stop(pid)
      after
        :erlang.trace(self(), false, [:call, :set_on_spawn])
        :erlang.trace_pattern({Client, :init, 1}, false, [:local])
      end

      assert_receive {:trace, _pid, :call, {Client, :init, [opts]}}, 1_000
      assert Keyword.has_key?(opts, :sdk_key)
      assert_key_free(raw(opts), "init/1's traced argument")
      assert_key_free(erlang_p(opts), "init/1's traced argument (~p)")
    end

    test "the child spec carries no raw key" do
      spec = Client.child_spec(client_opts([]))

      assert %{id: Client, start: {Client, :start_link, [_opts]}} = spec
      assert_key_free(raw(spec), "the child spec")
      assert_key_free(erlang_p(spec), "the child spec (~p)")
    end

    test "a supervised client that fails to start: the supervisor report is key-free" do
      Process.flag(:trap_exit, true)
      labels = [{:supervisor, :start_error}, {:proc_lib, :crash}]

      {result, events} =
        LogCapture.capture(
          fn ->
            Supervisor.start_link([{Client, client_opts(cache_directory: 123)}],
              strategy: :one_for_one
            )
          end,
          labels
        )

      assert {:error, _reason} = result
      assert_key_free(raw(result), "the supervisor start error")
      assert_reports_key_free(events, labels)
    end

    test "a RUNNING client that crashes: status, crash and supervisor reports are key-free" do
      Process.flag(:trap_exit, true)
      opts = client_opts(cache_directory: tmp_cache_dir())
      labels = [{:gen_server, :terminate}, {:proc_lib, :crash}, {:supervisor, :child_terminated}]

      {{status, cache_status}, events} =
        LogCapture.capture(
          fn ->
            {:ok, sup} = Supervisor.start_link([{Client, opts}], strategy: :one_for_one)
            [{Client, pid, :worker, _}] = Supervisor.which_children(sup)
            state = :sys.get_state(pid)
            assert ConfigFetcher.request_url(state.fetcher) =~ "FAKEfixtureKeyNotRea02"
            assert FilesystemCache.file_path(state.cache_pid) =~ "confeature-"

            statuses = {:sys.get_status(pid), :sys.get_status(state.cache_pid)}
            # No such call: a FunctionClauseError whose stacktrace carries
            # handle_call/3's arguments — the client state among them.
            catch_exit(GenServer.call(pid, :no_such_call))
            statuses
          end,
          labels
        )

      assert_reports_key_free(events, labels)

      for {term, what} <- [{status, "the client status"}, {cache_status, "the cache status"}] do
        assert_key_free(raw(term), what)
        assert_key_free(erlang_p(term), "#{what} (~p)")
      end

      # format_status/1 ran: the status shows the redacted key.
      assert raw(status) =~ @redacted
    end

    test "format_status/1 redacts every form of the key in the state, reason, message and log" do
      # A malformed key: its request path differs from the key itself.
      key = "bad key$&+:=@,;!'()*~/x?y#z%é€😀..FAKEfixtureK"

      path =
        "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80..FAKEfixtureK"

      {:ok, pid} = Client.start_link(client_opts(sdk_key: key))
      state = :sys.get_state(pid)
      Client.stop(pid)
      url = ConfigFetcher.request_url(state.fetcher)
      assert url =~ path

      status =
        Client.format_status(%{
          state: state,
          reason: {%RuntimeError{message: "boom #{url}"}, [{M, :f, [key], []}]},
          message: {:call, String.to_charlist(key)},
          log: [{:in, ["GET /configuration-files/", path, " -> ", key | "tail"]}]
        })

      for {term, what} <- [{raw(status), "status"}, {erlang_p(status), "status (~p)"}],
          needle <- [key, path, url, "FAKEfixtureK"] do
        refute term =~ needle,
               "the formatted #{what} quotes #{Confeature.Internal.SdkKey.redact(needle)}"
      end

      assert raw(status) =~ "***ureK"
    end

    # OTP 24 (under Elixir 1.15 / 1.16) calls only the legacy callback.
    test "format_status/2 (OTP 24) redacts the state of a status and of a crash report" do
      {:ok, pid} = Client.start_link(client_opts([]))
      state = :sys.get_state(pid)
      Client.stop(pid)
      assert ConfigFetcher.request_url(state.fetcher) =~ "FAKEfixtureKeyNotRea02"

      assert [data: [{~c"State", status_state}]] = Client.format_status(:normal, [[], state])
      crash_state = Client.format_status(:terminate, [[], state])

      for {term, what} <- [{status_state, "the status"}, {crash_state, "the crash report"}] do
        assert %Client.State{} = term
        assert term.sdk_key == @redacted, "#{what}: the key is not redacted"
        assert term.fetcher.url == "<redacted: carries the sdk key>"
        assert_key_free(raw(term), what)
        assert_key_free(erlang_p(term), "#{what} (~p)")
      end

      # Any other state is passed through.
      assert Client.format_status(:terminate, [[], :other]) == :other
      assert Client.format_status(:normal, [[], :other]) == [data: [{~c"State", :other}]]
    end
  end

  describe "get_value/4" do
    test "returns override value via LocalOnly contract" do
      {:ok, pid} = start_local_only_client(%{"feature.x" => true})
      assert Client.get_value(pid, "feature.x", false) == true
      Client.stop(pid)
    end

    test "returns default for unknown keys" do
      {:ok, pid} = start_local_only_client(%{"feature.x" => true})
      assert Client.get_value(pid, "feature.missing", "fallback") == "fallback"
      Client.stop(pid)
    end

    test "returns default after stop/1 (no crash)" do
      {:ok, pid} = start_local_only_client(%{"feature.x" => true})
      :ok = Client.stop(pid)
      assert Client.get_value(pid, "feature.x", :sentinel) == :sentinel
    end
  end

  describe "stop/1" do
    test "is idempotent" do
      {:ok, pid} = start_local_only_client(%{})
      assert :ok = Client.stop(pid)
      assert :ok = Client.stop(pid)
    end
  end

  describe "snapshot/1" do
    test "returns a Snapshot with the configured flag overrides" do
      {:ok, pid} = start_local_only_client(%{"feature.x" => true})
      snapshot = Client.snapshot(pid)
      assert %Snapshot{} = snapshot
      assert snapshot.flag_overrides.behaviour == :local_only
      assert Snapshot.get_value(snapshot, "feature.x", false) == true
      Client.stop(pid)
    end
  end

  describe "force_refresh/1" do
    test "returns :ok in LocalOnly mode without fetching" do
      {:ok, pid} = start_local_only_client(%{"feature.x" => true})
      assert Client.force_refresh(pid) == :ok
      Client.stop(pid)
    end
  end
end
