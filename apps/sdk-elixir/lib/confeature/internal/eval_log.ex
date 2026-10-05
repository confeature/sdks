# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.EvalLog do
  @moduledoc """
  ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
  Elixir slice of #501).

  Elixir port of the spec-117 TS reference
  (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder`) and the merged
  Go / Python / Ruby / .NET / PHP / Dart ports. Produces the byte-identical
  indented textual trace ConfigCat's SDKs emit during flag evaluation — its
  `evaluationlog/` corpus (replayed via
  `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is the
  byte-oracle.

  Elixir is immutable, so the builder is a struct threaded through the
  evaluation: every `append/2` / `new_line/2` / `increase_indent/1` /
  `decrease_indent/1` and every condition-rendering helper RETURNS the updated
  `%Builder{}`. The TEXT/STRUCTURE is byte-identical to the canonical mutable
  reference; only the plumbing differs.

  The trace is emitted via the trace logger at INFO under event id 5000
  (ConfigCat's verbosity contract) — see `Evaluator.evaluate_traced`. The
  strings are ported VERBATIM from the canonical (Principle II).
  """

  alias Confeature.Internal.Comparators

  # ConfigCat's event id for the "config evaluated" INFO log line. Captured as
  # `... [5000] ...`, matching the upstream oracle.
  @eval_log_event_id "5000"

  # ConfigCat indents each nested eval-log line by two spaces per level.
  @indent_unit "  "

  # Placeholders ConfigCat substitutes for malformed condition parts (parity
  # with configcat-common's EvaluateLogBuilder).
  @invalid_value_placeholder "<invalid value>"
  @invalid_name_placeholder "<invalid name>"
  @invalid_operator_placeholder "<invalid operator>"

  # Max IS-ONE-OF / list items rendered before truncation (configcat parity).
  @string_list_max_length 10

  @segment_is_not_in 1
  @prereq_not_equals 1

  # Per-comparator eval-log metadata (configcat-common parity), as
  # `{token, kind, sensitive}` — `token` is the operator rendering, `kind`
  # selects the condition value slot (`l`=list, `s`=string, `n`=number,
  # `dt`=datetime), `sensitive` masks the value as `<hashed value>`. Mirrors
  # eval-log.ts COMPARATOR_META.
  @comparator_meta %{
    0 => {"IS ONE OF", :l, false},
    1 => {"IS NOT ONE OF", :l, false},
    2 => {"CONTAINS ANY OF", :l, false},
    3 => {"NOT CONTAINS ANY OF", :l, false},
    4 => {"IS ONE OF", :l, false},
    5 => {"IS NOT ONE OF", :l, false},
    6 => {"<", :s, false},
    7 => {"<=", :s, false},
    8 => {">", :s, false},
    9 => {">=", :s, false},
    10 => {"=", :n, false},
    11 => {"!=", :n, false},
    12 => {"<", :n, false},
    13 => {"<=", :n, false},
    14 => {">", :n, false},
    15 => {">=", :n, false},
    16 => {"IS ONE OF", :l, true},
    17 => {"IS NOT ONE OF", :l, true},
    18 => {"BEFORE", :dt, false},
    19 => {"AFTER", :dt, false},
    20 => {"EQUALS", :s, true},
    21 => {"NOT EQUALS", :s, true},
    22 => {"STARTS WITH ANY OF", :l, true},
    23 => {"NOT STARTS WITH ANY OF", :l, true},
    24 => {"ENDS WITH ANY OF", :l, true},
    25 => {"NOT ENDS WITH ANY OF", :l, true},
    26 => {"ARRAY CONTAINS ANY OF", :l, true},
    27 => {"ARRAY NOT CONTAINS ANY OF", :l, true},
    28 => {"EQUALS", :s, false},
    29 => {"NOT EQUALS", :s, false},
    30 => {"STARTS WITH ANY OF", :l, false},
    31 => {"NOT STARTS WITH ANY OF", :l, false},
    32 => {"ENDS WITH ANY OF", :l, false},
    33 => {"NOT ENDS WITH ANY OF", :l, false},
    34 => {"ARRAY CONTAINS ANY OF", :l, false},
    35 => {"ARRAY NOT CONTAINS ANY OF", :l, false}
  }

  defmodule Builder do
    @moduledoc false
    defstruct chunks: [], indent_level: 0

    @type t :: %__MODULE__{chunks: [String.t()], indent_level: non_neg_integer()}
  end

  @doc "ConfigCat's event id for the config-evaluated INFO line."
  @spec eval_log_event_id() :: String.t()
  def eval_log_event_id, do: @eval_log_event_id

  @doc "A fresh, empty builder."
  @spec new() :: Builder.t()
  def new, do: %Builder{}

  @doc "Append text to the current line."
  @spec append(Builder.t(), String.t()) :: Builder.t()
  def append(%Builder{chunks: chunks} = b, text), do: %{b | chunks: [text | chunks]}

  @doc "Break to a new line at the current indent, then optionally append text."
  @spec new_line(Builder.t(), String.t() | nil) :: Builder.t()
  def new_line(%Builder{indent_level: level, chunks: chunks} = b, text \\ nil) do
    chunks = ["\n" <> String.duplicate(@indent_unit, level) | chunks]
    chunks = if is_nil(text), do: chunks, else: [text | chunks]
    %{b | chunks: chunks}
  end

  @spec increase_indent(Builder.t()) :: Builder.t()
  def increase_indent(%Builder{indent_level: level} = b), do: %{b | indent_level: level + 1}

  @spec decrease_indent(Builder.t()) :: Builder.t()
  def decrease_indent(%Builder{indent_level: level} = b),
    do: %{b | indent_level: max(level - 1, 0)}

  @spec to_string(Builder.t()) :: String.t()
  def to_string(%Builder{chunks: chunks}), do: chunks |> Enum.reverse() |> IO.iodata_to_binary()

  # ---------------------------------------------------------------------------
  # Value formatting
  # ---------------------------------------------------------------------------

  @doc """
  Format a resolved SETTING value for the eval log (ConfigCat parity): boolean
  → `true`/`false` (lowercase), string → verbatim, number → its canonical
  decimal string. Mirrors `settingValueToString` in eval-log.ts.
  """
  @spec setting_value_to_log_string(term()) :: String.t()
  def setting_value_to_log_string(true), do: "true"
  def setting_value_to_log_string(false), do: "false"
  def setting_value_to_log_string(value) when is_binary(value), do: value

  def setting_value_to_log_string(value) when is_number(value),
    do: Comparators.user_attribute_value_to_string(value)

  def setting_value_to_log_string(_), do: ""

  @doc "Render a `UserComparator` as ConfigCat's eval-log operator token."
  @spec format_user_comparator(integer()) :: String.t()
  def format_user_comparator(comparator) do
    case Map.get(@comparator_meta, comparator) do
      {token, _kind, _sensitive} -> token
      _ -> @invalid_operator_placeholder
    end
  end

  # ---------------------------------------------------------------------------
  # User condition rendering
  # ---------------------------------------------------------------------------

  @doc "Render one user condition (`User.<attr> <COMP> <value>`)."
  @spec append_user_condition(Builder.t(), map()) :: Builder.t()
  def append_user_condition(%Builder{} = b, condition) do
    attr = if is_binary(condition["a"]), do: condition["a"], else: @invalid_name_placeholder
    cmp = condition["c"]
    cmp = if is_integer(cmp) and not is_boolean(cmp), do: cmp, else: -1

    case Map.get(@comparator_meta, cmp) do
      nil ->
        append_unknown_user_condition(b, attr, cmp, condition)

      {_token, kind, sensitive} ->
        dispatch_user_condition(b, attr, cmp, kind, sensitive, condition)
    end
  end

  defp dispatch_user_condition(b, attr, cmp, :l, sensitive, condition) do
    lv = condition["l"]
    append_user_condition_string_list(b, attr, cmp, if(is_list(lv), do: lv, else: nil), sensitive)
  end

  defp dispatch_user_condition(b, attr, cmp, :s, sensitive, condition) do
    append_user_condition_string(b, attr, cmp, condition["s"], sensitive)
  end

  defp dispatch_user_condition(b, attr, cmp, :n, _sensitive, condition) do
    append_user_condition_number(b, attr, cmp, condition["d"], false)
  end

  defp dispatch_user_condition(b, attr, cmp, :dt, _sensitive, condition) do
    append_user_condition_number(b, attr, cmp, condition["d"], true)
  end

  # Unknown comparator: fall back to the first present value slot.
  defp append_unknown_user_condition(b, attr, cmp, condition) do
    cond do
      is_binary(condition["s"]) ->
        append_user_condition_core(b, attr, cmp, condition["s"])

      not is_nil(condition["d"]) ->
        append_user_condition_core(
          b,
          attr,
          cmp,
          Comparators.user_attribute_value_to_string(to_float(condition["d"]))
        )

      is_list(condition["l"]) and condition["l"] != [] ->
        append_user_condition_core(b, attr, cmp, Kernel.to_string(hd(condition["l"])))

      true ->
        append_user_condition_core(b, attr, cmp, "")
    end
  end

  defp append_user_condition_core(b, attr, comparator, value) do
    value = if value == "", do: @invalid_value_placeholder, else: value
    append(b, "User.#{attr} #{format_user_comparator(comparator)} '#{value}'")
  end

  defp append_user_condition_string(b, attr, comparator, value, _sensitive)
       when not is_binary(value),
       do: append_user_condition_core(b, attr, comparator, "")

  defp append_user_condition_string(b, attr, comparator, _value, true),
    do: append_user_condition_core(b, attr, comparator, "<hashed value>")

  defp append_user_condition_string(b, attr, comparator, value, false),
    do: append_user_condition_core(b, attr, comparator, value)

  defp append_user_condition_string_list(b, attr, comparator, values, _sensitive)
       when not is_list(values),
       do: append_user_condition_core(b, attr, comparator, "")

  defp append_user_condition_string_list(b, attr, comparator, values, true) do
    comparator_text = format_user_comparator(comparator)
    count = Kernel.length(values)
    word = if count == 1, do: "value", else: "values"
    append(b, "User.#{attr} #{comparator_text} [<#{count} hashed #{word}>]")
  end

  defp append_user_condition_string_list(b, attr, comparator, values, false) do
    comparator_text = format_user_comparator(comparator)
    list_text = format_string_list(values)
    append(b, "User.#{attr} #{comparator_text} [#{list_text}]")
  end

  defp append_user_condition_number(b, attr, comparator, value, _is_datetime)
       when is_nil(value),
       do: append_user_condition_core(b, attr, comparator, "")

  defp append_user_condition_number(b, attr, comparator, value, is_datetime) do
    comparator_text = format_user_comparator(comparator)
    value_text = Comparators.user_attribute_value_to_string(to_float(value))

    if is_datetime do
      case unix_seconds_to_iso(to_float(value)) do
        nil -> append(b, "User.#{attr} #{comparator_text} '#{value_text}'")
        iso -> append(b, "User.#{attr} #{comparator_text} '#{value_text}' (#{iso} UTC)")
      end
    else
      append(b, "User.#{attr} #{comparator_text} '#{value_text}'")
    end
  end

  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_float(v), do: v
  defp to_float(v), do: v

  @doc "Format a string list exactly as configcat-common's `formatStringList`."
  @spec format_string_list([String.t()]) :: String.t()
  def format_string_list([]), do: ""

  def format_string_list(items) do
    length = Kernel.length(items)

    {shown, appendix} =
      if @string_list_max_length > 0 and length > @string_list_max_length do
        count = length - @string_list_max_length
        word = if count == 1, do: "value", else: "values"
        {Enum.take(items, @string_list_max_length), ", ... <#{count} more #{word}>"}
      else
        {items, ""}
      end

    "'" <> Enum.join(shown, "', '") <> "'" <> appendix
  end

  # ---------------------------------------------------------------------------
  # Consequence rendering
  # ---------------------------------------------------------------------------

  @doc "Append a single condition's boolean result (` => true` / ` => false, …`)."
  @spec append_condition_consequence(Builder.t(), boolean()) :: Builder.t()
  def append_condition_consequence(b, result) do
    b = append(b, " => #{bool_to_log_string(result)}")
    if result, do: b, else: append(b, ", skipping the remaining AND conditions")
  end

  @doc """
  Append a targeting rule's THEN consequence. `then_value` is the rule's
  formatted served value for a fixed-value rule, or `nil` for a rule serving
  `% options`. `match` is `:match` / `:no_match` / `{:error, text}`.
  """
  @spec append_targeting_rule_consequence(
          Builder.t(),
          String.t() | nil,
          :match | :no_match | {:error, String.t()},
          boolean()
        ) :: Builder.t()
  def append_targeting_rule_consequence(b, then_value, match, newline) do
    b = increase_indent(b)
    b = if newline, do: new_line(b), else: append(b, " ")
    b = append(b, "THEN")
    b = append(b, if(is_nil(then_value), do: " % options", else: " '#{then_value}'"))
    b = append(b, " => ")

    b =
      case match do
        :match -> append(b, "MATCH, applying rule")
        :no_match -> append(b, "no match")
        {:error, text} -> append(b, text)
      end

    decrease_indent(b)
  end

  @doc "Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`)."
  @spec append_prerequisite_flag_condition(Builder.t(), String.t(), integer(), String.t()) ::
          Builder.t()
  def append_prerequisite_flag_condition(b, prereq_key, comparator, comparison_value) do
    op = if comparator == @prereq_not_equals, do: "NOT EQUALS", else: "EQUALS"
    append(b, "Flag '#{prereq_key}' #{op} '#{comparison_value}'")
  end

  @doc "Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`)."
  @spec append_segment_condition(Builder.t(), String.t(), integer()) :: Builder.t()
  def append_segment_condition(b, segment_name, comparator) do
    op = if comparator == @segment_is_not_in, do: "IS NOT IN SEGMENT", else: "IS IN SEGMENT"
    append(b, "User #{op} '#{segment_name}'")
  end

  @doc "Append a bare boolean condition result (`true` / `false`)."
  @spec append_condition_result(Builder.t(), boolean()) :: Builder.t()
  def append_condition_result(b, result), do: append(b, bool_to_log_string(result))

  defp bool_to_log_string(true), do: "true"
  defp bool_to_log_string(false), do: "false"

  # ---------------------------------------------------------------------------
  # Datetime ISO suffix (JS new Date(value*1000).toISOString())
  # ---------------------------------------------------------------------------

  @doc """
  Render a Unix-seconds value as ConfigCat's eval-log datetime suffix
  (`2023-04-01T00:00:00.000Z`, always millisecond precision, UTC). Returns nil
  for non-finite values, matching the JS `isNaN(date)` guard.
  """
  @spec unix_seconds_to_iso(term()) :: String.t() | nil
  def unix_seconds_to_iso(:nan), do: nil
  def unix_seconds_to_iso(:infinity), do: nil
  def unix_seconds_to_iso(:neg_infinity), do: nil

  def unix_seconds_to_iso(seconds) when is_number(seconds) do
    ms = round(seconds * 1000)
    dt = DateTime.from_unix!(ms, :millisecond)
    millis = Integer.mod(ms, 1000)

    base =
      dt
      |> Calendar.strftime("%Y-%m-%dT%H:%M:%S")

    base <> "." <> String.pad_leading(Integer.to_string(millis), 3, "0") <> "Z"
  end

  def unix_seconds_to_iso(_), do: nil
end
