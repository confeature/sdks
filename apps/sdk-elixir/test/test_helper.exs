# SPDX-License-Identifier: MIT

ExUnit.start()

defmodule Confeature.TestHelpers do
  @moduledoc """
  Test helpers for the Confeature Elixir SDK test suite.

  Locates the monorepo root (containing `pnpm-workspace.yaml`) by
  walking up from `__DIR__` so tests can read the shared parity fixture
  corpus regardless of where ExUnit is invoked from.
  """

  @sample_sdk_key "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

  @doc "Return the workspace root containing `pnpm-workspace.yaml`."
  @spec workspace_root() :: String.t()
  def workspace_root do
    walk_up(__ENV__.file |> Path.expand() |> Path.dirname())
  end

  defp walk_up(dir) do
    if File.exists?(Path.join(dir, "pnpm-workspace.yaml")) do
      dir
    else
      parent = Path.dirname(dir)

      if parent == dir,
        do: raise("could not locate workspace root"),
        else: walk_up(parent)
    end
  end

  @doc "Resolve a path inside packages/test-fixtures-sdk-parity/fixtures/."
  @spec fixture_path(String.t()) :: String.t()
  def fixture_path(name) do
    Path.join([workspace_root(), "packages", "test-fixtures-sdk-parity", "fixtures", name])
  end

  @doc "Resolve a path inside the vendored upstream conformance corpus."
  @spec upstream_path(String.t()) :: String.t()
  def upstream_path(rel) do
    fixture_path(Path.join("upstream", rel))
  end

  @doc "Read + JSON-decode a file from the vendored upstream corpus."
  @spec upstream_json(String.t()) :: term()
  def upstream_json(rel) do
    rel |> upstream_path() |> File.read!() |> Jason.decode!()
  end

  @doc "Read a raw text file from the vendored upstream corpus."
  @spec upstream_text(String.t()) :: String.t()
  def upstream_text(rel) do
    rel |> upstream_path() |> File.read!()
  end

  @doc "Load the cache-key fixture corpus."
  @spec cache_key_fixtures() :: [%{required(String.t()) => String.t()}]
  def cache_key_fixtures do
    "cache-key-fixtures.json" |> fixture_path() |> File.read!() |> Jason.decode!()
  end

  @doc """
  Load the shared SDK-key accept/reject list (#802):
  `%{"valid" => [%{"name", "key"}], "invalid" => [...]}`.
  """
  @spec sdk_key_shapes() :: %{required(String.t()) => [map()]}
  def sdk_key_shapes do
    "sdk-key-shapes.json" |> fixture_path() |> File.read!() |> Jason.decode!()
  end

  @doc "Load the parity corpus (58 tuples)."
  @spec parity_corpus() :: [map()]
  def parity_corpus do
    "parity-corpus.json" |> fixture_path() |> File.read!() |> Jason.decode!()
  end

  @doc "Load the parity configs keyed by their `id`."
  @spec parity_configs() :: %{required(String.t()) => map()}
  def parity_configs do
    "parity-configs.json"
    |> fixture_path()
    |> File.read!()
    |> Jason.decode!()
    |> Enum.into(%{}, fn cfg -> {cfg["id"], cfg} end)
  end

  @doc "Load the typed parity corpus (13 tuples — spec 072 US2)."
  @spec parity_corpus_typed() :: [map()]
  def parity_corpus_typed do
    "parity-corpus-typed.json" |> fixture_path() |> File.read!() |> Jason.decode!()
  end

  @doc "Load the typed parity configs keyed by their `id` (spec 072 US2)."
  @spec parity_configs_typed() :: %{required(String.t()) => map()}
  def parity_configs_typed do
    "parity-configs-typed.json"
    |> fixture_path()
    |> File.read!()
    |> Jason.decode!()
    |> Enum.into(%{}, fn cfg -> {cfg["id"], cfg} end)
  end

  @doc "Load the targeting-rule parity corpus (8 tuples — spec 135 US3)."
  @spec parity_corpus_rules() :: [map()]
  def parity_corpus_rules do
    "parity-corpus-rules.json" |> fixture_path() |> File.read!() |> Jason.decode!()
  end

  @doc "Load the targeting-rule parity configs keyed by their `id` (spec 135 US3)."
  @spec parity_configs_rules() :: %{required(String.t()) => map()}
  def parity_configs_rules do
    "parity-configs-rules.json"
    |> fixture_path()
    |> File.read!()
    |> Jason.decode!()
    |> Enum.into(%{}, fn cfg -> {cfg["id"], cfg} end)
  end

  @doc "Sample Confeature v1 SDK key — used wherever the key value is irrelevant."
  @spec sample_sdk_key() :: String.t()
  def sample_sdk_key, do: @sample_sdk_key

  @doc "Build a Confeature.User from the parity-corpus user-record shape."
  @spec build_user(map() | nil) :: Confeature.User.t() | nil
  def build_user(nil), do: nil

  def build_user(raw) when is_map(raw) do
    Confeature.User.new(
      identifier: Map.get(raw, "identifier", ""),
      email: Map.get(raw, "email"),
      country: Map.get(raw, "country"),
      custom: decode_custom(Map.get(raw, "custom"))
    )
  end

  # Rehydrate a `user.custom` map from the typed-attribute JSON encoding,
  # mirroring `apps/sdk-python/tests/parity/test_parity_rules.py`
  # (`_decode_custom`). The corpus encodes each value by its NATURAL JSON
  # type (string→binary, number→integer/float, bool→boolean,
  # string[]→list) with two tagged exceptions:
  #   - a Date is `{"$date": <unix-epoch-SECONDS>}`, the inverse of the
  #     exporter's `getTime() / 1000`.
  #   - a non-finite number is `{"$num": "NaN" | "Infinity" | "-Infinity"}`
  #     (#479) — `JSON.stringify` collapses these to lossy `null`, so the
  #     exporter tags them explicitly, parallel to `{$date}`.
  defp decode_custom(nil), do: nil

  defp decode_custom(custom) when is_map(custom) do
    custom
    |> Enum.into(%{}, fn {k, v} -> {k, decode_custom_value(v)} end)
  end

  # `{"$date": epoch-seconds}` → the evaluator's native datetime form
  # (`{:datetime_seconds, seconds}`). Keeping the epoch-seconds float
  # verbatim avoids any float→DateTime round-trip precision loss on the
  # fractional millisecond (e.g. 1_680_307_199.999).
  defp decode_custom_value(%{"$date" => seconds} = wrapper) when map_size(wrapper) == 1,
    do: {:datetime_seconds, seconds}

  # `{"$num": "NaN" | "Infinity" | "-Infinity"}` → the evaluator's native
  # non-finite-float representation. BEAM floats cannot hold NaN/±Inf, so
  # the Elixir evaluator models them as the atoms `:nan` / `:infinity` /
  # `:neg_infinity` (see `Confeature.Internal.Comparators` — both
  # `user_attribute_value_to_string/1` and `attribute_as_number/2` handle
  # these atoms). Decoding the `{$num}` tag to those atoms lets the
  # non-finite `numberToStringConversion*` / `dateToStringConversion*`
  # tuples render to "NaN"/"Infinity"/"-Infinity" and run end-to-end (#479).
  defp decode_custom_value(%{"$num" => "NaN"} = wrapper) when map_size(wrapper) == 1, do: :nan

  defp decode_custom_value(%{"$num" => "Infinity"} = wrapper) when map_size(wrapper) == 1,
    do: :infinity

  defp decode_custom_value(%{"$num" => "-Infinity"} = wrapper) when map_size(wrapper) == 1,
    do: :neg_infinity

  defp decode_custom_value(value), do: value
end
