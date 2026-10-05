# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Comparators do
  @moduledoc """
  The 36 ConfigCat `UserComparator` operations (spec 124, FR-003/FR-004).

  Ported field-for-field from `packages/sdk-shared/src/comparators.ts` (the
  spec-117 reference, proven byte-for-byte against ConfigCat). Each comparator
  returns a three-valued outcome consumed by the evaluator:

    * `true`  — match
    * `false` — no match
    * `{:error, message}` — a validation / conversion failure (bad semver,
      non-numeric number, non-array array). Short-circuits the AND group like
      `false` but is surfaced (FR-010).

  Attribute conversion + the missing-attribute / no-user gates live in the
  evaluator's condition dispatch; the functions here receive an already
  type-converted operand and apply the operator.

  Native-typed user attributes (number / boolean / Elixir-list array /
  `{:datetime_seconds, float}`) flow through un-stringified so the conversion
  driver cases match ConfigCat exactly.
  """

  alias Confeature.Internal.{Hashing, Semver}

  @type outcome :: boolean() | {:error, String.t()}
  @type convert(t) :: {:ok, t} | {:error, String.t()}

  # ---------------------------------------------------------------------------
  # Attribute → string (common-js userAttributeValueToString)
  # ---------------------------------------------------------------------------

  @doc """
  Stringify a user-attribute value exactly as common-js
  `userAttributeValueToString`: string verbatim; a datetime → Unix seconds;
  a string array → JSON; a number → its JS-string form; boolean → "true"/"false".
  """
  @spec user_attribute_value_to_string(term()) :: String.t()
  def user_attribute_value_to_string(value) when is_binary(value), do: value

  # A `DateTime` / `NaiveDateTime` (accepted by the public `User.custom`,
  # mirroring upstream `configcat`) → fractional Unix epoch SECONDS, then
  # the JS-number canonical string. Upstream: `DateTime.to_unix(dt,
  # :millisecond) / 1000.0`; a `NaiveDateTime` is treated as UTC.
  def user_attribute_value_to_string(%DateTime{} = dt),
    do: dt |> datetime_to_unix_seconds() |> number_to_string()

  def user_attribute_value_to_string(%NaiveDateTime{} = naive),
    do: naive |> DateTime.from_naive!("Etc/UTC") |> user_attribute_value_to_string()

  def user_attribute_value_to_string({:datetime_seconds, seconds}),
    do: number_to_string(seconds)

  def user_attribute_value_to_string(value) when is_list(value) do
    if string_list?(value), do: Jason.encode!(value), else: inspect(value)
  end

  def user_attribute_value_to_string(true), do: "true"
  def user_attribute_value_to_string(false), do: "false"
  def user_attribute_value_to_string(:nan), do: "NaN"
  def user_attribute_value_to_string(:infinity), do: "Infinity"
  def user_attribute_value_to_string(:neg_infinity), do: "-Infinity"
  def user_attribute_value_to_string(value) when is_integer(value), do: number_to_string(value)
  def user_attribute_value_to_string(value) when is_float(value), do: number_to_string(value)
  def user_attribute_value_to_string(value), do: to_string(value)

  @doc "Attribute → text (string verbatim; else stringified — never errors)."
  @spec attribute_as_text(term()) :: String.t()
  def attribute_as_text(value) when is_binary(value), do: value
  def attribute_as_text(value), do: user_attribute_value_to_string(value)

  defp string_list?(list), do: is_list(list) and Enum.all?(list, &is_binary/1)

  # Fractional Unix epoch SECONDS for a `DateTime`, matching upstream
  # `configcat`: millisecond resolution divided by 1000.0 (e.g.
  # 1_680_307_199_999 ms → 1_680_307_199.999 s).
  defp datetime_to_unix_seconds(%DateTime{} = dt),
    do: DateTime.to_unix(dt, :millisecond) / 1000.0

  # JS Number → string (ECMAScript `Number.prototype.toString`). NaN / ±Infinity
  # print as "NaN" / "Infinity" / "-Infinity"; otherwise the SHORTEST
  # round-tripping digit sequence, fixed-point unless the magnitude warrants
  # exponential. Ported field-for-field from the Dart/PHP
  # `numberToCanonicalString` / `jsNumberToString` ports. The corpus
  # `numberToStringConversion*` cases hinge on this — e.g. `-1.23456789e+96`
  # must NOT expand to its full integer form, and the exponent carries an
  # explicit sign with no leading zeros.
  defp number_to_string(:nan), do: "NaN"
  defp number_to_string(:infinity), do: "Infinity"
  defp number_to_string(:neg_infinity), do: "-Infinity"

  defp number_to_string(n) when is_integer(n), do: Integer.to_string(n)

  defp number_to_string(n) when is_float(n) do
    if n == 0.0, do: "0", else: js_number_to_string(n)
  end

  # Render a finite non-zero float exactly as ECMAScript `Number.toString`.
  defp js_number_to_string(value) do
    sign = if value < 0, do: "-", else: ""
    av = abs(value)
    {digits, point} = shortest_digits_and_point(av)
    k = String.length(digits)
    n = point

    cond do
      n >= k and n <= 21 ->
        sign <> digits <> String.duplicate("0", n - k)

      n > 0 and n <= 21 ->
        sign <> String.slice(digits, 0, n) <> "." <> String.slice(digits, n..-1//1)

      n > -6 and n <= 0 ->
        sign <> "0." <> String.duplicate("0", -n) <> digits

      true ->
        e = n - 1
        exp_sign = if e >= 0, do: "+", else: "-"

        mant =
          if k == 1,
            do: String.at(digits, 0),
            else: String.at(digits, 0) <> "." <> String.slice(digits, 1..-1//1)

        sign <> mant <> "e" <> exp_sign <> Integer.to_string(abs(e))
    end
  end

  # Decompose the shortest round-tripping repr of a positive double into
  # `{digits, point}` — `point` is the count of significant digits before the
  # decimal point in normalized form (the ECMAScript `n`).
  # `:erlang.float_to_binary(av, [:short])` yields the shortest round-tripping
  # representation, matching JS / Dart `toString` / PHP `serialize_precision=-1`.
  defp shortest_digits_and_point(av) do
    shortest = :erlang.float_to_binary(av, [:short])
    lower = String.downcase(shortest)

    {mant, exp_val} =
      case String.split(lower, "e", parts: 2) do
        [m, e] -> {m, String.to_integer(e)}
        [m] -> {m, 0}
      end

    {int_part, frac_part} =
      case String.split(mant, ".", parts: 2) do
        [i, f] -> {i, f}
        [i] -> {i, ""}
      end

    raw = int_part <> frac_part
    point = String.length(int_part) + exp_val

    {raw, point} = strip_leading_zeros(raw, point)
    raw = String.trim_trailing(raw, "0")
    raw = if raw == "", do: "0", else: raw
    {raw, point}
  end

  defp strip_leading_zeros(raw, point) do
    chars = String.graphemes(raw)
    len = length(chars)
    {stripped, removed} = drop_leading_zeros(chars, len, 0)
    {Enum.join(stripped), point - removed}
  end

  # Drop leading "0" graphemes but always keep at least one character.
  defp drop_leading_zeros([h | t] = chars, len, removed) do
    if h == "0" and len - removed > 1 do
      drop_leading_zeros(t, len, removed + 1)
    else
      {chars, removed}
    end
  end

  # ---------------------------------------------------------------------------
  # Strict number parse (common-js parseFloatStrict)
  # ---------------------------------------------------------------------------

  @doc """
  Strict whole-string float parse, mirroring common-js `parseFloatStrict`:
  rejects empty / all-whitespace and a leading `0` followed by a non-digit/
  non-`.`/non-`e`. Returns `:nan` on failure.
  """
  @spec parse_float_strict(String.t()) :: float() | :nan
  def parse_float_strict(value) when is_binary(value) do
    cond do
      value == "" -> :nan
      Regex.match?(~r/^\s*$|^\s*0[^\d.eE]/, value) -> :nan
      true -> js_to_number(value)
    end
  end

  # JS `+value` numeric coercion for a trimmed-acceptable string.
  defp js_to_number(value) do
    trimmed = String.trim(value)

    cond do
      trimmed == "" ->
        0.0

      trimmed == "Infinity" or trimmed == "+Infinity" ->
        :infinity

      trimmed == "-Infinity" ->
        :neg_infinity

      true ->
        case Float.parse(trimmed) do
          {f, ""} ->
            f

          _ ->
            case Integer.parse(trimmed) do
              {i, ""} -> i * 1.0
              _ -> parse_hex_or_nan(trimmed)
            end
        end
    end
  end

  defp parse_hex_or_nan("0x" <> _ = s), do: hex_or_nan(s)
  defp parse_hex_or_nan("0X" <> _ = s), do: hex_or_nan(s)
  defp parse_hex_or_nan(_), do: :nan

  defp hex_or_nan("0x" <> rest), do: hex_body(rest)
  defp hex_or_nan("0X" <> rest), do: hex_body(rest)

  defp hex_body(rest) do
    case Integer.parse(rest, 16) do
      {i, ""} -> i * 1.0
      _ -> :nan
    end
  end

  # ---------------------------------------------------------------------------
  # Attribute → typed value (three-valued)
  # ---------------------------------------------------------------------------

  @doc "Attribute → semver, or a validation error."
  @spec attribute_as_semver(String.t(), term()) :: convert(Semver.t())
  def attribute_as_semver(attr, value) do
    parsed = if is_binary(value), do: Semver.parse(String.trim(value)), else: nil

    case parsed do
      %Semver{} = v ->
        {:ok, v}

      _ ->
        invalid_attr(
          attr,
          "'#{user_attribute_value_to_string(value)}' is not a valid semantic version"
        )
    end
  end

  @doc "Attribute → number, or a validation error."
  @spec attribute_as_number(String.t(), term()) ::
          convert(number() | :nan | :infinity | :neg_infinity)
  def attribute_as_number(_attr, value) when is_number(value), do: {:ok, value}
  def attribute_as_number(_attr, :nan), do: {:ok, :nan}
  def attribute_as_number(_attr, :infinity), do: {:ok, :infinity}
  def attribute_as_number(_attr, :neg_infinity), do: {:ok, :neg_infinity}

  def attribute_as_number(attr, value) when is_binary(value) do
    num = value |> String.replace(",", ".") |> parse_float_strict()

    if num != :nan or String.trim(value) == "NaN" do
      {:ok, num}
    else
      invalid_attr(attr, "'#{value}' is not a valid decimal number")
    end
  end

  def attribute_as_number(attr, value),
    do:
      invalid_attr(attr, "'#{user_attribute_value_to_string(value)}' is not a valid decimal number")

  @doc "Attribute → Unix seconds, or a validation error."
  @spec attribute_as_unix_seconds(String.t(), term()) ::
          convert(number() | :nan | :infinity | :neg_infinity)
  def attribute_as_unix_seconds(_attr, {:datetime_seconds, seconds}), do: {:ok, seconds}
  def attribute_as_unix_seconds(_attr, %DateTime{} = dt), do: {:ok, datetime_to_unix_seconds(dt)}

  def attribute_as_unix_seconds(attr, %NaiveDateTime{} = naive),
    do: attribute_as_unix_seconds(attr, DateTime.from_naive!(naive, "Etc/UTC"))

  def attribute_as_unix_seconds(_attr, value) when is_number(value), do: {:ok, value}
  def attribute_as_unix_seconds(_attr, :nan), do: {:ok, :nan}
  def attribute_as_unix_seconds(_attr, :infinity), do: {:ok, :infinity}
  def attribute_as_unix_seconds(_attr, :neg_infinity), do: {:ok, :neg_infinity}

  def attribute_as_unix_seconds(attr, value) when is_binary(value) do
    num = value |> String.replace(",", ".") |> parse_float_strict()

    if num != :nan or String.trim(value) == "NaN" do
      {:ok, num}
    else
      invalid_attr(
        attr,
        "'#{value}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
      )
    end
  end

  def attribute_as_unix_seconds(attr, value) do
    invalid_attr(
      attr,
      "'#{user_attribute_value_to_string(value)}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
    )
  end

  @doc "Attribute → string array, or a validation error."
  @spec attribute_as_string_array(String.t(), term()) :: convert([String.t()])
  def attribute_as_string_array(attr, value) do
    arr =
      cond do
        string_list?(value) ->
          value

        is_binary(value) ->
          case Jason.decode(value) do
            {:ok, decoded} -> decoded
            {:error, _} -> value
          end

        true ->
          value
      end

    if string_list?(arr) do
      {:ok, arr}
    else
      invalid_attr(attr, "'#{user_attribute_value_to_string(value)}' is not a valid string array")
    end
  end

  defp invalid_attr(attr, reason),
    do: {:error, "cannot evaluate, the User.#{attr} attribute is invalid (#{reason})"}

  defp invalid_comparison_value(value, reason),
    do: {:error, "comparison value '#{value}' is invalid (#{reason})"}

  # ---------------------------------------------------------------------------
  # Comparison value (config operand) → typed value (#509 validation order).
  # configcat-common validates the CONFIG comparison value BEFORE the user
  # attribute for the semver relations, number relations, and datetime
  # comparators; a malformed operand surfaces a distinct
  # "comparison value '<v>' is invalid (<reason>)" error which wins even when the
  # user attribute is ALSO malformed. Ported from comparators.ts.
  # ---------------------------------------------------------------------------

  @doc "Comparison value → semver (config operand for the semver relations)."
  @spec comparison_value_as_semver(String.t()) :: convert(Semver.t())
  def comparison_value_as_semver(value) when is_binary(value) do
    case Semver.parse(String.trim(value)) do
      %Semver{} = v -> {:ok, v}
      _ -> invalid_comparison_value(value, "'#{value}' is not a valid semantic version")
    end
  end

  def comparison_value_as_semver(value),
    do: invalid_comparison_value(to_string(value), "'#{value}' is not a valid semantic version")

  @doc "Comparison value → number (config operand for the number relations)."
  @spec comparison_value_as_number(term()) :: convert(number())
  def comparison_value_as_number(value) when is_number(value) and not is_boolean(value),
    do: {:ok, value}

  def comparison_value_as_number(value),
    do:
      invalid_comparison_value(
        comparison_value_label(value),
        "'#{comparison_value_label(value)}' is not a valid decimal number"
      )

  @doc "Comparison value → Unix seconds (config operand for the datetime comparators)."
  @spec comparison_value_as_unix_seconds(term()) :: convert(number())
  def comparison_value_as_unix_seconds(value) when is_number(value) and not is_boolean(value),
    do: {:ok, value}

  def comparison_value_as_unix_seconds(value) do
    label = comparison_value_label(value)

    invalid_comparison_value(
      label,
      "'#{label}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
    )
  end

  # JS `String(value)` of the (possibly absent) config operand — an absent slot
  # is `undefined`, matching common-js's `String(value)` of an undefined `d`.
  defp comparison_value_label(nil), do: "undefined"
  defp comparison_value_label(value), do: to_string(value)

  # ---------------------------------------------------------------------------
  # Text — cleartext (case-sensitive, no trim)
  # ---------------------------------------------------------------------------

  @spec text_equals(String.t(), String.t(), boolean()) :: boolean()
  def text_equals(text, comparison_value, negate),
    do: text == comparison_value != negate

  @spec text_is_one_of(String.t(), [String.t()], boolean()) :: boolean()
  def text_is_one_of(text, comparison_values, negate),
    do: Enum.member?(comparison_values, text) != negate

  @spec text_contains_any_of(String.t(), [String.t()], boolean()) :: boolean()
  def text_contains_any_of(text, comparison_values, negate) do
    if Enum.any?(comparison_values, &String.contains?(text, &1)), do: not negate, else: negate
  end

  @doc """
  Cleartext startsWith/endsWith-any-of. Items longer than the text are skipped.
  """
  @spec text_slice_equals_any_of(String.t(), [String.t()], boolean(), boolean()) :: boolean()
  def text_slice_equals_any_of(text, comparison_values, starts_with, negate) do
    matched =
      Enum.any?(comparison_values, fn item ->
        byte_size(text) >= byte_size(item) and
          if starts_with do
            starts_with_bytes?(text, item)
          else
            ends_with_bytes?(text, item)
          end
      end)

    if matched, do: not negate, else: negate
  end

  defp starts_with_bytes?(text, item) do
    n = byte_size(item)
    binary_part(text, 0, n) == item
  end

  defp ends_with_bytes?(text, item) do
    n = byte_size(item)
    binary_part(text, byte_size(text) - n, n) == item
  end

  # ---------------------------------------------------------------------------
  # Text — sensitive (SHA-256 salted)
  # ---------------------------------------------------------------------------

  @spec sensitive_text_equals(String.t(), String.t(), String.t(), String.t(), boolean()) ::
          boolean()
  def sensitive_text_equals(text, comparison_value, config_salt, context_salt, negate) do
    hash = Hashing.hash_comparison_value(text, config_salt, context_salt)
    hash == comparison_value != negate
  end

  @spec sensitive_text_is_one_of(String.t(), [String.t()], String.t(), String.t(), boolean()) ::
          boolean()
  def sensitive_text_is_one_of(text, comparison_values, config_salt, context_salt, negate) do
    hash = Hashing.hash_comparison_value(text, config_salt, context_salt)
    Enum.member?(comparison_values, hash) != negate
  end

  @doc """
  Sensitive startsWith/endsWith-any-of. Each operand is `"<byteLen>_<hash>"`;
  the SDK hashes the matching-length BYTE prefix/suffix of the attribute and
  compares to `<hash>`. Slicing is over UTF-8 bytes (not codepoints).
  """
  @spec sensitive_text_slice_equals_any_of(
          String.t(),
          [String.t()],
          String.t(),
          String.t(),
          boolean(),
          boolean()
        ) :: boolean()
  def sensitive_text_slice_equals_any_of(
        text,
        comparison_values,
        config_salt,
        context_salt,
        starts_with,
        negate
      ) do
    text_len = byte_size(text)

    matched =
      Enum.any?(comparison_values, fn item ->
        case String.split(item, "_", parts: 2) do
          [len_s, expected_hash] ->
            case Integer.parse(len_s) do
              {slice_len, _} when text_len >= slice_len ->
                slice =
                  if starts_with do
                    binary_part(text, 0, slice_len)
                  else
                    binary_part(text, text_len - slice_len, slice_len)
                  end

                Hashing.sha256_bytes(slice <> config_salt <> context_salt) == expected_hash

              _ ->
                false
            end

          _ ->
            false
        end
      end)

    if matched, do: not negate, else: negate
  end

  # ---------------------------------------------------------------------------
  # Semver
  # ---------------------------------------------------------------------------

  @doc """
  Semver IS-ONE-OF / IS-NOT-ONE-OF. Each operand is trimmed first; an operand
  that is empty AFTER trimming (incl. whitespace-only) is skipped — matching
  ConfigCat, which trims before the empty check. A non-empty but unparseable
  operand makes the whole comparator `false`. Iterates ALL operands (no
  early-out) to match upstream's "none invalid" requirement.
  """
  @spec semver_is_one_of(Semver.t(), [String.t()], boolean()) :: boolean()
  def semver_is_one_of(version, comparison_values, negate) do
    result =
      Enum.reduce_while(comparison_values, false, fn item, acc ->
        trimmed = String.trim(item)

        cond do
          trimmed == "" ->
            {:cont, acc}

          true ->
            case Semver.parse(trimmed) do
              nil -> {:halt, :invalid}
              %Semver{} = v2 -> {:cont, acc or Semver.compare(version, v2) == 0}
            end
        end
      end)

    case result do
      :invalid -> false
      bool -> bool != negate
    end
  end

  @doc "Semver relations. An unparseable operand is a non-match (`false`)."
  @spec semver_relation(Semver.t(), integer(), String.t()) :: boolean()
  def semver_relation(version, comparator, comparison_value) do
    case Semver.parse(String.trim(comparison_value)) do
      nil ->
        false

      %Semver{} = v2 ->
        cmp = Semver.compare(version, v2)

        case comparator do
          # SemVerLess
          6 -> cmp < 0
          # SemVerLessOrEquals
          7 -> cmp <= 0
          # SemVerGreater
          8 -> cmp > 0
          # SemVerGreaterOrEquals
          9 -> cmp >= 0
          _ -> false
        end
    end
  end

  # ---------------------------------------------------------------------------
  # Number
  # ---------------------------------------------------------------------------

  @doc "Number relations. Operands/attrs may be `:nan`/`:infinity`/`:neg_infinity`."
  @spec number_relation(term(), integer(), number()) :: boolean()
  def number_relation(num, comparator, comparison_value) do
    case comparator do
      # NumberEquals
      10 -> num_eq(num, comparison_value)
      # NumberNotEquals
      11 -> not num_eq(num, comparison_value)
      # NumberLess
      12 -> num_lt(num, comparison_value)
      # NumberLessOrEquals
      13 -> num_eq(num, comparison_value) or num_lt(num, comparison_value)
      # NumberGreater
      14 -> num_gt(num, comparison_value)
      # NumberGreaterOrEquals
      15 -> num_eq(num, comparison_value) or num_gt(num, comparison_value)
      _ -> false
    end
  end

  # IEEE-754 semantics with NaN/±Inf, matching JS.
  defp num_eq(:nan, _), do: false
  defp num_eq(_, :nan), do: false
  defp num_eq(a, b), do: as_f(a) == as_f(b)

  # Explicit ±Infinity ordering — Erlang term order sorts every number BEFORE
  # every atom, so a naive `atom < number` would make -Infinity compare as
  # GREATER than all finite numbers. Handle the infinity operands by hand to
  # match JS numeric semantics (-Infinity < finite < +Infinity).
  defp num_lt(:nan, _), do: false
  defp num_lt(_, :nan), do: false
  defp num_lt(:neg_infinity, :neg_infinity), do: false
  defp num_lt(:neg_infinity, _), do: true
  defp num_lt(_, :neg_infinity), do: false
  defp num_lt(:infinity, _), do: false
  defp num_lt(_, :infinity), do: true
  defp num_lt(a, b), do: a < b

  # `a > b` is `b < a`; the num_lt NaN clauses already short-circuit to false.
  defp num_gt(a, b), do: num_lt(b, a)

  defp as_f(:infinity), do: :pos_inf
  defp as_f(:neg_infinity), do: :neg_inf
  defp as_f(n) when is_number(n), do: n

  # ---------------------------------------------------------------------------
  # Datetime (Unix seconds)
  # ---------------------------------------------------------------------------

  @spec datetime_relation(term(), number(), boolean()) :: boolean()
  def datetime_relation(seconds, comparison_value, before) do
    if before, do: num_lt(seconds, comparison_value), else: num_gt(seconds, comparison_value)
  end

  # ---------------------------------------------------------------------------
  # Array (cleartext + sensitive)
  # ---------------------------------------------------------------------------

  @spec array_contains_any_of([String.t()], [String.t()], boolean()) :: boolean()
  def array_contains_any_of(array, comparison_values, negate) do
    if Enum.any?(array, &Enum.member?(comparison_values, &1)), do: not negate, else: negate
  end

  @spec sensitive_array_contains_any_of(
          [String.t()],
          [String.t()],
          String.t(),
          String.t(),
          boolean()
        ) :: boolean()
  def sensitive_array_contains_any_of(array, comparison_values, config_salt, context_salt, negate) do
    matched =
      Enum.any?(array, fn item ->
        hash = Hashing.hash_comparison_value(item, config_salt, context_salt)
        Enum.member?(comparison_values, hash)
      end)

    if matched, do: not negate, else: negate
  end
end
