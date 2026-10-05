# SPDX-License-Identifier: MIT

defmodule Confeature.Wire.WireCasesTest do
  @moduledoc """
  Wire-protocol fixture suite (Elixir consumer).

  Drives `Confeature.Internal.ConfigFetcher` against each case in
  `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
  corpus is the language-agnostic contract; this file is the Elixir
  consumer that maps the fetcher's `Result` (status atom +
  stringly-typed `error` reason) onto the corpus's normalised
  `{fetched, notModified, failed}` x
  `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.

  Layer choice: this drives the fetcher directly (NOT the public
  `Confeature.Client`), matching what sdk-node / sdk-browser-js /
  sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-ruby already do —
  the wire-cases corpus by name tests wire behaviour, and the
  fetcher is sdk-elixir's wire layer. Driving the public Client
  would add poll-service indirection that the corpus does not
  assert.

  Mock pattern: a raw `:gen_tcp` loopback listener per case answers the
  HTTPoison request, so the test exercises the *real* HTTP stack on
  plaintext loopback without hitting the network, and records the
  request line's path byte for byte — still percent-encoded as sent,
  never decoded by a server library (#803).

  See epic #146 (contract testing framework) + #148 slice 11 (this
  suite) + spec 112.
  """

  use ExUnit.Case, async: false

  alias Confeature.Internal.ConfigFetcher
  alias Confeature.Logger, as: ConfLogger
  alias Confeature.TestHelpers

  @sdk_key TestHelpers.sample_sdk_key()

  # Module-attribute corpus: read once at compile time so the `for`
  # at the bottom of the module can fan a `describe`/`test` out per
  # case. The fixture is FROZEN — recompilation is the right cache
  # invalidation signal when it ever changes. apps/sdk-elixir/test/
  # wire/wire_cases_test.exs → workspace root is four `..` away.
  @fixtures_dir Path.expand(
                  "../../../../packages/test-fixtures-sdk-parity/fixtures",
                  __DIR__
                )
  @corpus_path Path.join(@fixtures_dir, "wire-cases.json")
  @external_resource @corpus_path
  @corpus_doc @corpus_path |> File.read!() |> Jason.decode!()
  @cases Map.fetch!(@corpus_doc, "cases")

  if @cases == [] do
    raise "wire-cases.json carries no cases — fixture is FROZEN"
  end

  # Every `given` / `expected` field this consumer reads (#803 FR-003).
  # A field outside these lists FAILS the case — a new expectation can
  # never be skipped silently.
  @known_given_fields ~w(previousEtag sdkKey baseUrl)
  @known_expected_fields ~w(outcome errorClass resultingEtag hasConfig
                            requestHeaderIfNoneMatch requestUrlPrefix requestPath)

  defp fixtures_dir, do: @fixtures_dir

  defmodule RebaseHttp do
    @moduledoc false
    # `given.baseUrl` names a host the test cannot reach. This client
    # records the URL the fetcher built, then sends the request to the
    # local mock by swapping only the base (`{from, to}` in the process
    # dictionary) — the path the mock sees is the fetcher's own.
    def get(url, headers, opts) do
      {from, to} = Process.get(:wire_rebase)
      send(Process.get(:wire_owner), {:wire_url, url})
      HTTPoison.get(to <> String.replace_prefix(url, from, ""), headers, opts)
    end
  end

  # Maps the fetcher's stringly-typed `Result.error` onto the corpus's
  # normalised error-class vocabulary. The fetcher produces:
  #
  #   - "MALFORMED_JSON"      -> parseFailed   (JSON.decode failure or wrong shape)
  #   - "INVALID_SDK_KEY"     -> invalidSdkKey (key refused before any request)
  #   - "HTTP 403" / "HTTP 404" -> invalidSdkKey (CDN rejected the key — per
  #                              ConfigCat only 403/404 are invalid-SDK-key
  #                              statuses; 401 is a generic retryable failure)
  #   - "HTTP <other-non-2xx>"-> fetchFailed
  #   - "TRANSPORT_TIMEOUT"   -> timeout       (recv/connect timeout — the
  #                              fetcher classifies the HTTPoison reason
  #                              atom; wire-cases `timeout` case, #490)
  #   - "TRANSPORT" / other   -> fetchFailed   (any other transport drop,
  #                              incl. a connection reset mid-response —
  #                              wire-cases `network-reset` case, #490)
  #
  # Mirrors sdk-python's `_python_error_to_class`, sdk-go's
  # `goErrorToClass`, and sdk-ruby's `ruby_error_to_class`. When the
  # fetcher upgrades to a typed enum, this mapping moves to a `case`
  # on that enum.
  defp elixir_error_to_class(nil), do: "fetchFailed"
  defp elixir_error_to_class("MALFORMED_JSON"), do: "parseFailed"
  defp elixir_error_to_class("INVALID_SDK_KEY"), do: "invalidSdkKey"
  defp elixir_error_to_class("HTTP 403"), do: "invalidSdkKey"
  defp elixir_error_to_class("HTTP 404"), do: "invalidSdkKey"
  defp elixir_error_to_class("HTTP " <> _rest), do: "fetchFailed"
  defp elixir_error_to_class("TRANSPORT_TIMEOUT"), do: "timeout"
  defp elixir_error_to_class("TRANSPORT"), do: "fetchFailed"
  defp elixir_error_to_class(_), do: "fetchFailed"

  defp resolve_body(server) do
    case Map.get(server, "bodyRef") do
      ref when is_binary(ref) -> fixtures_dir() |> Path.join(ref) |> File.read!()
      _ -> Map.get(server, "body")
    end
  end

  # `given.baseUrl` (custom-base-url) is configured on the SDK as is;
  # `RebaseHttp` then delivers the request to the local mock. Without it
  # the SDK is pointed straight at the mock with the real HTTPoison.
  defp build_fetcher(sdk_key, given_base_url, target_url, timeout_seconds) do
    {base_url, extra} =
      case given_base_url do
        nil ->
          {target_url, []}

        custom ->
          Process.put(:wire_owner, self())
          Process.put(:wire_rebase, {String.trim_trailing(custom, "/"), target_url})
          {custom, [http_client: RebaseHttp]}
      end

    ConfigFetcher.new(
      [
        sdk_key: sdk_key,
        version: "0.0.0-wire-test",
        logger: ConfLogger.silent(),
        base_url: base_url,
        request_timeout_seconds: timeout_seconds
      ] ++ extra
    )
  end

  # URL shape: ConfigCat's <baseUrl>/configuration-files/<sdkKey>/config_v6.json
  # (#803). The corpus pins the prefix and the exact PARSED path (query
  # excluded — #807 may add one).
  defp assert_request_url(fetcher, request_path, expected) do
    path = URI.parse(request_path).path

    if prefix = Map.get(expected, "requestUrlPrefix") do
      assert String.starts_with?(ConfigFetcher.request_url(fetcher), prefix),
             "expected URL to start with #{prefix}, got #{ConfigFetcher.request_url(fetcher)}"

      assert_received {:wire_url, sent_url}
      assert String.starts_with?(sent_url, prefix)
    end

    if expected_path = Map.get(expected, "requestPath") do
      assert URI.parse(ConfigFetcher.request_url(fetcher)).path == expected_path
      assert path == expected_path, "expected path #{expected_path}, got #{path}"
    end

    assert String.starts_with?(path, "/configuration-files/"),
           "expected path to start with '/configuration-files/', got #{path}"

    assert String.ends_with?(path, "/config_v6.json"),
           "expected path to end with '/config_v6.json', got #{path}"
  end

  # The mock-transport behaviour adapter (#490). `server.behavior` (a
  # discriminator the corpus grew alongside the `timeout` +
  # `network-reset` cases) selects how the loopback listener responds:
  #
  #   - "respond" (default / absent) — deliver status + headers + body,
  #     the original behaviour every other case relies on. A raw
  #     listener (`raw_respond_server/4`), not Bypass: Bypass compiles
  #     the incoming path into a Plug.Router route, and a path holding
  #     `:` or `*` (the `request-path-malformed-key` case, #803) makes
  #     it raise and answer 500 without ever calling the handler.
  #   - "timeout" — handled out-of-band by a raw `:gen_tcp` listener
  #     (`raw_hang_server/1`), NOT by Bypass: it accepts the connection,
  #     reads the request, then never replies, so HTTPoison aborts the
  #     in-flight request once its (deliberately short) request timeout
  #     fires → `{:error, %{reason: :timeout}}` → "TRANSPORT_TIMEOUT" →
  #     timeout. Bypass treats a client-aborted in-flight handler as a
  #     crash, so it cannot model this cleanly.
  #   - "close-mid-response" — handled out-of-band by a raw `:gen_tcp`
  #     listener (`raw_reset_server/2`), NOT by Bypass: it announces a
  #     larger Content-Length than it sends, then slams the socket shut
  #     mid-body → HTTPoison's body read fails → "TRANSPORT" →
  #     fetchFailed (NOT parseFailed: a truncated body is a transport
  #     error, not a JSON-shape error). Bypass can't drop a connection
  #     mid-stream without flagging the handler crash as a failure.
  #   - anything else — FAIL loudly; never fall through to "respond".
  defp install_behavior("respond", status, headers, body, test_pid),
    do: "http://localhost:#{raw_respond_server(status, headers, body, test_pid)}"

  defp install_behavior("close-mid-response", _status, headers, _body, test_pid),
    do: "http://localhost:#{raw_reset_server(headers, test_pid)}"

  defp install_behavior("timeout", _status, _headers, _body, test_pid),
    do: "http://localhost:#{raw_hang_server(test_pid)}"

  defp install_behavior(other, _status, _headers, _body, _test_pid) do
    flunk("wire-cases: unsupported server.behavior #{inspect(other)} — no adapter")
  end

  # Raw loopback listener for the `respond` behaviour. Accepts one
  # connection, records the raw request line's path (no decoding), then
  # answers `status` + `headers` + `body` and closes. A 304 carries no
  # body. Returns the listening port.
  defp raw_respond_server(status, headers, body, test_pid) do
    {:ok, listen} =
      :gen_tcp.listen(0, [:binary, packet: :raw, active: false, reuseaddr: true])

    {:ok, port} = :inet.port(listen)

    spawn_link(fn ->
      {:ok, socket} = :gen_tcp.accept(listen)
      request = read_request(socket, "")
      {method, path, req_headers} = parse_request(request)
      send(test_pid, {:wire_request, method, path, req_headers})

      body = if status in [204, 304], do: "", else: body
      header_lines = Enum.map_join(headers, "", fn {k, v} -> "#{k}: #{v}\r\n" end)

      :gen_tcp.send(
        socket,
        "HTTP/1.1 #{status} Wire\r\n" <>
          header_lines <>
          "Content-Length: #{byte_size(body)}\r\nConnection: close\r\n\r\n" <> body
      )

      :gen_tcp.close(socket)
      :gen_tcp.close(listen)
    end)

    port
  end

  # Raw loopback listener for the `timeout` behaviour. Accepts one
  # connection, reads (and discards) the request, then never replies —
  # HTTPoison's recv_timeout fires and aborts the request with `:timeout`.
  # Returns the listening port; the listener is closed automatically when
  # the test process exits (spawn_link).
  defp raw_hang_server(test_pid) do
    {:ok, listen} =
      :gen_tcp.listen(0, [:binary, packet: :raw, active: false, reuseaddr: true])

    {:ok, port} = :inet.port(listen)

    spawn_link(fn ->
      {:ok, socket} = :gen_tcp.accept(listen)
      request = read_request(socket, "")
      {method, path, req_headers} = parse_request(request)
      send(test_pid, {:wire_request, method, path, req_headers})
      # Never respond; wait long enough for the client deadline to fire.
      Process.sleep(5_000)
      :gen_tcp.close(socket)
      :gen_tcp.close(listen)
    end)

    port
  end

  # Raw loopback listener for the `close-mid-response` behaviour. Accepts
  # one connection, reads (and discards) the request line + headers, then
  # writes a 200 status line + headers that promise a 4096-byte body but
  # delivers only a truncated prefix before closing the socket. HTTPoison
  # sees fewer body bytes than Content-Length → a transport read failure.
  # Returns {port, capture_pid}; the capture process forwards the request
  # bytes to `test_pid` as a `{:wire_request, method, path, headers}`.
  defp raw_reset_server(headers, test_pid) do
    {:ok, listen} =
      :gen_tcp.listen(0, [:binary, packet: :raw, active: false, reuseaddr: true])

    {:ok, port} = :inet.port(listen)

    spawn_link(fn ->
      {:ok, socket} = :gen_tcp.accept(listen)
      request = read_request(socket, "")
      {method, path, req_headers} = parse_request(request)
      send(test_pid, {:wire_request, method, path, req_headers})

      header_lines =
        Enum.map_join(headers, "", fn {k, v} -> "#{k}: #{v}\r\n" end)

      :gen_tcp.send(
        socket,
        "HTTP/1.1 200 OK\r\n" <>
          header_lines <>
          "Content-Length: 4096\r\n\r\n" <>
          ~s({"p":{"s":"partial)
      )

      :gen_tcp.close(socket)
      :gen_tcp.close(listen)
    end)

    port
  end

  # Read until the end of the HTTP header block (CRLFCRLF). The wire-cases
  # requests are header-only GETs, so the headers terminator is sufficient.
  defp read_request(socket, acc) do
    if String.contains?(acc, "\r\n\r\n") do
      acc
    else
      case :gen_tcp.recv(socket, 0, 2_000) do
        {:ok, chunk} -> read_request(socket, acc <> chunk)
        {:error, _} -> acc
      end
    end
  end

  defp parse_request(request) do
    [request_line | header_lines] =
      request |> String.split("\r\n\r\n", parts: 2) |> hd() |> String.split("\r\n")

    [method, path | _] = String.split(request_line, " ")

    req_headers =
      Enum.flat_map(header_lines, fn line ->
        case String.split(line, ":", parts: 2) do
          [k, v] -> [{String.downcase(String.trim(k)), String.trim(v)}]
          _ -> []
        end
      end)

    {method, path, req_headers}
  end

  # Parameterised describe/test generation — ExUnit's idiomatic shape
  # for a corpus-driven suite. Each case lands as its own `test`
  # block so failures point at the exact corpus id.
  for wire_case <- @cases do
    @wire_case wire_case

    describe "case #{wire_case["id"]}" do
      # ExUnit (Elixir 1.19+) caps the *computed* test name — the
      # "<describe> <test name>" pair — at 255 chars. Several wire-case
      # `description`s are multi-sentence rationales (e.g. http-401) that
      # blow past that and abort module compilation. Use the stable case
      # id as the test name instead; the full description still lives in
      # the corpus JSON and in the failure-assertion messages below. (#520)
      test @wire_case["id"] do
        given = @wire_case["given"]
        server = @wire_case["server"]
        expected = @wire_case["expected"]

        unknown_given = Map.keys(given) -- @known_given_fields
        unknown_expected = Map.keys(expected) -- @known_expected_fields

        assert unknown_given == [],
               "case #{@wire_case["id"]}: unknown given field(s) #{inspect(unknown_given)}"

        assert unknown_expected == [],
               "case #{@wire_case["id"]}: unknown expected field(s) #{inspect(unknown_expected)}"

        # Capture the incoming request so we can assert URL shape +
        # If-None-Match round-trip from the test body.
        test_pid = self()
        body = resolve_body(server) || ""
        status = Map.fetch!(server, "status")
        headers = Map.get(server, "headers", %{})
        behavior = Map.get(server, "behavior") || "respond"

        # Each listener serves one request on any method/path — the
        # corpus exercises a single round-trip per case and the URL shape
        # is asserted in the test body against the RAW request-line path
        # (`expected.requestPath` / `expected.requestUrlPrefix`).
        # `install_behavior/5` branches the mock transport on
        # `server.behavior` (#490).
        target_url = install_behavior(behavior, status, headers, body, test_pid)

        # The timeout case needs a short request deadline so the suite
        # stays fast; every other behaviour keeps the standard 1s budget.
        timeout_seconds = if behavior == "timeout", do: 0.1, else: 1.0
        sdk_key = Map.get(given, "sdkKey") || @sdk_key
        fetcher = build_fetcher(sdk_key, Map.get(given, "baseUrl"), target_url, timeout_seconds)
        result = ConfigFetcher.fetch(fetcher, Map.get(given, "previousEtag"))

        # ---- Request-side assertions ------------------------------------
        assert_received {:wire_request, method, request_path, req_headers}
        assert method == "GET"

        assert_request_url(fetcher, request_path, expected)

        # If-None-Match round-trip. The corpus uses a 3-state
        # encoding: absent key = don't assert, explicit null = header
        # MUST NOT be sent, explicit string = header MUST equal.
        if Map.has_key?(expected, "requestHeaderIfNoneMatch") do
          inm_expected = Map.get(expected, "requestHeaderIfNoneMatch")

          inm_actual =
            Enum.find_value(req_headers, fn {k, v} ->
              if String.downcase(k) == "if-none-match", do: v
            end)

          if inm_expected == nil do
            assert inm_actual == nil,
                   "Case #{@wire_case["id"]} with previousEtag=null MUST NOT send If-None-Match"
          else
            assert inm_actual == inm_expected,
                   "Case #{@wire_case["id"]}: expected If-None-Match=#{inspect(inm_expected)}, got #{inspect(inm_actual)}"
          end
        end

        # ---- Outcome assertions -----------------------------------------
        case Map.fetch!(expected, "outcome") do
          "fetched" ->
            assert result.status == :fetched,
                   "expected :fetched, got status=#{inspect(result.status)} error=#{inspect(result.error)}"

            assert result.body != nil

            if expected_etag = Map.get(expected, "resultingEtag") do
              assert result.etag == expected_etag
            end

          "notModified" ->
            # Elixir returns status=:not_modified (snake_case atom)
            # where the corpus uses 'notModified' (camelCase). The
            # corpus is canonical; each consumer maps to its own
            # idiom.
            assert result.status == :not_modified,
                   "expected :not_modified, got status=#{inspect(result.status)} error=#{inspect(result.error)}"

            assert result.body == nil

            if expected_etag = Map.get(expected, "resultingEtag") do
              assert result.etag == expected_etag
            end

          "failed" ->
            assert result.status == :failed,
                   "expected :failed, got status=#{inspect(result.status)} body=#{inspect(result.body)}"

            mapped = elixir_error_to_class(result.error)
            expected_class = Map.fetch!(expected, "errorClass")

            assert mapped == expected_class,
                   "case #{@wire_case["id"]}: expected errorClass=#{inspect(expected_class)}, got mapped=#{inspect(mapped)} from raw error=#{inspect(result.error)}"

          other ->
            flunk("Unknown outcome value in corpus: #{inspect(other)}")
        end

        # hasConfig: the round-trip did / did not yield a config body.
        if Map.has_key?(expected, "hasConfig") do
          if expected["hasConfig"],
            do: assert(is_map(result.body)),
            else: assert(result.body == nil)
        end
      end
    end
  end
end
