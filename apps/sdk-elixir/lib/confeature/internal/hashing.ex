# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Hashing do
  @moduledoc """
  ConfigCat-parity hashing for the evaluation engine (spec 124, FR-004/FR-005).

  Ports `packages/sdk-shared/src/hash.ts` (the spec-117 reference, proven
  byte-for-byte against ConfigCat) onto Erlang/OTP `:crypto` — already in
  `extra_applications`, no new dependency.

  Two hashes:

    * **SHA-1, UNSALTED** for percentage bucketing —
      `parseInt(sha1(key <> attr)[0..6], 16) rem 100`. The input is the
      setting key concatenated with the stringified keying attribute, with
      NO salt (matches `hash.ts::percentageBucket`).
    * **SHA-256, SALTED** for sensitive comparators —
      `sha256(value <> configSalt <> contextSalt)`, lowercase hex (matches
      `hash.ts::hashComparisonValue`). The byte-level variant
      `sha256_bytes/1` is the entry point the sensitive startsWith/endsWith
      comparators need: they slice the attribute at the UTF-8 BYTE boundary
      (which may land mid-codepoint) and hash that raw byte slice.

  Both return a lowercase hex string, byte-identical to TS / Python / Go /
  Ruby / PHP / .NET / Dart.
  """

  @doc """
  Lowercase-hex SHA-1 of the UTF-8 bytes of `input` (40 chars). UNSALTED.
  """
  @spec sha1(binary()) :: String.t()
  def sha1(input) when is_binary(input) do
    :sha |> :crypto.hash(input) |> Base.encode16(case: :lower)
  end

  @doc "Lowercase-hex SHA-256 of the UTF-8 bytes of `input` (64 chars)."
  @spec sha256(binary()) :: String.t()
  def sha256(input) when is_binary(input) do
    :crypto.hash(:sha256, input) |> Base.encode16(case: :lower)
  end

  @doc """
  Lowercase-hex SHA-256 of arbitrary `bytes` (the byte-level entry point for
  sensitive startsWith/endsWith slices). Same as `sha256/1` in Elixir, where
  a binary already IS a byte sequence — kept as a named entry to mirror the
  TS reference (`sha256Bytes`).
  """
  @spec sha256_bytes(binary()) :: String.t()
  def sha256_bytes(bytes) when is_binary(bytes), do: sha256(bytes)

  @doc """
  Hash a user-attribute value for a sensitive comparator (FR-004). Mirrors
  `hash.ts::hashComparisonValue`:

      sha256(value <> config_salt <> context_salt)

  concatenated with no separators, output as lowercase hex.
  """
  @spec hash_comparison_value(String.t(), String.t(), String.t()) :: String.t()
  def hash_comparison_value(value, config_salt, context_salt)
      when is_binary(value) and is_binary(config_salt) and is_binary(context_salt) do
    sha256(value <> config_salt <> context_salt)
  end

  @doc """
  Compute a ConfigCat percentage bucket in `0..99` for `key <> attr_value`
  (FR-005). Mirrors `hash.ts::percentageBucket`:

      parseInt(sha1(key <> attr_value)[0..6], 16) rem 100

  SHA-1, UNSALTED. 7 hex chars = 28 bits, parsed as an integer mod 100.
  """
  @spec percentage_bucket(String.t(), String.t()) :: non_neg_integer()
  def percentage_bucket(key, attr_value) when is_binary(key) and is_binary(attr_value) do
    hex = (key <> attr_value) |> sha1() |> binary_part(0, 7)
    rem(String.to_integer(hex, 16), 100)
  end
end
