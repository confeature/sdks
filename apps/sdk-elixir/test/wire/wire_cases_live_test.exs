# SPDX-License-Identifier: MIT

defmodule Confeature.Wire.WireCasesLiveTest do
  @moduledoc """
  sdk-elixir live wire-cases (#923, after sdk-go's #921).

  sdk-elixir's own `Confeature.Internal.ConfigFetcher` — built the way
  `Confeature.Client` builds it, with its default HTTPoison client and
  version string — against a RUNNING live-contract harness serving the
  reference origin of the CDN read path. Every seeded wire-case is
  replayed and judged by `Confeature.Test.WireCaseAssertions`, the SAME
  rules the hermetic suite (`wire_cases_test.exs`) applies. Nothing is
  hand-built and no admin write is made:

    - the case set comes from the running harness (`GET /admin/state` ->
      `keys`), never recomputed from the corpus — `http-403` among them,
      an unseeded key answered by the Worker itself. It is read when this
      file is compiled, which `mix test` does at run time, so each case is
      its own `test`;
    - the request each case sent is read back from the harness
      (`GET /admin/requests?sdkKey=`), and each fetch must add exactly one
      entry;
    - a timeout case is ended by the SDK's OWN deadline (a quarter of the
      harness's hold).

  Run it through the harness wrapper (the manifest's `liveSuite.runner`).
  GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
  hermetic `mix test`. When it is set without `LIVE_HARNESS_URL` the suite
  FAILS, and when the harness does not answer this file does not compile;
  it never skips.
  """

  use ExUnit.Case, async: false

  alias Confeature.Internal.ConfigFetcher
  alias Confeature.Logger, as: ConfLogger
  alias Confeature.Test.WireCaseAssertions

  # A key the harness never seeds.
  @never_seeded_key "never-seeded-923"
  @default_deadline_seconds 10.0

  defmodule Harness do
    @moduledoc false
    # The running harness's admin routes, read with HTTPoison.

    @doc "GETs an admin route and decodes its JSON object; a non-200 raises."
    def get_json!(base, path, query \\ []) do
      url = base <> path <> if(query == [], do: "", else: "?" <> URI.encode_query(query))

      case HTTPoison.get(url, [], recv_timeout: 10_000) do
        {:ok, %{status_code: 200, body: body}} ->
          Jason.decode!(body)

        {:ok, %{status_code: code, body: body}} ->
          raise "harness #{path} answered #{code}: #{body}"

        {:error, error} ->
          raise "harness #{path}: #{inspect(error)}"
      end
    end

    @doc "The requests the harness logged for `sdk_key`, oldest first."
    def requests_for!(base, sdk_key) do
      case get_json!(base, "/admin/requests", sdkKey: sdk_key) do
        %{"ok" => true, "requests" => requests} -> requests
        other -> raise "harness refused /admin/requests: #{inspect(other)}"
      end
    end
  end

  @live System.get_env("CONFEATURE_LIVE") == "1"
  @base String.trim_trailing(System.get_env("LIVE_HARNESS_URL") || "", "/")

  cond do
    not @live ->
      @tag skip: "hermetic run: CONFEATURE_LIVE is not set"
      test "wire-cases live (#923)", do: :ok

    @base == "" ->
      test "wire-cases live (#923)" do
        flunk(
          "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " <>
            "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping"
        )
      end

    true ->
      @state Harness.get_json!(@base, "/admin/state")
      @keys @state |> Map.fetch!("keys") |> Enum.sort()
      @corpus Map.new(WireCaseAssertions.load_cases(), &{&1["id"], &1})

      test "seeded-set" do
        assert @keys != [], "the harness reports no seeded case — an empty run checks nothing"
        assert Enum.reject(@keys, &Map.has_key?(@corpus, &1)) == []
      end

      for id <- @keys, Map.has_key?(@corpus, id) do
        @id id
        test "case #{id}" do
          wire_case = Map.fetch!(@corpus, @id)
          hold_ms = hold_ms(wire_case, Map.get(@state["faults"] || %{}, @id))
          deadline_s = if hold_ms > 0, do: hold_ms / 4 / 1000, else: @default_deadline_seconds

          # The harness seeds each case under its id; a case that pins
          # given.sdkKey is configured with that key instead (#803 FR-003).
          sdk_key = WireCaseAssertions.sdk_key_for(wire_case, @id)
          logged_before = length(Harness.requests_for!(@base, sdk_key))

          fetcher = new_fetcher(sdk_key, deadline_s)
          started = System.monotonic_time(:millisecond)
          result = ConfigFetcher.fetch(fetcher, wire_case["given"]["previousEtag"])
          elapsed_ms = System.monotonic_time(:millisecond) - started

          log = Harness.requests_for!(@base, sdk_key)

          # Exactly one request per fetch: a retrying SDK, or a request
          # logged by an earlier run, must not stand in for the one under test.
          assert length(log) - logged_before == 1, "one fetch sends exactly one request"

          if hold_ms > 0 do
            assert elapsed_ms < hold_ms,
                   "took #{elapsed_ms} ms: the SDK's own deadline must end the fetch, " <>
                     "not the harness releasing it after #{hold_ms} ms"
          end

          last = List.last(log)
          target = Map.fetch!(last, "url")

          WireCaseAssertions.assert_wire_case(
            wire_case,
            sdk_key,
            %{
              path: target |> String.split("?", parts: 2) |> hd(),
              target: target,
              if_none_match: last["ifNoneMatch"]
            },
            result
          )
        end
      end

      # US4: no seed, no fault — the CDN's own unknown-key answer,
      # ConfigCat's 403 since #785, classed like a 404 as invalidSdkKey.
      test "unseeded-key" do
        result =
          @never_seeded_key |> new_fetcher(@default_deadline_seconds) |> ConfigFetcher.fetch()

        assert result.status == :failed

        assert WireCaseAssertions.elixir_error_to_class(result.error) == "invalidSdkKey",
               "raw=#{inspect(result.error)}"
      end

      # The fetcher as `Confeature.Client` builds it: its default HTTPoison
      # client, the SDK's own version, and the deadline as its timeout.
      defp new_fetcher(sdk_key, deadline_s) do
        ConfigFetcher.new(
          sdk_key: sdk_key,
          version: Confeature.version(),
          logger: ConfLogger.silent(),
          base_url: @base,
          request_timeout_seconds: deadline_s
        )
      end

      # The harness's hold for a timeout case — the SDK's deadline is
      # derived from it (#783 A8) — or 0 for any other behaviour.
      defp hold_ms(wire_case, fault) do
        if wire_case["server"]["behavior"] == "timeout" do
          ms = if is_map(fault), do: fault["ms"]
          assert is_integer(ms) and ms > 0, "#{wire_case["id"]} is seeded without a timeout fault"
          ms
        else
          0
        end
      end
  end
end
