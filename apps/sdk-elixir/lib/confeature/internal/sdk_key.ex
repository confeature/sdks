# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.SdkKey do
  @moduledoc """
  SDK-key format helpers + cache-key derivation.

  SECURITY (Constitution security clause + spec 037 FR-008): SDK keys
  are secrets. They MUST NEVER appear verbatim in any log line. Every
  log site routes through `redact/1` first.

  The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`
  (SHA-256 → base64url → first 32 chars). Cross-language fixture
  verification lives in `test/cache_key_fixtures_test.exs`.
  """

  alias Confeature.Internal.Sealed

  @cache_key_prefix "confeature:cache:v1:"

  # Wire formats of a valid Confeature SDK key — both are accepted (#802):
  #   `configcat-sdk-1/<22 url-safe>/<22 url-safe>` — minted today,
  #     ConfigCat's own shape, so a stock ConfigCat SDK accepts it too;
  #   `confeature-sdk-1-<32 url-safe>-<32 url-safe>` — minted before
  #     #802, still served until the key is rotated.
  # Mirrors `CONFEATURE_SDK_KEY_PATTERN` in packages/sdk-shared/src/sdk-key.ts.
  @confeature_pattern ~r/\A(?:configcat-sdk-1\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})\z/

  @doc """
  Return `true` iff `sdk_key` matches a Confeature SDK key format.

  Two shapes are valid:

    * `configcat-sdk-1/<22>/<22>` — the shape Confeature mints (ConfigCat's
      own), e.g. `configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02`;
    * `confeature-sdk-1-<32>-<32>` — the legacy shape, still accepted.

  Each segment uses the URL-safe alphabet `[A-Za-z0-9_-]`. The accept /
  reject cases live in
  `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.

  A `false` result does NOT cause the SDK to raise; it triggers an
  `INVALID_SDK_KEY` log line (which, per the security clause, includes
  only the redacted form).
  """
  @spec valid_confeature_key_format?(any()) :: boolean()
  def valid_confeature_key_format?(sdk_key) when is_binary(sdk_key) do
    Regex.match?(@confeature_pattern, sdk_key)
  end

  def valid_confeature_key_format?(_), do: false

  @doc """
  Return a privacy-preserving rendering of `sdk_key` for logs.

  Strategy: keep the last 4 chars visible, mask the rest. For short /
  unusual keys (`<= 8` bytes) and non-binary inputs, fall back to a
  full mask. NEVER returns the raw key. For either key shape the 4
  visible chars come from the final secret segment (a `/`-separated
  `configcat-sdk-1/...` key shows no more than a legacy one).
  """
  @spec redact(any()) :: String.t()
  def redact(%Sealed{} = sealed), do: sealed |> Sealed.unseal() |> redact()

  def redact(sdk_key) when is_binary(sdk_key) and byte_size(sdk_key) > 8 do
    "***" <> binary_part(sdk_key, byte_size(sdk_key) - 4, 4)
  end

  def redact(_), do: "***"

  @doc """
  Replace every occurrence of each of `secrets` inside `term` with its
  `redact/1` form (#803).

  Walks binaries, charlists, lists (improper ones too), tuples and maps
  (structs and map keys included); every other term is kept. Used by
  `format_status/1` so the state, last message, reason and debug log of a
  status or crash report quote no secret, whatever formatter renders them.
  """
  @spec scrub(term(), [String.t()]) :: term()
  def scrub(term, secrets) do
    case Enum.filter(secrets, &(is_binary(&1) and &1 != "")) do
      [] -> term
      secrets -> do_scrub(term, Enum.sort_by(secrets, &(-byte_size(&1))))
    end
  end

  defp do_scrub(bin, secrets) when is_binary(bin) do
    Enum.reduce(secrets, bin, fn secret, acc ->
      :binary.replace(acc, secret, redact(secret), [:global])
    end)
  end

  defp do_scrub(list, secrets) when is_list(list) do
    if list != [] and :io_lib.printable_unicode_list(list) do
      string = List.to_string(list)
      scrubbed = do_scrub(string, secrets)
      if scrubbed == string, do: list, else: String.to_charlist(scrubbed)
    else
      scrub_list(list, secrets)
    end
  end

  defp do_scrub(tuple, secrets) when is_tuple(tuple) do
    tuple |> Tuple.to_list() |> scrub_list(secrets) |> List.to_tuple()
  end

  defp do_scrub(map, secrets) when is_map(map) do
    # `Map.to_list/1`, not `Map.new/2`: a struct is not Enumerable.
    for {k, v} <- Map.to_list(map), into: %{}, do: {do_scrub(k, secrets), do_scrub(v, secrets)}
  end

  defp do_scrub(other, _secrets), do: other

  defp scrub_list([head | tail], secrets),
    do: [do_scrub(head, secrets) | scrub_list(tail, secrets)]

  defp scrub_list([], _secrets), do: []
  defp scrub_list(improper_tail, secrets), do: do_scrub(improper_tail, secrets)

  @doc """
  Derive a stable, opaque cache key from an SDK key.

  Format: `confeature:cache:v1:<base64url(sha256(sdk_key))[0..31]>`.

  Output is byte-identical to the TS workspace's async `deriveCacheKey`
  (Web Crypto's `subtle.digest("SHA-256")`). The cross-language fixture
  at `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
  pins ≥ 5 (sdkKey, expectedCacheKey) pairs and the Elixir unit test
  asserts string equality for every entry.

  SECURITY: the SDK key is HASHED, never stored raw. Even an attacker
  with filesystem access to the cache directory cannot read the SDK key
  from a written cache file's name.
  """
  @spec derive_cache_key(String.t()) :: String.t()
  def derive_cache_key(sdk_key) when is_binary(sdk_key) do
    hash = :crypto.hash(:sha256, sdk_key)
    b64 = Base.url_encode64(hash, padding: false)
    @cache_key_prefix <> binary_part(b64, 0, 32)
  end

  @spec cache_key_prefix() :: String.t()
  def cache_key_prefix, do: @cache_key_prefix
end
