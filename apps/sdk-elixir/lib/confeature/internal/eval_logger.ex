# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.EvalLogger do
  @moduledoc """
  Evaluation logger surface (ADR 0003 / epic #494, Elixir slice of #501).

  The WARN / ERROR / INFO lines the federated evaluator emits during a trace,
  ported from `packages/sdk-shared/src/logger.ts` (the `LoggerWrapper` helpers
  `userObjectIsMissing` / `userObjectAttributeIsMissing` /
  `userObjectAttributeIsMissingForPercentage` / `userObjectAttributeIsInvalid`
  / `comparisonValueIsInvalid` / `circularDependency`) and the INFO 5000 trace
  emission point in `evaluator.ts`. Mirrors the Go / Python / Ruby ports so the
  federation ports stay consistent.

  The strings are ported VERBATIM from logger.ts (Principle II —
  byte-identical to the canonical). The capture format the parity test
  reconstructs is `"<LEVEL>: [<eventId>] <message>"` per emitted call, joined
  by "\\n", with the INFO 5000 entry carrying the multi-line indented trace.

  This trace-logging seam is intentionally distinct from the public
  `Confeature.Logger`: a customer-supplied logger has the
  `error/warning/info/debug` shape, while the trace test taps a structured
  `(level, event_id, message)` recorder. Keeping them separate matches the Go /
  Python / Ruby factoring and keeps the no-trace hot path zero-cost.

  The injected `inner` is any term implementing the `Confeature.Internal.EvalLogger.Sink`
  protocol — `level/1` (→ a `TraceLevel`) and `log/4` (`(sink, level, event_id,
  message)`). A `nil` inner means tracing is off (zero cost) and every helper is
  level-gated at the boundary.
  """

  # Mirrors configcat-common's numeric ordering (logger.ts `LogLevel`). Distinct
  # from the public `Confeature.LogLevel`; used ONLY for the trace seam so the
  # gating matches the canonical reference exactly.
  @off -1
  @error 1
  @warn 2
  @info 3
  # debug is 4 in that ordering; no trace path gates on it, so it has no
  # attribute (an unused one fails `mix compile --warnings-as-errors`).

  defmodule TraceLevel do
    @moduledoc false
    def off, do: -1
    def error, do: 1
    def warn, do: 2
    def info, do: 3
    def debug, do: 4
  end

  defprotocol Sink do
    @moduledoc """
    The capture sink the evaluator's trace logger writes to. The parity test's
    recorder implements this; a `nil` sink disables tracing entirely.
    """
    @fallback_to_any true

    @doc "The sink's threshold trace level (a `TraceLevel` integer)."
    @spec level(t) :: integer()
    def level(sink)

    @doc "Record one emitted `(level, event_id, message)` line."
    @spec log(t, integer(), String.t(), String.t()) :: any()
    def log(sink, level, event_id, message)
  end

  defimpl Sink, for: Any do
    def level(nil), do: -1
    def level(_), do: -1
    def log(_sink, _level, _event_id, _message), do: :ok
  end

  defstruct [:inner]

  @type t :: %__MODULE__{inner: term() | nil}

  @doc "Wrap a capture sink (or `nil` for the zero-cost hot path)."
  @spec new(term() | nil) :: t()
  def new(inner), do: %__MODULE__{inner: inner}

  @doc "Is the trace logger enabled at `level`?"
  @spec enabled?(t(), integer()) :: boolean()
  def enabled?(%__MODULE__{inner: nil}, _level), do: false

  def enabled?(%__MODULE__{inner: inner}, level) do
    threshold = Sink.level(inner)

    cond do
      threshold == @off -> false
      true -> level <= threshold
    end
  end

  @doc "INFO level constant for the caller's `enabled?` guard."
  @spec info_level() :: integer()
  def info_level, do: @info

  # WARN 3001 (verbatim from logger.ts `userObjectIsMissing`).
  @spec user_object_is_missing(t(), String.t()) :: any()
  def user_object_is_missing(log, key) do
    emit(
      log,
      @warn,
      "3001",
      "cannot evaluate targeting rules and % options for setting '#{key}' " <>
        "(User Object is missing); you should pass a User Object to the evaluation " <>
        "methods like `getValue()` in order to make targeting work properly; read more: " <>
        "https://configcat.com/docs/advanced/user-object/"
    )
  end

  # WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`).
  @spec user_object_attribute_is_missing(t(), String.t(), String.t()) :: any()
  def user_object_attribute_is_missing(log, key, attribute_name) do
    emit(
      log,
      @warn,
      "3003",
      "cannot evaluate certain targeting rules of setting '#{key}' " <>
        "(the User.#{attribute_name} attribute is missing); you should set the " <>
        "User.#{attribute_name} attribute in order to make targeting work properly; " <>
        "read more: https://configcat.com/docs/advanced/user-object/"
    )
  end

  # WARN 3003, % options variant (verbatim from logger.ts).
  @spec user_object_attribute_is_missing_for_percentage(t(), String.t(), String.t()) :: any()
  def user_object_attribute_is_missing_for_percentage(log, key, attribute_name) do
    emit(
      log,
      @warn,
      "3003",
      "cannot evaluate % options for setting '#{key}' " <>
        "(the User.#{attribute_name} attribute is missing); you should set the " <>
        "User.#{attribute_name} attribute in order to make targeting work properly; " <>
        "read more: https://configcat.com/docs/advanced/user-object/"
    )
  end

  # WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`).
  @spec user_object_attribute_is_invalid(t(), String.t(), String.t(), String.t()) :: any()
  def user_object_attribute_is_invalid(log, key, attribute_name, reason) do
    emit(
      log,
      @warn,
      "3004",
      "cannot evaluate certain targeting rules of setting '#{key}' " <>
        "(the User.#{attribute_name} attribute is invalid (#{reason})); please check the " <>
        "User.#{attribute_name} attribute and make sure that its value corresponds to the " <>
        "comparison operator"
    )
  end

  # WARN 3004, malformed config operand (#509). No "please check the User.<attr>…"
  # suffix (verbatim from logger.ts `comparisonValueIsInvalid`). `inner_message`
  # is the full `comparison value '<v>' is invalid (<reason>)` text.
  @spec comparison_value_is_invalid(t(), String.t(), String.t()) :: any()
  def comparison_value_is_invalid(log, key, inner_message) do
    emit(
      log,
      @warn,
      "3004",
      "cannot evaluate certain targeting rules of setting '#{key}' (#{inner_message})"
    )
  end

  # ERROR 1002 (verbatim from logger.ts `circularDependency`).
  @spec circular_dependency(t(), String.t(), String.t()) :: any()
  def circular_dependency(log, key, cycle) do
    emit(
      log,
      @error,
      "1002",
      "failed to evaluate setting '#{key}' (circular dependency detected between the " <>
        "following depending flags: [#{cycle}])"
    )
  end

  # INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`.
  @spec info(t(), String.t(), String.t()) :: any()
  def info(log, event_id, message), do: emit(log, @info, event_id, message)

  defp emit(%__MODULE__{inner: inner} = log, level, event_id, message) do
    if enabled?(log, level), do: Sink.log(inner, level, event_id, message), else: :ok
  end
end
