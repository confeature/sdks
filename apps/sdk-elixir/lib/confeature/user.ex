# SPDX-License-Identifier: MIT

defmodule Confeature.User do
  @moduledoc """
  Targeting context for flag evaluation.

  Field names mirror the upstream `configcat` Elixir package's `User`
  struct 1:1 (Constitution Principle II).

  `custom` accepts **typed** values, matching the upstream `configcat`
  Hex package's `User.custom` surface: a value may be a `String.t()`, a
  number (`integer()` / `float()`), a `DateTime.t()` / `NaiveDateTime.t()`,
  or a list of strings (`[String.t()]`). The evaluator converts a
  non-string attribute to ConfigCat's canonical string at comparison
  time (number → invariant-culture decimal, Date → fractional Unix
  epoch SECONDS, list → JSON array string) — see
  `Confeature.Internal.Comparators`. Values are stored **as-is** (no
  eager stringification), exactly as upstream's `User.new/2` does, so
  the typed value reaches the evaluator intact. Keys are normalised to
  strings and are case-sensitive (must match the targeting rule).
  """

  @enforce_keys [:identifier]
  defstruct identifier: "",
            email: nil,
            country: nil,
            custom: nil

  @typedoc """
  A custom user-attribute value. Mirrors the upstream `configcat`
  package: a string, a number, a `DateTime`/`NaiveDateTime`, or a list
  of strings. Non-string values are converted to a canonical string by
  the evaluator at comparison time.
  """
  @type custom_value ::
          String.t()
          | number()
          | DateTime.t()
          | NaiveDateTime.t()
          | [String.t()]

  @type t :: %__MODULE__{
          identifier: String.t(),
          email: String.t() | nil,
          country: String.t() | nil,
          custom: %{optional(String.t()) => custom_value()} | nil
        }

  @doc """
  Build a `Confeature.User` struct from keyword opts.

  ## Examples

      iex> Confeature.User.new(identifier: "alice@example.com")
      %Confeature.User{identifier: "alice@example.com"}

  """
  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      identifier: Keyword.get(opts, :identifier, ""),
      email: Keyword.get(opts, :email),
      country: Keyword.get(opts, :country),
      custom: normalize_custom(Keyword.get(opts, :custom))
    }
  end

  # Normalise only the KEYS to strings (case-sensitive, matching the rule).
  # VALUES are kept as-is so a typed attribute (number / DateTime / list)
  # reaches the evaluator intact — the conversion to ConfigCat's canonical
  # string happens at comparison time, mirroring the upstream `configcat`
  # package (which also stores `custom` values verbatim).
  defp normalize_custom(nil), do: nil

  defp normalize_custom(map) when is_map(map) do
    Enum.into(map, %{}, fn {k, v} -> {to_string(k), v} end)
  end
end
