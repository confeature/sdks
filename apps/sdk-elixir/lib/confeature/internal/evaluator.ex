# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Evaluator do
  @moduledoc """
  ConfigCat-parity flag evaluator (spec 124) — mirrors:
    - `packages/sdk-shared/src/evaluator.ts` (algorithm source of truth)
    - `apps/sdk-python/...`, `apps/sdk-go/...`, `apps/sdk-ruby/...`,
      `apps/sdk-php/...`, `apps/sdk-dart/...` ports.

  The evaluator consumes a parsed `config_v6.json` map (wire shape owned by
  `packages/contract`) plus a `(key, default, user)` tuple and resolves the
  full ConfigCat decision tree: targeting-rule walk (first-match-wins),
  AND-grouped conditions, the 36 user comparators (text / sensitive / semver /
  number / datetime / array), segments (v6 + legacy v5), prerequisite flags
  (incl. multilevel + circular detection), and percentage rollout.

  Result struct (`EvaluationResult`) carries `:value`, `:error` (tier-0 code
  for the fail-closed branches), `:eval_error` (the surfaced no-user /
  missing-attribute / validation message when a value still resolved cleanly),
  `:variation_id`, `:matched_targeting_rule`, and `:matched_percentage_option`.

  Tier-0 error codes (preserved, SC-006):
    NO_CONFIG / MALFORMED_CONFIG / KEY_NOT_FOUND / TYPE_MISMATCH /
    MALFORMED_VALUE / UNSUPPORTED_TYPE / VALUE_NOT_BOOL / EVAL_EXCEPTION.

  Fail-closed (FR-012): the function NEVER raises. Any internal exception —
  including a detected circular prerequisite dependency — is caught and
  converted to a fail-closed result with `error: "EVAL_EXCEPTION"`. Cycle
  detection uses an IMMUTABLE `visited_flags` accumulator threaded through
  recursion, so the cycle is bounded with no mutable stack.
  """

  alias Confeature.Internal.{Comparators, EvalLog, EvalLogger, Prerequisites, Segments}
  alias Confeature.Internal.Prerequisites.CircularDependencyError
  alias Confeature.User

  @setting_type_bool 0
  @setting_type_string 1
  @setting_type_int 2
  @setting_type_double 3

  @missing_user_error "cannot evaluate, User Object is missing"

  defmodule EvaluationResult do
    @moduledoc false
    defstruct [
      :value,
      :error,
      :eval_error,
      :variation_id,
      :matched_targeting_rule,
      :matched_percentage_option
    ]

    @type t :: %__MODULE__{
            value: any(),
            error: String.t() | nil,
            eval_error: String.t() | nil,
            variation_id: String.t() | nil,
            matched_targeting_rule: map() | nil,
            matched_percentage_option: map() | nil
          }

    @spec ok?(t()) :: boolean()
    def ok?(%__MODULE__{error: nil}), do: true
    def ok?(%__MODULE__{}), do: false
  end

  # Per-evaluation mutable-via-process-dict-free context. `visited_flags` is the
  # immutable cycle-detection accumulator (extended per recursion level).
  #
  # `log` + `log_builder` are the eval-log trace seam (ADR 0003), present only
  # when an INFO-enabled trace logger is attached; `log_builder` is `nil` on the
  # zero-cost hot path. Because Elixir is immutable the builder is THREADED — the
  # engine functions return the updated context (carrying the updated builder)
  # alongside their result. `missing_user_logged` dedups the no-user WARN 3001 to
  # once per context (a prerequisite flag evaluates in its OWN context, so a
  # prereq referenced by N rules logs it N times).
  defmodule Context do
    @moduledoc false
    defstruct [
      :key,
      :setting,
      :settings,
      :segments,
      :config_salt,
      :user,
      :visited_flags,
      :log,
      :log_builder,
      missing_user_logged: false
    ]
  end

  @doc """
  Resolve `key` against `config`. Fail-closed to `default_value`; never raises.
  """
  @spec evaluate(map() | nil, String.t(), any(), any()) :: EvaluationResult.t()
  def evaluate(config, key, default_value, user \\ nil) do
    evaluate_traced(config, key, default_value, user, nil)
  end

  @doc """
  `evaluate` with an optional trace sink. When the sink is INFO-enabled it
  drives the ConfigCat byte-identical evaluation-log trace: the WARN
  3001/3003/3004 + ERROR 1002 lines emitted during the walk, and the final INFO
  5000 multi-line indented trace (ADR 0003 / epic #494). A `nil` sink (the hot
  path) is zero-cost — identical to `evaluate/4`.
  """
  @spec evaluate_traced(map() | nil, String.t(), any(), any(), term() | nil) ::
          EvaluationResult.t()
  def evaluate_traced(config, key, default_value, user \\ nil, sink \\ nil)

  def evaluate_traced(nil, _key, default_value, _user, _sink) do
    %EvaluationResult{value: default_value, error: "NO_CONFIG"}
  end

  def evaluate_traced(config, key, default_value, user, sink) when is_map(config) do
    log = EvalLogger.new(sink)
    do_evaluate(config, key, default_value, user, log)
  rescue
    e in CircularDependencyError ->
      # A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
      # (naming the setting + the chain), not the generic evaluation-error path.
      EvalLogger.circular_dependency(EvalLogger.new(sink), key, e.cycle || "")
      %EvaluationResult{value: default_value, error: "EVAL_EXCEPTION"}

    _ ->
      %EvaluationResult{value: default_value, error: "EVAL_EXCEPTION"}
  end

  def evaluate_traced(_config, _key, default_value, _user, _sink) do
    %EvaluationResult{value: default_value, error: "MALFORMED_CONFIG"}
  end

  defp do_evaluate(config, key, default_value, user, log) do
    case Map.get(config, "f") do
      settings when is_map(settings) ->
        resolve_setting(config, settings, key, default_value, user, log)

      _ ->
        %EvaluationResult{value: default_value, error: "MALFORMED_CONFIG"}
    end
  end

  defp resolve_setting(config, settings, key, default_value, user, log) do
    case Map.get(settings, key) do
      nil ->
        %EvaluationResult{value: default_value, error: "KEY_NOT_FOUND"}

      setting when is_map(setting) ->
        dispatch_by_type(config, settings, setting, key, default_value, user, log)

      _ ->
        %EvaluationResult{value: default_value, error: "MALFORMED_CONFIG"}
    end
  end

  defp dispatch_by_type(config, settings, setting, key, default_value, user, log) do
    type = Map.get(setting, "t")

    if type in [@setting_type_bool, @setting_type_string, @setting_type_int, @setting_type_double] do
      ctx = build_context(config, settings, setting, key, user, log)

      {ctx, {envelope, variation_id, matched_rule, matched_option, eval_error}} =
        evaluate_setting(ctx)

      result =
        resolve_envelope(
          setting,
          envelope,
          variation_id,
          matched_rule,
          matched_option,
          eval_error,
          default_value
        )

      emit_trace(ctx, result)
      result
    else
      %EvaluationResult{value: default_value, error: "UNSUPPORTED_TYPE"}
    end
  end

  # Footer + emit. The INFO 5000 trace is emitted only when the resolved value
  # is clean (no error); a type/value error fails closed without a footer
  # (matching evaluator.ts, which emits after the value guard).
  defp emit_trace(%Context{log_builder: nil}, _result), do: :ok
  defp emit_trace(%Context{}, %EvaluationResult{error: error}) when not is_nil(error), do: :ok

  defp emit_trace(%Context{log: log, log_builder: lb}, %EvaluationResult{value: value}) do
    lb = EvalLog.new_line(lb, "Returning '#{EvalLog.setting_value_to_log_string(value)}'.")
    EvalLogger.info(log, EvalLog.eval_log_event_id(), EvalLog.to_string(lb))
  end

  defp build_context(config, settings, setting, key, user, log) do
    log_builder =
      if EvalLogger.enabled?(log, EvalLogger.info_level()) do
        EvalLog.new()
        |> EvalLog.append("Evaluating '#{key}'")
        |> append_user_header(user)
      end

    %Context{
      key: key,
      setting: setting,
      settings: settings,
      segments: Map.get(config, "s", []) || [],
      config_salt: get_in(config, ["p", "s"]) || "",
      user: user,
      visited_flags: [],
      log: log,
      log_builder: log_builder,
      missing_user_logged: false
    }
  end

  defp append_user_header(builder, nil), do: builder

  defp append_user_header(builder, %User{} = user),
    do: EvalLog.append(builder, " for User '#{user_attributes_for_log_json(user)}'")

  # Render the user's attributes as the eval-log header shows them — a
  # Confeature-canonical object `{Identifier, Email?, Country?, …custom}`
  # JSON-serialized (compact, JS-JSON escaping) to the `for User '…'` token,
  # mirroring `JSON.stringify(userAttributesForLog(user))`.
  defp user_attributes_for_log_json(%User{} = user) do
    parts =
      ["\"Identifier\":#{js_json_string(user_identifier(user))}"]
      |> maybe_attr("Email", user.email)
      |> maybe_attr("Country", user.country)
      |> append_custom_attrs(user.custom)

    "{#{Enum.join(Enum.reverse(parts), ",")}}"
  end

  defp maybe_attr(parts, _name, nil), do: parts

  defp maybe_attr(parts, name, value),
    do: ["\"#{name}\":#{js_json_string(value)}" | parts]

  defp append_custom_attrs(parts, custom) when is_map(custom) do
    Enum.reduce(custom, parts, fn {name, value}, acc ->
      [
        "#{js_json_string(name)}:#{js_json_string(Comparators.user_attribute_value_to_string(value))}"
        | acc
      ]
    end)
  end

  defp append_custom_attrs(parts, _custom), do: parts

  # Serialize a string exactly as ECMAScript `JSON.stringify` of a string.
  defp js_json_string(str) do
    escaped = str |> String.to_charlist() |> Enum.map_join(&js_json_escape_char/1)
    "\"" <> escaped <> "\""
  end

  defp js_json_escape_char(?"), do: "\\\""
  defp js_json_escape_char(?\\), do: "\\\\"
  defp js_json_escape_char(?\b), do: "\\b"
  defp js_json_escape_char(?\t), do: "\\t"
  defp js_json_escape_char(?\n), do: "\\n"
  defp js_json_escape_char(?\f), do: "\\f"
  defp js_json_escape_char(?\r), do: "\\r"

  defp js_json_escape_char(c) when c < 0x20 do
    hex = c |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(4, "0")
    "\\u" <> hex
  end

  defp js_json_escape_char(c), do: <<c::utf8>>

  # Select the resolved envelope's typed value via the EXISTING per-type guards
  # (TYPE_MISMATCH / VALUE_NOT_BOOL / MALFORMED_VALUE preserved, SC-006). On a
  # clean resolution the surfaced `eval_error` (no-user / missing-attr /
  # validation) is attached as `:eval_error` (value is correct, message
  # informational — FR-016).
  defp resolve_envelope(
         setting,
         envelope,
         variation_id,
         matched_rule,
         matched_option,
         eval_error,
         default_value
       ) do
    value_slot = envelope || %{}

    base =
      if is_nil(default_value) do
        # A `nil` default bypasses the type check (mirrors the TS reference +
        # configcat): select the value by the setting's declared type. Used by
        # the variation-id matrix, which evaluates with no caller default.
        %EvaluationResult{value: select_setting_value(value_slot, Map.get(setting, "t"))}
      else
        case Map.get(setting, "t") do
          @setting_type_bool -> resolve_bool(value_slot, default_value)
          @setting_type_string -> resolve_string(value_slot, default_value)
          @setting_type_int -> resolve_int(value_slot, default_value)
          @setting_type_double -> resolve_double(value_slot, default_value)
        end
      end

    if is_nil(base.error) do
      %EvaluationResult{
        base
        | variation_id: variation_id || fallback_variation_id(setting),
          matched_targeting_rule: matched_rule,
          matched_percentage_option: matched_option,
          eval_error: eval_error
      }
    else
      base
    end
  end

  defp resolve_bool(value_slot, default_value) do
    if is_boolean(default_value) do
      case Map.get(value_slot, "b") do
        bool when is_boolean(bool) -> %EvaluationResult{value: bool}
        _ -> %EvaluationResult{value: default_value, error: "VALUE_NOT_BOOL"}
      end
    else
      %EvaluationResult{value: default_value, error: "TYPE_MISMATCH"}
    end
  end

  defp resolve_string(value_slot, default_value) do
    if is_binary(default_value) do
      case Map.get(value_slot, "s") do
        s when is_binary(s) -> %EvaluationResult{value: s}
        _ -> %EvaluationResult{value: default_value, error: "MALFORMED_VALUE"}
      end
    else
      %EvaluationResult{value: default_value, error: "TYPE_MISMATCH"}
    end
  end

  # Both Int (2) and Double (3) settings map to the canonical "number"
  # expected type (TS `EXPECTED_JS_TYPE` — JS has a single `number` kind),
  # so the TYPE_MISMATCH guard accepts ANY numeric default (int OR float),
  # never just the wire-matching kind. A `true`/`false` default is NOT a
  # number (Elixir booleans are not integers) and still TYPE_MISMATCHes.
  # The served value is returned with its own wire type preserved.
  defp resolve_int(value_slot, default_value) do
    if number?(default_value) do
      case Map.get(value_slot, "i") do
        i when is_integer(i) -> %EvaluationResult{value: i}
        _ -> %EvaluationResult{value: default_value, error: "MALFORMED_VALUE"}
      end
    else
      %EvaluationResult{value: default_value, error: "TYPE_MISMATCH"}
    end
  end

  defp resolve_double(value_slot, default_value) do
    if number?(default_value) do
      case Map.get(value_slot, "d") do
        # The wire `d` slot is a JSON number; Jason decodes a whole value
        # like `0` to an Elixir integer and a fractional one to a float.
        # Both are valid Double-setting values (canonical TS has a single
        # `number` type) — accept either, never MALFORMED_VALUE on a
        # whole-number double.
        d when is_number(d) -> %EvaluationResult{value: d}
        _ -> %EvaluationResult{value: default_value, error: "MALFORMED_VALUE"}
      end
    else
      %EvaluationResult{value: default_value, error: "TYPE_MISMATCH"}
    end
  end

  # A number is an integer or float but NOT a boolean (Elixir's `is_number`
  # already excludes booleans, but the explicit guard documents the intent
  # and parries any future refactor).
  defp number?(value), do: is_number(value) and not is_boolean(value)

  defp fallback_variation_id(setting) do
    case Map.get(setting, "i") do
      id when is_binary(id) -> id
      _ -> nil
    end
  end

  # ===========================================================================
  # Setting-evaluation engine — returns
  #   {ctx, {envelope, variation_id, matched_rule, matched_option, eval_error}}
  #
  # Elixir is immutable: the builder + the missing-user dedup live in `ctx`, so
  # every engine function THREADS and RETURNS the updated `ctx`. The surfaced
  # `eval_error` is threaded in a separate `err` accumulator. The engine raises
  # (cycle / malformed reference) only to be caught by the outer fail-closed
  # `rescue`.
  # ===========================================================================

  defp evaluate_setting(%Context{} = ctx) do
    {ctx, result, eval_error} = evaluate_setting_inner(ctx, nil)
    {envelope, variation_id, matched_rule, matched_option} = result
    {ctx, {envelope, variation_id, matched_rule, matched_option, eval_error}}
  end

  # Internal evaluation used both at the top level and during prerequisite
  # recursion. Threads the surfaced `eval_error` + the builder/ctx through.
  # Returns `{ctx, {envelope, vid, rule, option}, eval_error}`.
  defp evaluate_setting_inner(%Context{setting: setting} = ctx, eval_error) do
    rules = Map.get(setting, "r", []) || []

    case evaluate_targeting_rules(rules, ctx, eval_error) do
      {:matched, ctx, result, err} ->
        {ctx, result, err}

      {:nomatch, ctx, err} ->
        options = Map.get(setting, "p", []) || []

        case evaluate_percentage_options(options, nil, ctx, err) do
          {:matched, ctx, result, err2} ->
            {ctx, result, err2}

          {:skip, ctx, err2} ->
            {ctx, {Map.get(setting, "v"), fallback_variation_id(setting), nil, nil}, err2}
        end
    end
  end

  defp evaluate_targeting_rules([], ctx, eval_error), do: {:nomatch, ctx, eval_error}

  defp evaluate_targeting_rules(rules, ctx, eval_error) do
    ctx = trace_new_line(ctx, "Evaluating targeting rules and applying the first match if any:")

    Enum.reduce_while(rules, {:nomatch, ctx, eval_error}, fn rule, {:nomatch, ctx, err} ->
      conditions = Map.get(rule, "c", []) || []

      case evaluate_conditions(conditions, ctx.key, ctx, err, rule) do
        {true, ctx, err2} ->
          handle_matched_rule(rule, ctx, err2)

        {outcome, ctx, err2} ->
          # A rule whose conditions ERRORED (missing user/attr) is ignored and
          # evaluation continues — ConfigCat emits this trace line. A rule that
          # merely did NOT match (false) just continues, with no such line.
          ctx = trace_rule_ignored(ctx, outcome)
          {:cont, {:nomatch, ctx, err2}}
      end
    end)
  end

  defp handle_matched_rule(rule, ctx, err) do
    case Map.get(rule, "s") do
      %{} = served ->
        {:halt, {:matched, ctx, {Map.get(served, "v"), Map.get(served, "i"), rule, nil}, err}}

      _ ->
        options = Map.get(rule, "p", []) || []
        # A rule serving % options: the block is traced one level deeper.
        ctx = trace_increase_indent(ctx)

        case evaluate_percentage_options(options, rule, ctx, err) do
          {:matched, ctx, result, err2} ->
            ctx = trace_decrease_indent(ctx)
            {:halt, {:matched, ctx, result, err2}}

          # % options not resolvable (no user / missing attr) → ignore rule.
          {:skip, ctx, err2} ->
            ctx =
              ctx
              |> trace_new_line(
                "The current targeting rule is ignored and the evaluation continues with the next rule."
              )
              |> trace_decrease_indent()

            {:cont, {:nomatch, ctx, err2}}
        end
    end
  end

  # Returns {:matched, ctx, {envelope, vid, rule, option}, err} | {:skip, ctx, err}.
  defp evaluate_percentage_options([], _matched_rule, ctx, err), do: {:skip, ctx, err}

  defp evaluate_percentage_options(_options, _matched_rule, %Context{user: nil} = ctx, err) do
    ctx = surface_missing_user(ctx)
    ctx = trace_new_line(ctx, "Skipping % options because the User Object is missing.")
    {:skip, ctx, surface_missing_user_err(err)}
  end

  defp evaluate_percentage_options(options, matched_rule, %Context{} = ctx, err) do
    {attr_name, attr_value} = percentage_keying_attribute(ctx)

    if is_nil(attr_value) do
      ctx = log_percentage_attr_missing(ctx, attr_name)

      ctx =
        trace_new_line(
          ctx,
          "Skipping % options because the User.#{attr_name} attribute is missing."
        )

      {:skip, ctx, err || missing_attribute_error(attr_name)}
    else
      bucket =
        Comparators.user_attribute_value_to_string(attr_value)
        |> then(&Confeature.Internal.Hashing.percentage_bucket(ctx.key, &1))

      ctx = trace_percentage_header(ctx, attr_name, bucket)
      pick_percentage_option(options, bucket, matched_rule, ctx, err)
    end
  end

  defp log_percentage_attr_missing(%Context{log_builder: nil} = ctx, _attr_name), do: ctx

  defp log_percentage_attr_missing(%Context{} = ctx, attr_name) do
    EvalLogger.user_object_attribute_is_missing_for_percentage(ctx.log, ctx.key, attr_name)
    ctx
  end

  defp trace_percentage_header(%Context{log_builder: nil} = ctx, _attr_name, _bucket), do: ctx

  defp trace_percentage_header(%Context{log_builder: lb} = ctx, attr_name, bucket) do
    lb =
      lb
      |> EvalLog.new_line("Evaluating % options based on the User.#{attr_name} attribute:")
      |> EvalLog.new_line(
        "- Computing hash in the [0..99] range from User.#{attr_name} => #{bucket} " <>
          "(this value is sticky and consistent across all SDKs)"
      )

    %{ctx | log_builder: lb}
  end

  defp pick_percentage_option(options, bucket, matched_rule, ctx, err) do
    result =
      Enum.reduce_while(options, {nil, 0, 0}, fn option, {_acc, acc_bucket, index} ->
        width = Map.get(option, "p") || 0
        next = acc_bucket + width

        if bucket < next do
          {:halt, {option, index, width}}
        else
          {:cont, {nil, next, index + 1}}
        end
      end)

    case result do
      {nil, _, _} ->
        # Sum of widths < 100 — malformed config. Raise to fail-closed frame.
        raise "Sum of percentage option percentages is less than 100."

      {option, index, width} ->
        ctx = trace_percentage_selection(ctx, bucket, index, width, option)
        {:matched, ctx, {Map.get(option, "v"), Map.get(option, "i"), matched_rule, option}, err}
    end
  end

  defp trace_percentage_selection(%Context{log_builder: nil} = ctx, _b, _i, _w, _opt), do: ctx

  defp trace_percentage_selection(
         %Context{log_builder: lb, setting: setting} = ctx,
         bucket,
         index,
         width,
         option
       ) do
    setting_type = Map.get(setting, "t")

    if is_integer(setting_type) and not is_boolean(setting_type) do
      selected = select_setting_value(Map.get(option, "v"), setting_type)

      lb =
        EvalLog.new_line(
          lb,
          "- Hash value #{bucket} selects % option #{index + 1} (#{width}%), " <>
            "'#{EvalLog.setting_value_to_log_string(selected)}'."
        )

      %{ctx | log_builder: lb}
    else
      ctx
    end
  end

  defp percentage_keying_attribute(%Context{setting: setting, user: user}) do
    case Map.get(setting, "a") do
      nil -> {"Identifier", user_identifier(user)}
      attr_name -> {attr_name, user_attribute(user, attr_name)}
    end
  end

  defp user_identifier(%User{identifier: id}) when is_binary(id), do: id
  defp user_identifier(_), do: ""

  # ===========================================================================
  # Conditions
  # ===========================================================================

  # Evaluate a rule's (or segment's) AND-grouped condition list. `rule` is the
  # owning targeting rule (nil for a bare segment list); when present and tracing
  # is on, the rule's THEN consequence is appended after the AND group. Returns
  # `{outcome, ctx, err}`.
  defp evaluate_conditions(conditions, context_salt, ctx, err, rule) do
    ctx = trace_new_line(ctx, "- ")

    {outcome, ctx, err} =
      conditions
      |> Enum.with_index()
      |> Enum.reduce_while({true, ctx, err}, fn {condition, i}, {_acc, ctx, acc_err} ->
        ctx = trace_condition_prefix(ctx, i)
        {outcome, ctx, next_err} = evaluate_condition(condition, context_salt, ctx, acc_err)
        ctx = trace_condition_consequence(ctx, outcome)

        if outcome == true do
          {:cont, {true, ctx, next_err}}
        else
          {:halt, {outcome, ctx, next_err}}
        end
      end)

    ctx = trace_rule_consequence(ctx, rule, conditions, outcome)
    {outcome, ctx, err}
  end

  defp trace_condition_prefix(%Context{log_builder: nil} = ctx, _index), do: ctx

  defp trace_condition_prefix(%Context{log_builder: lb} = ctx, 0) do
    %{ctx | log_builder: lb |> EvalLog.append("IF ") |> EvalLog.increase_indent()}
  end

  defp trace_condition_prefix(%Context{log_builder: lb} = ctx, _index) do
    %{ctx | log_builder: lb |> EvalLog.increase_indent() |> EvalLog.new_line("AND ")}
  end

  defp trace_condition_consequence(%Context{log_builder: nil} = ctx, _outcome), do: ctx

  defp trace_condition_consequence(%Context{log_builder: lb} = ctx, outcome) do
    lb =
      lb
      |> EvalLog.append_condition_consequence(outcome == true)
      |> EvalLog.decrease_indent()

    %{ctx | log_builder: lb}
  end

  defp trace_rule_consequence(%Context{log_builder: nil} = ctx, _rule, _conditions, _outcome),
    do: ctx

  defp trace_rule_consequence(ctx, nil, _conditions, _outcome), do: ctx

  defp trace_rule_consequence(%Context{log_builder: lb} = ctx, rule, conditions, outcome) do
    {then_value, has_then} = rule_then_value(rule, ctx)

    match =
      case outcome do
        true -> :match
        false -> :no_match
        {:error, msg} -> {:error, msg}
      end

    lb =
      EvalLog.append_targeting_rule_consequence(
        lb,
        if(has_then, do: then_value, else: nil),
        match,
        conditions != []
      )

    %{ctx | log_builder: lb}
  end

  defp rule_then_value(rule, %Context{setting: setting}) do
    case Map.get(rule, "s") do
      %{} = served ->
        setting_type = Map.get(setting, "t")

        if is_integer(setting_type) and not is_boolean(setting_type) do
          value = select_setting_value(Map.get(served, "v"), setting_type)
          {EvalLog.setting_value_to_log_string(value), true}
        else
          {nil, false}
        end

      _ ->
        {nil, false}
    end
  end

  defp evaluate_condition(condition, context_salt, ctx, err) do
    cond do
      is_map(Map.get(condition, "u")) ->
        evaluate_user_condition(Map.get(condition, "u"), context_salt, ctx, err)

      is_map(Map.get(condition, "p")) ->
        {outcome, ctx} = evaluate_prerequisite_condition(Map.get(condition, "p"), ctx)
        {outcome, ctx, err}

      is_map(Map.get(condition, "s")) ->
        evaluate_segment_condition(Map.get(condition, "s"), ctx, err)

      true ->
        {{:error, "empty condition"}, ctx, err}
    end
  end

  # Returns {outcome, ctx, err}. outcome ∈ true | false | {:error, msg}.
  defp evaluate_user_condition(condition, context_salt, ctx, err) do
    ctx = trace_user_condition(ctx, condition)

    cond do
      is_nil(ctx.user) ->
        ctx = surface_missing_user(ctx)
        {{:error, @missing_user_error}, ctx, surface_missing_user_err(err)}

      true ->
        attr_name = Map.get(condition, "a")
        attr_value = user_attribute(ctx.user, attr_name)

        if is_nil(attr_value) or attr_value == "" do
          msg = missing_attribute_error(attr_name)
          ctx = log_attribute_missing(ctx, attr_name)
          {{:error, msg}, ctx, err || msg}
        else
          outcome = dispatch_comparator(condition, attr_name, attr_value, context_salt, ctx)
          ctx = surface_outcome_error_log(outcome, ctx)
          next_err = surface_outcome_error(outcome, err)
          {outcome, ctx, next_err}
        end
    end
  end

  defp trace_user_condition(%Context{log_builder: nil} = ctx, _condition), do: ctx

  defp trace_user_condition(%Context{log_builder: lb} = ctx, condition),
    do: %{ctx | log_builder: EvalLog.append_user_condition(lb, condition)}

  defp log_attribute_missing(%Context{log_builder: nil} = ctx, _attr_name), do: ctx

  defp log_attribute_missing(%Context{} = ctx, attr_name) do
    EvalLogger.user_object_attribute_is_missing(ctx.log, ctx.key, to_string(attr_name))
    ctx
  end

  # Surface + log the typed validation / malformed-operand outcomes the trace
  # replays. An attribute-invalid error → WARN 3004; a malformed config operand
  # (#509, `comparison value '<v>' is invalid (<reason>)`) → WARN 3004 without
  # the "please check…" suffix.
  defp surface_outcome_error_log(_outcome, %Context{log_builder: nil} = ctx), do: ctx

  defp surface_outcome_error_log({:error, msg}, %Context{} = ctx) do
    case Regex.run(~r/^cannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)$/u, msg) do
      [_, attr, reason] ->
        EvalLogger.user_object_attribute_is_invalid(ctx.log, ctx.key, attr, reason)

      _ ->
        if String.starts_with?(msg, "comparison value '") do
          EvalLogger.comparison_value_is_invalid(ctx.log, ctx.key, msg)
        end
    end

    ctx
  end

  defp surface_outcome_error_log(_outcome, ctx), do: ctx

  defp dispatch_comparator(condition, attr_name, attr_value, context_salt, ctx) do
    cmp = Map.get(condition, "c")
    list = Map.get(condition, "l", []) || []
    sv = Map.get(condition, "s", "") || ""
    raw_dv = Map.get(condition, "d")
    dv = raw_dv || 0
    salt = ctx.config_salt

    text = fn -> Comparators.attribute_as_text(attr_value) end

    case cmp do
      0 ->
        Comparators.text_is_one_of(text.(), list, false)

      1 ->
        Comparators.text_is_one_of(text.(), list, true)

      2 ->
        Comparators.text_contains_any_of(text.(), list, false)

      3 ->
        Comparators.text_contains_any_of(text.(), list, true)

      c when c in [4, 5] ->
        semver_set(attr_name, attr_value, list, c == 5)

      c when c in [6, 7, 8, 9] ->
        semver_rel(attr_name, attr_value, c, sv)

      c when c in [10, 11, 12, 13, 14, 15] ->
        number_cmp(attr_name, attr_value, c, dv, raw_dv)

      16 ->
        Comparators.sensitive_text_is_one_of(text.(), list, salt, context_salt, false)

      17 ->
        Comparators.sensitive_text_is_one_of(text.(), list, salt, context_salt, true)

      c when c in [18, 19] ->
        datetime_cmp(attr_name, attr_value, dv, raw_dv, c == 18)

      20 ->
        Comparators.sensitive_text_equals(text.(), sv, salt, context_salt, false)

      21 ->
        Comparators.sensitive_text_equals(text.(), sv, salt, context_salt, true)

      22 ->
        Comparators.sensitive_text_slice_equals_any_of(
          text.(),
          list,
          salt,
          context_salt,
          true,
          false
        )

      23 ->
        Comparators.sensitive_text_slice_equals_any_of(
          text.(),
          list,
          salt,
          context_salt,
          true,
          true
        )

      24 ->
        Comparators.sensitive_text_slice_equals_any_of(
          text.(),
          list,
          salt,
          context_salt,
          false,
          false
        )

      25 ->
        Comparators.sensitive_text_slice_equals_any_of(
          text.(),
          list,
          salt,
          context_salt,
          false,
          true
        )

      c when c in [26, 27] ->
        sensitive_array_cmp(attr_name, attr_value, list, salt, context_salt, c == 27)

      28 ->
        Comparators.text_equals(text.(), sv, false)

      29 ->
        Comparators.text_equals(text.(), sv, true)

      30 ->
        Comparators.text_slice_equals_any_of(text.(), list, true, false)

      31 ->
        Comparators.text_slice_equals_any_of(text.(), list, true, true)

      32 ->
        Comparators.text_slice_equals_any_of(text.(), list, false, false)

      33 ->
        Comparators.text_slice_equals_any_of(text.(), list, false, true)

      c when c in [34, 35] ->
        array_cmp(attr_name, attr_value, list, c == 35)

      _ ->
        {:error, "unknown comparator #{inspect(cmp)}"}
    end
  end

  defp semver_set(attr_name, attr_value, list, negate) do
    case Comparators.attribute_as_semver(attr_name, attr_value) do
      {:ok, v} -> Comparators.semver_is_one_of(v, list, negate)
      {:error, _} = e -> e
    end
  end

  # configcat-common validates the CONFIG comparison value BEFORE the user
  # attribute for the semver / number / datetime relations (#509): a malformed
  # operand wins even when the attribute is also malformed.
  defp semver_rel(attr_name, attr_value, cmp, sv) do
    with {:ok, _cv} <- Comparators.comparison_value_as_semver(sv),
         {:ok, v} <- Comparators.attribute_as_semver(attr_name, attr_value) do
      Comparators.semver_relation(v, cmp, sv)
    end
  end

  defp number_cmp(attr_name, attr_value, cmp, dv, raw_dv) do
    with {:ok, _cv} <- Comparators.comparison_value_as_number(raw_dv),
         {:ok, n} <- Comparators.attribute_as_number(attr_name, attr_value) do
      Comparators.number_relation(n, cmp, dv)
    end
  end

  defp datetime_cmp(attr_name, attr_value, dv, raw_dv, before) do
    with {:ok, _cv} <- Comparators.comparison_value_as_unix_seconds(raw_dv),
         {:ok, s} <- Comparators.attribute_as_unix_seconds(attr_name, attr_value) do
      Comparators.datetime_relation(s, dv, before)
    end
  end

  defp array_cmp(attr_name, attr_value, list, negate) do
    case Comparators.attribute_as_string_array(attr_name, attr_value) do
      {:ok, arr} -> Comparators.array_contains_any_of(arr, list, negate)
      {:error, _} = e -> e
    end
  end

  defp sensitive_array_cmp(attr_name, attr_value, list, salt, context_salt, negate) do
    case Comparators.attribute_as_string_array(attr_name, attr_value) do
      {:ok, arr} ->
        Comparators.sensitive_array_contains_any_of(arr, list, salt, context_salt, negate)

      {:error, _} = e ->
        e
    end
  end

  # ---------------------------------------------------------------------------
  # Prerequisite-flag conditions
  # ---------------------------------------------------------------------------

  # Returns {outcome, ctx}.
  defp evaluate_prerequisite_condition(condition, %Context{} = ctx) do
    ctx = trace_prerequisite_condition(ctx, condition)

    {outcome, ctx} =
      Prerequisites.evaluate(
        condition,
        ctx.key,
        ctx.visited_flags,
        fn key -> prereq_type(ctx.settings, key) end,
        fn key, extended, acc -> reeval_prerequisite(acc, key, extended) end,
        &select_setting_value/2,
        ctx
      )

    {outcome, ctx}
  end

  defp trace_prerequisite_condition(%Context{log_builder: nil} = ctx, _condition), do: ctx

  defp trace_prerequisite_condition(%Context{log_builder: lb} = ctx, condition) do
    prereq_key = Map.get(condition, "f")

    cmp_text =
      if is_binary(prereq_key) do
        case prereq_type(ctx.settings, prereq_key) do
          nil ->
            ""

          pt ->
            case select_setting_value(Map.get(condition, "v"), pt) do
              nil -> ""
              cmp_val -> EvalLog.setting_value_to_log_string(cmp_val)
            end
        end
      else
        ""
      end

    cmp = Map.get(condition, "c")

    lb =
      EvalLog.append_prerequisite_flag_condition(
        lb,
        if(is_binary(prereq_key), do: prereq_key, else: ""),
        if(is_integer(cmp) and not is_boolean(cmp), do: cmp, else: -1),
        cmp_text
      )

    %{ctx | log_builder: lb}
  end

  defp prereq_type(settings, key) do
    case Map.get(settings, key) do
      %{} = setting -> Map.get(setting, "t")
      _ -> nil
    end
  end

  # Re-evaluate a prerequisite flag in a CHILD context sharing the same
  # settings / segments / salt / user and the SAME visited stack, but a FRESH
  # `missing_user_logged` (a prereq evaluates in its OWN context, so a prereq
  # referenced by N rules logs the no-user WARN N times). Returns
  # `{envelope, parent_ctx}` with the parent's builder advanced by the nested
  # `( … )` block.
  defp reeval_prerequisite(%Context{} = ctx, key, extended_visited) do
    prereq_setting = Map.get(ctx.settings, key)

    if is_nil(prereq_setting), do: raise("Prerequisite flag is missing or invalid.")

    parent_lb = trace_prereq_open(ctx, key)

    child_ctx = %Context{
      key: key,
      setting: prereq_setting,
      settings: ctx.settings,
      segments: ctx.segments,
      config_salt: ctx.config_salt,
      user: ctx.user,
      visited_flags: extended_visited,
      log: ctx.log,
      log_builder: parent_lb,
      missing_user_logged: false
    }

    {child_ctx, {envelope, _vid, _rule, _option}, _err} = evaluate_setting_inner(child_ctx, nil)
    ctx = trace_prereq_close(ctx, child_ctx.log_builder, key, envelope)
    {envelope, ctx}
  end

  defp trace_prereq_open(%Context{log_builder: nil}, _key), do: nil

  defp trace_prereq_open(%Context{log_builder: lb} = ctx, key) do
    lb =
      lb
      |> EvalLog.new_line("(")
      |> EvalLog.increase_indent()
      |> EvalLog.new_line("Evaluating '#{key}'")

    if is_nil(ctx.user) do
      lb
    else
      EvalLog.append(lb, " for User '#{user_attributes_for_log_json(ctx.user)}'")
    end
  end

  defp trace_prereq_close(%Context{log_builder: nil} = ctx, _child_lb, _key, _envelope), do: ctx

  defp trace_prereq_close(%Context{} = ctx, child_lb, key, envelope) do
    declared_type = prereq_type(ctx.settings, key)

    child_value =
      if is_nil(declared_type), do: nil, else: select_setting_value(envelope, declared_type)

    lb =
      child_lb
      |> EvalLog.new_line("Returning '#{EvalLog.setting_value_to_log_string(child_value)}'.")
      |> EvalLog.decrease_indent()
      |> EvalLog.new_line(")")

    %{ctx | log_builder: lb}
  end

  # Select the typed primitive from an envelope by SettingType.
  defp select_setting_value(nil, _type), do: nil

  defp select_setting_value(envelope, @setting_type_bool), do: Map.get(envelope, "b")
  defp select_setting_value(envelope, @setting_type_string), do: Map.get(envelope, "s")
  defp select_setting_value(envelope, @setting_type_int), do: Map.get(envelope, "i")
  defp select_setting_value(envelope, @setting_type_double), do: Map.get(envelope, "d")
  defp select_setting_value(_envelope, _type), do: nil

  # ---------------------------------------------------------------------------
  # Segment conditions
  # ---------------------------------------------------------------------------

  # Returns {outcome, ctx, err}. On the no-trace hot path this delegates to
  # `Segments.evaluate` unchanged. When tracing is on it ports
  # `evaluator.ts::evaluateSegmentCondition` incl. its nested `( … )` block.
  defp evaluate_segment_condition(condition, %Context{log_builder: nil} = ctx, err) do
    eval_uc = fn uc, context_salt, acc_err ->
      {outcome, _ctx, next_err} = evaluate_user_condition(uc, context_salt, ctx, acc_err)
      {outcome, next_err}
    end

    surface_missing = fn acc_err -> surface_missing_user_err(acc_err) end

    {outcome, err} =
      Segments.evaluate(
        condition,
        ctx.segments,
        not is_nil(ctx.user),
        surface_missing,
        eval_uc,
        err
      )

    ctx = if outcome == {:error, @missing_user_error}, do: surface_missing_user(ctx), else: ctx
    {outcome, ctx, err}
  end

  defp evaluate_segment_condition(condition, %Context{} = ctx, err) do
    {segment, segment_name} = resolve_segment(condition, ctx)
    cmp = Map.get(condition, "c")
    cmp_int = if is_integer(cmp) and not is_boolean(cmp), do: cmp, else: 0
    lb = EvalLog.append_segment_condition(ctx.log_builder, segment_name, cmp_int)
    ctx = %{ctx | log_builder: lb}

    cond do
      is_nil(ctx.user) ->
        ctx = surface_missing_user(ctx)
        {{:error, @missing_user_error}, ctx, surface_missing_user_err(err)}

      is_nil(segment) or segment_name == "" ->
        raise "Segment reference is invalid."

      true ->
        traced_segment_membership(ctx, segment, segment_name, cmp_int, err)
    end
  end

  defp resolve_segment(condition, %Context{segments: segments}) do
    index = Map.get(condition, "s")

    if is_integer(index) and not is_boolean(index) and index >= 0 and index < length(segments) do
      candidate = Enum.at(segments, index)

      if is_map(candidate) do
        name = Map.get(candidate, "n")
        {candidate, if(is_binary(name), do: name, else: "")}
      else
        {nil, ""}
      end
    else
      {nil, ""}
    end
  end

  defp traced_segment_membership(ctx, segment, segment_name, cmp_int, err) do
    lb =
      ctx.log_builder
      |> EvalLog.new_line("(")
      |> EvalLog.increase_indent()
      |> EvalLog.new_line("Evaluating segment '#{segment_name}':")

    ctx = %{ctx | log_builder: lb}
    wrapped = Enum.map(Map.get(segment, "r", []) || [], fn uc -> %{"u" => uc} end)
    {in_segment, ctx, err} = evaluate_conditions(wrapped, segment_name, ctx, err, nil)
    trace_segment_result(ctx, segment_name, cmp_int, in_segment, err)
  end

  @segment_is_not_in 1

  defp trace_segment_result(ctx, segment_name, cmp_int, in_segment, err) do
    errored = match?({:error, _}, in_segment)

    result =
      cond do
        errored -> in_segment
        cmp_int == @segment_is_not_in -> not in_segment
        true -> in_segment
      end

    membership_text =
      cond do
        errored -> eval_error_or_default(ctx)
        in_segment == true -> "User IS IN SEGMENT"
        true -> "User IS NOT IN SEGMENT"
      end

    lb =
      ctx.log_builder
      |> EvalLog.new_line("Segment evaluation result: ")
      |> EvalLog.append(membership_text)
      |> EvalLog.append(".")
      |> EvalLog.new_line("Condition (")
      |> EvalLog.append_segment_condition(segment_name, cmp_int)
      |> EvalLog.append(")")

    lb =
      if errored do
        EvalLog.append(lb, " failed to evaluate")
      else
        lb
        |> EvalLog.append(" evaluates to ")
        |> EvalLog.append_condition_result(result == true)
      end

    lb =
      lb
      |> EvalLog.append(".")
      |> EvalLog.decrease_indent()
      |> EvalLog.new_line(")")

    ctx = %{ctx | log_builder: lb}

    if errored do
      {{:error, eval_error_or_default(ctx)}, ctx, err}
    else
      {result, ctx, err}
    end
  end

  defp eval_error_or_default(%Context{} = _ctx), do: @missing_user_error

  # ---------------------------------------------------------------------------
  # Error surfacing
  # ---------------------------------------------------------------------------

  # Surface the no-user reason once per context AND log the WARN 3001 once per
  # context (common-js parity). Returns the (possibly dedup-flagged) ctx.
  defp surface_missing_user(%Context{missing_user_logged: true} = ctx), do: ctx

  defp surface_missing_user(%Context{} = ctx) do
    EvalLogger.user_object_is_missing(ctx.log, ctx.key)
    %{ctx | missing_user_logged: true}
  end

  # ---------------------------------------------------------------------------
  # Trace builder threading helpers (no-op when the builder is nil — hot path).
  # ---------------------------------------------------------------------------

  defp trace_new_line(%Context{log_builder: nil} = ctx, _text), do: ctx

  defp trace_new_line(%Context{log_builder: lb} = ctx, text),
    do: %{ctx | log_builder: EvalLog.new_line(lb, text)}

  defp trace_increase_indent(%Context{log_builder: nil} = ctx), do: ctx

  defp trace_increase_indent(%Context{log_builder: lb} = ctx),
    do: %{ctx | log_builder: EvalLog.increase_indent(lb)}

  defp trace_decrease_indent(%Context{log_builder: nil} = ctx), do: ctx

  defp trace_decrease_indent(%Context{log_builder: lb} = ctx),
    do: %{ctx | log_builder: EvalLog.decrease_indent(lb)}

  # A rule whose conditions ERRORED is ignored with a trace line; a rule that
  # merely did not match (false) continues silently.
  defp trace_rule_ignored(%Context{log_builder: nil} = ctx, _outcome), do: ctx

  defp trace_rule_ignored(%Context{log_builder: lb} = ctx, {:error, _}) do
    lb =
      lb
      |> EvalLog.increase_indent()
      |> EvalLog.new_line(
        "The current targeting rule is ignored and the evaluation continues with the next rule."
      )
      |> EvalLog.decrease_indent()

    %{ctx | log_builder: lb}
  end

  defp trace_rule_ignored(%Context{} = ctx, _outcome), do: ctx

  defp surface_missing_user_err(nil), do: @missing_user_error
  defp surface_missing_user_err(existing), do: existing

  defp surface_outcome_error({:error, msg}, nil), do: msg
  defp surface_outcome_error(_, existing), do: existing

  defp missing_attribute_error(attr),
    do: "cannot evaluate, the User.#{attr} attribute is missing"

  # ---------------------------------------------------------------------------
  # User attribute access
  # ---------------------------------------------------------------------------

  defp user_attribute(nil, _attr), do: nil

  defp user_attribute(%User{} = user, "Identifier"), do: nil_if_empty(user.identifier)
  defp user_attribute(%User{} = user, "Email"), do: nil_if_empty(user.email)
  defp user_attribute(%User{} = user, "Country"), do: nil_if_empty(user.country)

  defp user_attribute(%User{custom: custom}, attr) when is_map(custom),
    do: Map.get(custom, attr)

  defp user_attribute(%User{}, _attr), do: nil

  defp nil_if_empty(nil), do: nil
  defp nil_if_empty(""), do: nil
  defp nil_if_empty(v), do: v

  @doc false
  def circular_dependency_error, do: CircularDependencyError
end
