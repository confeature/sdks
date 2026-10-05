# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.ConfigFetcherTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.ConfigFetcher
  alias Confeature.Internal.SdkKey
  alias Confeature.Logger, as: ConfLogger
  alias Confeature.TestHelpers

  defmodule FakeHttp do
    @moduledoc false

    def get(url, headers, _opts) do
      send(self_pid(), {:fake_http_call, url, headers})

      # A library failure that quotes the URL — i.e. the SDK key.
      case Process.get(:fake_http_response, default_response()) do
        :raise_quoting_url -> raise RuntimeError, "boom while fetching #{url}"
        :exit_quoting_url -> exit({:boom, url})
        :throw_quoting_url -> throw({:boom, url})
        response -> response
      end
    end

    defp default_response do
      {:ok, %{status_code: 200, headers: [{"etag", "v1"}], body: ~s({"f":{}})}}
    end

    defp self_pid, do: Process.get(:fake_http_owner, self())
  end

  setup do
    Process.put(:fake_http_owner, self())
    :ok
  end

  defp build_fetcher(opts \\ []) do
    ConfigFetcher.new(
      Keyword.merge(
        [
          sdk_key: "confeature-sdk-1-test-test-test-test-test-test-test-test-test-test-",
          version: "0.1.0",
          logger: ConfLogger.silent(),
          base_url: "https://example.invalid",
          http_client: FakeHttp
        ],
        opts
      )
    )
  end

  # The parsed path of a URL — the query is excluded, so #807's version
  # carrier cannot break these pins.
  defp path_of(url), do: URI.parse(url).path

  @shapes TestHelpers.sdk_key_shapes()
  @configcat_key @shapes["valid"]
                 |> Enum.map(& &1["key"])
                 |> Enum.find(&String.starts_with?(&1, "configcat-sdk-1/"))
  @legacy_key @shapes["valid"]
              |> Enum.map(& &1["key"])
              |> Enum.find(&String.starts_with?(&1, "confeature-sdk-1-"))

  describe "ConfigFetcher.new/1 — the request path (#803)" do
    test "a legacy key travels raw, one segment, no /v2/ and no hash" do
      fetcher = build_fetcher(sdk_key: @legacy_key)

      assert path_of(ConfigFetcher.request_url(fetcher)) ==
               "/configuration-files/#{@legacy_key}/config_v6.json"

      assert String.starts_with?(
               ConfigFetcher.request_url(fetcher),
               "https://example.invalid/configuration-files/"
             )
    end

    test "a configcat-shaped key travels raw, three segments, as the configcat package sends it" do
      fetcher = build_fetcher(sdk_key: @configcat_key)
      "confeature:cache:v1:" <> tail = SdkKey.derive_cache_key(@configcat_key)

      assert path_of(ConfigFetcher.request_url(fetcher)) ==
               "/configuration-files/#{@configcat_key}/config_v6.json"

      refute String.contains?(ConfigFetcher.request_url(fetcher), "%2F")
      refute String.contains?(ConfigFetcher.request_url(fetcher), "/v2/")
      refute String.contains?(ConfigFetcher.request_url(fetcher), tail)
    end

    # FR-001: a malformed key is escaped into ONE segment exactly as Go's
    # `url.PathEscape`. Every expected value is a LITERAL copied from
    # `go run` output (go1.x, `fmt.Println(url.PathEscape(k))`) — never
    # built with the escaper under test.
    @go_path_escape [
      {"bad key$&+:=@,;!'()*~/x?y#z%..", "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25.."},
      # The pass-2 corpus key: 2-, 3- and 4-byte UTF-8, escaped per byte.
      {"bad key$&+:=@,;!'()*~/x?y#z%é€😀..",
       "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80.."},
      {"bad key/with?odd#chars", "bad%20key%2Fwith%3Fodd%23chars"},
      {"clé-ü", "cl%C3%A9-%C3%BC"},
      {~S(a"<>[]\^`{|}b), "a%22%3C%3E%5B%5D%5C%5E%60%7B%7C%7Db"},
      {<<0, 0x7F, 0xFF>>, "%00%7F%FF"}
    ]

    for {key, escaped} <- @go_path_escape do
      @key key
      @escaped escaped
      test "malformed key #{inspect(key)} is Go url.PathEscape'd into ONE segment" do
        fetcher = build_fetcher(sdk_key: @key)

        assert ConfigFetcher.request_url(fetcher) ==
                 "https://example.invalid/configuration-files/#{@escaped}/config_v6.json"

        assert path_of(ConfigFetcher.request_url(fetcher)) ==
                 "/configuration-files/#{@escaped}/config_v6.json"

        ["", "configuration-files", _segment, "config_v6.json"] =
          String.split(path_of(ConfigFetcher.request_url(fetcher)), "/")
      end
    end

    # hackney re-encodes the path by default (`$` -> %24, `&` -> %26); the
    # fetcher hands it `wire_path/1`, which leaves a legal path untouched.
    test "wire_path/1 sends config_url's path byte for byte" do
      path =
        "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25../config_v6.json"

      assert ConfigFetcher.wire_path(path) == path
      assert ConfigFetcher.wire_path("/base path/%zz/%2f") == "/base%20path/%25zz/%2f"
      assert ConfigFetcher.wire_path(nil) == ""
    end

    test "a trailing slash on the base URL is not doubled" do
      fetcher = build_fetcher(sdk_key: @legacy_key, base_url: "https://example.invalid/")

      assert path_of(ConfigFetcher.request_url(fetcher)) ==
               "/configuration-files/#{@legacy_key}/config_v6.json"
    end

    for key <- ["", ".", ".."] do
      @key key
      test "key #{inspect(key)} is refused: no request, INVALID_SDK_KEY" do
        {:ok, io} = StringIO.open("")
        fetcher = build_fetcher(sdk_key: @key, logger: ConfLogger.new(level: :debug, io_device: io))

        assert ConfigFetcher.request_url(fetcher) == nil
        assert ConfigFetcher.config_url("https://example.invalid", @key) == :error

        result = ConfigFetcher.fetch(fetcher, nil)
        assert result.status == :failed
        assert result.error == "INVALID_SDK_KEY"
        refute_received {:fake_http_call, _, _}

        {_, log} = StringIO.contents(io)
        assert log =~ "INVALID_SDK_KEY"
      end
    end
  end

  describe "ConfigFetcher.new/1" do
    test "inspect/1 renders neither the key nor the URL that carries it" do
      fetcher = build_fetcher(sdk_key: @configcat_key)
      [_prefix | secret_parts] = String.split(@configcat_key, "/")

      for needle <- [@configcat_key | secret_parts] do
        refute String.contains?(inspect(fetcher), needle)
        refute String.contains?(inspect(%{state: [fetcher]}), needle)
      end
    end

    test "a missing option raises a fixed message, not one quoting the options" do
      error =
        assert_raise ArgumentError, fn ->
          ConfigFetcher.new(sdk_key: @configcat_key, logger: ConfLogger.silent())
        end

      assert Exception.message(error) == "ConfigFetcher.new/1: option :version is required"
    end

    test "a key that is not a String (the key as a charlist) ends as INVALID_SDK_KEY, key-free" do
      {:ok, io} = StringIO.open("")
      [_prefix | secret_parts] = String.split(@configcat_key, "/")

      fetcher =
        build_fetcher(
          sdk_key: String.to_charlist(@configcat_key),
          logger: ConfLogger.new(level: :debug, io_device: io)
        )

      result = ConfigFetcher.fetch(fetcher, nil)
      {_, log} = StringIO.contents(io)

      assert result.error == "INVALID_SDK_KEY"
      refute_received {:fake_http_call, _, _}

      for needle <- [@configcat_key | secret_parts] do
        refute String.contains?(log, needle)
        refute String.contains?(inspect(fetcher), needle)
      end
    end

    test "User-Agent is confeature-elixir-sdk/{version}" do
      fetcher = build_fetcher(version: "9.9.9")
      assert fetcher.user_agent == "confeature-elixir-sdk/9.9.9"
    end

    test "rejects non-positive timeout" do
      assert_raise ArgumentError, fn ->
        build_fetcher(request_timeout_seconds: 0)
      end
    end
  end

  describe "fetch/2" do
    test "parses HTTP 200 into a :fetched result" do
      fetcher = build_fetcher()

      Process.put(
        :fake_http_response,
        {:ok, %{status_code: 200, headers: [{"etag", "abc"}], body: ~s({"f":{"k":1}})}}
      )

      result = ConfigFetcher.fetch(fetcher, nil)
      assert result.status == :fetched
      assert result.body == %{"f" => %{"k" => 1}}
      assert result.etag == "abc"
    end

    test "parses HTTP 304 into a :not_modified result" do
      fetcher = build_fetcher()

      Process.put(
        :fake_http_response,
        {:ok, %{status_code: 304, headers: [{"etag", "old"}], body: ""}}
      )

      result = ConfigFetcher.fetch(fetcher, "old")
      assert result.status == :not_modified
      assert result.etag == "old"
    end

    test "non-2xx maps to :failed with HTTP {code}" do
      fetcher = build_fetcher()

      Process.put(
        :fake_http_response,
        {:ok, %{status_code: 503, headers: [], body: ""}}
      )

      result = ConfigFetcher.fetch(fetcher, nil)
      assert result.status == :failed
      assert result.error == "HTTP 503"
    end

    test "transport error maps to :failed TRANSPORT" do
      fetcher = build_fetcher()
      Process.put(:fake_http_response, {:error, %{reason: :nxdomain}})

      result = ConfigFetcher.fetch(fetcher, nil)
      assert result.status == :failed
      assert result.error == "TRANSPORT"
    end

    test "timeout reason maps to :failed TRANSPORT_TIMEOUT (distinct from generic transport)" do
      for reason <- [:timeout, :connect_timeout, :recv_timeout, :checkout_timeout] do
        fetcher = build_fetcher()
        Process.put(:fake_http_response, {:error, %{reason: reason}})

        result = ConfigFetcher.fetch(fetcher, nil)
        assert result.status == :failed
        assert result.error == "TRANSPORT_TIMEOUT", "reason #{inspect(reason)} should be a timeout"
      end
    end

    test "sends If-None-Match when an etag is supplied" do
      fetcher = build_fetcher()
      _ = ConfigFetcher.fetch(fetcher, "prev-etag")
      assert_received {:fake_http_call, _, headers}
      assert Enum.any?(headers, fn {k, v} -> k == "If-None-Match" and v == "prev-etag" end)
    end
  end

  # FR-002 / FR-004 (#803): the URL now carries the key, so a forced
  # failure must surface only a fixed code — in no log line and not in
  # `Result.error` may the key, or any 22-character part of it, appear.
  describe "forced failures are key-free (#803)" do
    defp capture_fetch(base_url, timeout_s) do
      {:ok, io} = StringIO.open("")

      fetcher =
        ConfigFetcher.new(
          sdk_key: @configcat_key,
          version: "0.1.0",
          logger: ConfLogger.new(level: :debug, io_device: io),
          base_url: base_url,
          request_timeout_seconds: timeout_s
        )

      result = ConfigFetcher.fetch(fetcher, nil)
      {_, log} = StringIO.contents(io)
      {result, log}
    end

    defp assert_key_free({result, log}) do
      [_prefix | secret_parts] = String.split(@configcat_key, "/")
      assert result.status == :failed
      assert log =~ "fetch failed"

      for needle <- [@configcat_key | secret_parts] do
        refute String.contains?(log, needle), "log leaked #{SdkKey.redact(needle)}"
        refute String.contains?(result.error, needle)
      end

      result
    end

    # Accepts one connection, reads the request, then runs `respond`.
    defp raw_server(respond) do
      {:ok, listen} = :gen_tcp.listen(0, [:binary, packet: :raw, active: false])
      {:ok, port} = :inet.port(listen)

      spawn_link(fn ->
        {:ok, socket} = :gen_tcp.accept(listen)
        _ = :gen_tcp.recv(socket, 0, 2_000)
        respond.(socket)
        :gen_tcp.close(socket)
        :gen_tcp.close(listen)
      end)

      "http://localhost:#{port}"
    end

    test "a timeout" do
      base = raw_server(fn _socket -> Process.sleep(2_000) end)
      result = assert_key_free(capture_fetch(base, 0.1))
      assert result.error == "TRANSPORT_TIMEOUT"
    end

    test "a connection reset mid-body" do
      base =
        raw_server(fn socket ->
          :gen_tcp.send(socket, "HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n{\"f\":{")
        end)

      result = assert_key_free(capture_fetch(base, 1.0))
      assert result.error == "TRANSPORT"
    end

    test "a redirect loop" do
      bypass = Bypass.open()
      base = "http://localhost:#{bypass.port}"

      Bypass.stub(bypass, "GET", "/configuration-files/#{@configcat_key}/config_v6.json", fn conn ->
        conn
        |> Plug.Conn.put_resp_header("location", base <> conn.request_path)
        |> Plug.Conn.resp(302, "")
      end)

      result = assert_key_free(capture_fetch(base, 1.0))
      assert result.error == "HTTP 302"
    end

    # A bad base URL: HTTPoison answers `http://[::1` with an error whose
    # `reason` quotes the full URL; the others raise inside the HTTP stack.
    # Each ends as a fixed code.
    for base <- ["http://[::1", "http://x:abc", "http://exa mple.invalid", "not a url"] do
      @base base
      test "a bad base URL #{inspect(base)}" do
        result = assert_key_free(capture_fetch(@base, 1.0))
        assert result.error in ["EXCEPTION", "TRANSPORT", "TRANSPORT_TIMEOUT"]
      end
    end

    # The result is one fixed code; the log line tells the kinds apart
    # (the exception's module, `exit`, `throw`), never the value.
    for {failure, kind} <- [
          raise_quoting_url: "kind=error:RuntimeError",
          exit_quoting_url: "kind=exit",
          throw_quoting_url: "kind=throw"
        ] do
      @failure failure
      @kind kind
      test "an HTTP client #{failure}" do
        {:ok, io} = StringIO.open("")
        Process.put(:fake_http_response, @failure)

        fetcher =
          build_fetcher(
            sdk_key: @configcat_key,
            logger: ConfLogger.new(level: :debug, io_device: io)
          )

        result = ConfigFetcher.fetch(fetcher, nil)
        {_, log} = StringIO.contents(io)
        result = assert_key_free({result, log})
        assert result.error == "EXCEPTION"
        assert log =~ "reason=EXCEPTION #{@kind}\n"
      end
    end

    test "an unrecognised client return value (e.g. a redirect struct quoting the URL)" do
      {:ok, io} = StringIO.open("")
      Process.put(:fake_http_response, {:ok, %{request_url: "https://x/#{@configcat_key}"}})

      fetcher =
        build_fetcher(sdk_key: @configcat_key, logger: ConfLogger.new(level: :debug, io_device: io))

      result = ConfigFetcher.fetch(fetcher, nil)
      {_, log} = StringIO.contents(io)
      result = assert_key_free({result, log})
      assert result.error == "TRANSPORT"
    end
  end
end
