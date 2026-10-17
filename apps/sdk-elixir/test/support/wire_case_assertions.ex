# SPDX-License-Identifier: MIT

defmodule Confeature.Test.WireCaseAssertions do
  @moduledoc """
  What a `wire-cases.json` case means for sdk-elixir — ONE implementation,
  shared by the hermetic suite (`test/wire/wire_cases_test.exs`, raw
  `:gen_tcp` loopback listeners) AND the live suite
  (`test/wire/wire_cases_live_test.exs`, real HTTP against the
  live-contract harness, #923), so both are judged by the same rules.

  The request is passed in SDK-neutral form, `%{path:, target:,
  if_none_match:}`: the hermetic suite reads it from the raw request
  line, the live suite from the harness's `GET /admin/requests`.

  Mirrors sdk-go's `wire_case_assertions_test.go` (#921) and sdk-ruby's
  `wire_case_assertions.rb` (#920). It lives under `test/support`, which
  `mix.exs` compiles for `MIX_ENV=test` only, so it never reaches a
  customer's prod compile.
  """

  import ExUnit.Assertions

  alias Confeature.Internal.ConfigFetcher
  alias Confeature.Logger, as: ConfLogger

  # Every `given` / `expected` field this consumer reads (#803 FR-003).
  # A field outside these lists FAILS the case — a new expectation can
  # never be skipped silently.
  @known_given_fields ~w(previousEtag sdkKey baseUrl)
  @known_expected_fields ~w(outcome errorClass resultingEtag hasConfig
                            requestHeaderIfNoneMatch requestUrlPrefix requestPath)

  # apps/sdk-elixir/test/support → the workspace root is four `..` away.
  @fixtures_dir Path.expand("../../../../packages/test-fixtures-sdk-parity/fixtures", __DIR__)

  @doc "The directory holding `wire-cases.json` and its body fixtures."
  @spec fixtures_dir() :: String.t()
  def fixtures_dir, do: @fixtures_dir

  @doc "The path of `wire-cases.json`."
  @spec corpus_path() :: String.t()
  def corpus_path, do: Path.join(fixtures_dir(), "wire-cases.json")

  @doc "The corpus's cases, in file order. Raises when it carries none."
  @spec load_cases() :: [map()]
  def load_cases do
    case corpus_path() |> File.read!() |> Jason.decode!() |> Map.fetch!("cases") do
      [] -> raise "wire-cases.json carries no cases"
      cases -> cases
    end
  end

  @doc """
  The key a suite configures its fetcher with: the corpus's
  `given.sdkKey` when the case pins one, else the suite's own default
  (the live suite's default is the case id, the key the harness seeds).
  """
  @spec sdk_key_for(map(), String.t()) :: String.t()
  def sdk_key_for(wire_case, default_key),
    do: Map.get(wire_case["given"], "sdkKey") || default_key

  @doc "Fails on any `given` or `expected` field this consumer does not read (#803 FR-003)."
  @spec assert_only_known_fields(map()) :: :ok
  def assert_only_known_fields(wire_case) do
    unknown_given = Map.keys(wire_case["given"]) -- @known_given_fields
    unknown_expected = Map.keys(wire_case["expected"]) -- @known_expected_fields

    assert unknown_given == [],
           "case #{wire_case["id"]}: unknown given field(s) #{inspect(unknown_given)}"

    assert unknown_expected == [],
           "case #{wire_case["id"]}: unknown expected field(s) #{inspect(unknown_expected)}"

    :ok
  end

  @doc """
  Judges one fetch of a case — the request it `sent` and the `result` it
  returned — by the corpus's expectations.
  """
  @spec assert_wire_case(map(), String.t(), map(), ConfigFetcher.Result.t()) :: :ok
  def assert_wire_case(wire_case, sdk_key, sent, result) do
    assert_only_known_fields(wire_case)
    assert_request(wire_case, sdk_key, sent)
    assert_outcome(wire_case, result)
    :ok
  end

  @doc """
  Maps the fetcher's stringly-typed `Result.error` onto the corpus's
  normalised error-class vocabulary. The fetcher emits FIXED codes only:

    - "MALFORMED_JSON"          -> parseFailed   (JSON.decode failure or wrong shape)
    - "INVALID_SDK_KEY"         -> invalidSdkKey (key refused before any request)
    - "HTTP 403" / "HTTP 404"   -> invalidSdkKey (per ConfigCat only 403/404 are
                                   invalid-SDK-key statuses; 401 is retryable)
    - "HTTP <other-non-2xx>"    -> fetchFailed
    - "TRANSPORT_TIMEOUT"       -> timeout       (recv/connect timeout, #490)
    - "TRANSPORT" / "EXCEPTION" -> fetchFailed   (any other transport drop,
                                   incl. a connection reset mid-response)

  A missing code or one outside that list maps to `"unmapped:<code>"`,
  which matches no corpus class — so it FAILS, like sdk-go's
  `goErrorToClass`. Folding the unknown into fetchFailed would let any
  unexpected failure pass every fetchFailed case.
  """
  @spec elixir_error_to_class(String.t() | nil) :: String.t()
  def elixir_error_to_class(nil), do: "unmapped:<none>"
  def elixir_error_to_class("MALFORMED_JSON"), do: "parseFailed"
  def elixir_error_to_class("INVALID_SDK_KEY"), do: "invalidSdkKey"
  def elixir_error_to_class("HTTP 403"), do: "invalidSdkKey"
  def elixir_error_to_class("HTTP 404"), do: "invalidSdkKey"
  def elixir_error_to_class("HTTP " <> _rest), do: "fetchFailed"
  def elixir_error_to_class("TRANSPORT_TIMEOUT"), do: "timeout"
  def elixir_error_to_class("TRANSPORT"), do: "fetchFailed"
  def elixir_error_to_class("EXCEPTION"), do: "fetchFailed"
  def elixir_error_to_class(other), do: "unmapped:" <> other

  # The request side: the exact path as sent (compared byte for byte), no
  # legacy /v2/ prefix, a custom base leading the URL, and the
  # If-None-Match round-trip.
  defp assert_request(wire_case, sdk_key, sent) do
    id = wire_case["id"]
    given = wire_case["given"]
    expected = wire_case["expected"]

    # URL shape (#803 FR-001): ConfigCat's <baseUrl>/configuration-files/
    # <sdkKey>/config_v6.json, the key's exact bytes.
    wanted_path =
      Map.get(expected, "requestPath") || "/configuration-files/#{sdk_key}/config_v6.json"

    assert sent.path == wanted_path,
           "case #{id}: expected path #{inspect(wanted_path)}, got #{inspect(sent.path)}"

    refute String.contains?(sent.target, "/v2/"),
           "case #{id}: #{inspect(sent.target)} carries the legacy /v2/ prefix"

    assert_custom_base(
      id,
      sdk_key,
      Map.get(given, "baseUrl"),
      Map.get(expected, "requestUrlPrefix")
    )

    assert_if_none_match(id, expected, sent.if_none_match)
  end

  # A custom base must lead the request URL (custom-base-url). Checked on
  # the fetcher's request_url — the one place the URL fetch/2 GETs is
  # built — so the check holds whatever host the suite really talks to.
  defp assert_custom_base(id, sdk_key, base_url, prefix) do
    assert is_nil(base_url) == is_nil(prefix),
           "case #{id}: given.baseUrl and expected.requestUrlPrefix come together"

    if base_url do
      url =
        [
          sdk_key: sdk_key,
          version: "0.0.0-wire-test",
          logger: ConfLogger.silent(),
          base_url: base_url
        ]
        |> ConfigFetcher.new()
        |> ConfigFetcher.request_url()

      assert String.starts_with?(url, prefix),
             "case #{id}: expected URL to start with #{prefix}, got #{url}"
    end
  end

  # The corpus uses a 3-state encoding: absent key = don't assert,
  # explicit null = header MUST NOT be sent, explicit string = header
  # MUST equal.
  defp assert_if_none_match(id, expected, actual) do
    if Map.has_key?(expected, "requestHeaderIfNoneMatch") do
      case Map.get(expected, "requestHeaderIfNoneMatch") do
        nil ->
          assert actual == nil,
                 "case #{id} with previousEtag=null MUST NOT send If-None-Match"

        wanted ->
          assert actual == wanted,
                 "case #{id}: expected If-None-Match=#{inspect(wanted)}, got #{inspect(actual)}"
      end
    end
  end

  # Maps the fetcher's status atom and reason code onto the corpus's
  # {fetched, notModified, failed} x errorClass vocabulary, and checks
  # hasConfig: the round-trip did / did not yield a config body.
  defp assert_outcome(wire_case, result) do
    id = wire_case["id"]
    expected = wire_case["expected"]

    case Map.fetch!(expected, "outcome") do
      "fetched" ->
        assert result.status == :fetched,
               "case #{id}: expected :fetched, got status=#{inspect(result.status)} error=#{inspect(result.error)}"

        assert result.body != nil
        assert_resulting_etag(expected, result)

      "notModified" ->
        # Elixir's :not_modified is the corpus's 'notModified'.
        assert result.status == :not_modified,
               "case #{id}: expected :not_modified, got status=#{inspect(result.status)} error=#{inspect(result.error)}"

        assert result.body == nil
        assert_resulting_etag(expected, result)

      "failed" ->
        assert result.status == :failed,
               "case #{id}: expected :failed, got status=#{inspect(result.status)} body=#{inspect(result.body)}"

        mapped = elixir_error_to_class(result.error)
        wanted = Map.fetch!(expected, "errorClass")

        assert mapped == wanted,
               "case #{id}: expected errorClass=#{inspect(wanted)}, got mapped=#{inspect(mapped)} from raw error=#{inspect(result.error)}"

      other ->
        flunk("Unknown outcome value in corpus: #{inspect(other)}")
    end

    if Map.has_key?(expected, "hasConfig") do
      assert is_map(result.body) == expected["hasConfig"], "case #{id}: hasConfig"
    end
  end

  defp assert_resulting_etag(expected, result) do
    if wanted = Map.get(expected, "resultingEtag") do
      assert result.etag == wanted
    end
  end
end
