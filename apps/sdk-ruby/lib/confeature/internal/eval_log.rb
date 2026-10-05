# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "time"
require_relative "comparators"
require_relative "prerequisites"
require_relative "segments"

module Confeature
  module Internal
    # ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
    # Ruby slice of #501).
    #
    # Ruby port of the spec-117 TS reference
    # (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder`), the Python
    # port (`apps/sdk-python/src/confeature_client/eval_log.py`), and the Go port
    # (`apps/sdk-go/internal/evaluator/eval_log.go`). Produces the byte-identical
    # indented textual trace ConfigCat's SDKs emit during flag evaluation — its
    # `evaluationlog/` corpus (replayed via
    # `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is
    # the byte-oracle. This builder mirrors the TS class line-for-line so the
    # federation ports stay consistent.
    #
    # The trace is emitted via the trace logger at INFO under event id 5000
    # (ConfigCat's verbosity contract) — see `Evaluator.evaluate_traced`. The
    # strings are ported VERBATIM from the canonical (Principle II).
    module EvalLog
      # ConfigCat's event id for the "config evaluated" INFO log line. Captured
      # as `... [5000] ...`, matching the upstream oracle.
      EVAL_LOG_EVENT_ID = "5000"

      # ConfigCat indents each nested eval-log line by two spaces per level.
      INDENT_UNIT = "  "

      # Placeholders ConfigCat substitutes for malformed condition parts (parity
      # with configcat-common's EvaluateLogBuilder).
      INVALID_VALUE_PLACEHOLDER = "<invalid value>"
      INVALID_NAME_PLACEHOLDER = "<invalid name>"
      INVALID_OPERATOR_PLACEHOLDER = "<invalid operator>"

      # Max IS-ONE-OF / list items rendered before truncation (configcat parity).
      STRING_LIST_MAX_LENGTH = 10

      C = Comparators

      # Per-comparator eval-log metadata (configcat-common parity), as
      # `[token, kind, sensitive]` — `token` is the operator rendering, `kind`
      # selects the condition value slot ("l"=list, "s"=string, "n"=number,
      # "dt"=datetime), `sensitive` masks the value as `<hashed value>`. One
      # table drives the condition rendering, mirroring eval-log.ts
      # COMPARATOR_META.
      COMPARATOR_META = {
        C::TEXT_IS_ONE_OF => ["IS ONE OF", "l", false],
        C::TEXT_IS_NOT_ONE_OF => ["IS NOT ONE OF", "l", false],
        C::TEXT_CONTAINS_ANY_OF => ["CONTAINS ANY OF", "l", false],
        C::TEXT_NOT_CONTAINS_ANY_OF => ["NOT CONTAINS ANY OF", "l", false],
        C::SEMVER_IS_ONE_OF => ["IS ONE OF", "l", false],
        C::SEMVER_IS_NOT_ONE_OF => ["IS NOT ONE OF", "l", false],
        C::SEMVER_LESS => ["<", "s", false],
        C::SEMVER_LESS_OR_EQUALS => ["<=", "s", false],
        C::SEMVER_GREATER => [">", "s", false],
        C::SEMVER_GREATER_OR_EQUALS => [">=", "s", false],
        C::NUMBER_EQUALS => ["=", "n", false],
        C::NUMBER_NOT_EQUALS => ["!=", "n", false],
        C::NUMBER_LESS => ["<", "n", false],
        C::NUMBER_LESS_OR_EQUALS => ["<=", "n", false],
        C::NUMBER_GREATER => [">", "n", false],
        C::NUMBER_GREATER_OR_EQUALS => [">=", "n", false],
        C::SENSITIVE_TEXT_IS_ONE_OF => ["IS ONE OF", "l", true],
        C::SENSITIVE_TEXT_IS_NOT_ONE_OF => ["IS NOT ONE OF", "l", true],
        C::DATETIME_BEFORE => ["BEFORE", "dt", false],
        C::DATETIME_AFTER => ["AFTER", "dt", false],
        C::SENSITIVE_TEXT_EQUALS => ["EQUALS", "s", true],
        C::SENSITIVE_TEXT_NOT_EQUALS => ["NOT EQUALS", "s", true],
        C::SENSITIVE_TEXT_STARTS_WITH_ANY_OF => ["STARTS WITH ANY OF", "l", true],
        C::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF => ["NOT STARTS WITH ANY OF", "l", true],
        C::SENSITIVE_TEXT_ENDS_WITH_ANY_OF => ["ENDS WITH ANY OF", "l", true],
        C::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF => ["NOT ENDS WITH ANY OF", "l", true],
        C::SENSITIVE_ARRAY_CONTAINS_ANY_OF => ["ARRAY CONTAINS ANY OF", "l", true],
        C::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF => ["ARRAY NOT CONTAINS ANY OF", "l", true],
        C::TEXT_EQUALS => ["EQUALS", "s", false],
        C::TEXT_NOT_EQUALS => ["NOT EQUALS", "s", false],
        C::TEXT_STARTS_WITH_ANY_OF => ["STARTS WITH ANY OF", "l", false],
        C::TEXT_NOT_STARTS_WITH_ANY_OF => ["NOT STARTS WITH ANY OF", "l", false],
        C::TEXT_ENDS_WITH_ANY_OF => ["ENDS WITH ANY OF", "l", false],
        C::TEXT_NOT_ENDS_WITH_ANY_OF => ["NOT ENDS WITH ANY OF", "l", false],
        C::ARRAY_CONTAINS_ANY_OF => ["ARRAY CONTAINS ANY OF", "l", false],
        C::ARRAY_NOT_CONTAINS_ANY_OF => ["ARRAY NOT CONTAINS ANY OF", "l", false]
      }.freeze

      module_function

      # Render a `UserComparator` as ConfigCat's eval-log operator token.
      def format_user_comparator(comparator)
        meta = COMPARATOR_META[comparator]
        meta.nil? ? INVALID_OPERATOR_PLACEHOLDER : meta[0]
      end

      # Format a string list exactly as configcat-common's `formatStringList`:
      # `'a', 'b'` joined by `, `, with an optional truncation appendix once
      # `max_length` is exceeded.
      def format_string_list(items, max_length)
        return "" if items.empty?

        appendix = ""
        shown = items
        if max_length.positive? && items.length > max_length
          shown = items[0, max_length]
          count = items.length - max_length
          word = count == 1 ? "value" : "values"
          appendix = ", ... <#{count} more #{word}>"
        end
        "'#{shown.join("', '")}'#{appendix}"
      end

      # Format a resolved SETTING value for the eval log (ConfigCat parity):
      # boolean → `true`/`false` (lowercase), string → verbatim, number → its
      # canonical decimal string. Mirrors the `'<value>'` token in ConfigCat's
      # `Returning '<value>'.` footer (eval-log.ts `settingValueToString`).
      def setting_value_to_log_string(value)
        return value ? "true" : "false" if [true, false].include?(value)
        return value if value.is_a?(String)
        return Comparators.number_to_canonical_string(value) if value.is_a?(Numeric)

        ""
      end

      # Render a Unix-seconds value as ConfigCat's eval-log datetime suffix:
      # JS `new Date(value*1000).toISOString()`, e.g. `2023-04-01T00:00:00.000Z`
      # (always millisecond precision, UTC). Returns nil for non-finite values
      # (NaN / ±Inf), matching the JS `isNaN(date)` guard.
      def unix_seconds_to_iso(seconds)
        f = seconds.to_f
        return nil if f.nan? || f.infinite?

        ms = (f * 1000).round
        t = Time.at(ms / 1000, ms % 1000, :millisecond, in: "+00:00")
        "#{t.strftime("%Y-%m-%dT%H:%M:%S")}.#{format("%03d", ms % 1000)}Z"
      end

      # Three-valued THEN consequence (MATCH / no match / error string). Mirrors
      # TS's `boolean | string`. `kind` is `:true` / `:false` / `:error`;
      # `err_text` carries the reason for the error case.
      MatchOrError = Struct.new(:kind, :err_text)

      def match_true
        MatchOrError.new(:match, nil)
      end

      def match_false
        MatchOrError.new(:no_match, nil)
      end

      def match_error(text)
        MatchOrError.new(:errored, text)
      end

      # Ruby analogue of eval-log.ts `EvaluateLogBuilder`. indent/new_line/append
      # primitives + the condition-rendering helpers. `eol` defaults to "\n" —
      # the byte the upstream oracle uses.
      class Builder
        def initialize(eol: "\n")
          @chunks = []
          @indent_level = 0
          @eol = eol
        end

        # Append text to the current line.
        def append(text)
          @chunks << text
          self
        end

        # Break to a new line at the current indent, then optionally append text.
        def new_line(text = nil)
          @chunks << (@eol + (INDENT_UNIT * @indent_level))
          @chunks << text unless text.nil?
          self
        end

        def increase_indent
          @indent_level += 1
          self
        end

        def decrease_indent
          @indent_level -= 1 if @indent_level.positive?
          self
        end

        # ---- condition formatting --------------------------------------------

        # Render one user condition (`User.<attr> <COMP> <value>`). The compact
        # condition carries the value in `l` (list), `s` (string /
        # sensitive-equals), or `d` (number / datetime), selected by the
        # comparator kind.
        def append_user_condition(condition)
          attr = condition["a"].is_a?(String) ? condition["a"] : INVALID_NAME_PLACEHOLDER
          cmp = condition["c"]
          cmp = -1 unless cmp.is_a?(Integer) && ![true, false].include?(cmp)
          meta = COMPARATOR_META[cmp]
          return append_unknown_user_condition(attr, cmp, condition) if meta.nil?

          _, kind, sensitive = meta
          dispatch_user_condition(attr, cmp, kind, sensitive, condition)
        end

        # Append a single condition's boolean result (` => true` / ` => false…`).
        def append_condition_consequence(result)
          append(" => #{bool_to_log_string(result)}")
          result ? self : append(", skipping the remaining AND conditions")
        end

        # Append a targeting rule's THEN consequence. `then_value` is the rule's
        # formatted served value (e.g. `Dog`) for a fixed-value rule, or nil for
        # a rule serving `% options`. `match` is MATCH / no match / an error.
        def append_targeting_rule_consequence(then_value, match, newline)
          increase_indent
          # `newline` (the param) must NOT shadow the `new_line` builder method:
          # break to a fresh line when the rule had conditions, else a single
          # space before `THEN` (mirrors eval-log.ts appendTargetingRuleConsequence).
          if newline
            new_line
          else
            append(" ")
          end
          append("THEN")
          append(then_value.nil? ? " % options" : " '#{then_value}'")
          append(" => ")
          case match.kind
          when :match then append("MATCH, applying rule")
          when :no_match then append("no match")
          else append(match.err_text)
          end
          decrease_indent
        end

        # Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`).
        def append_prerequisite_flag_condition(prereq_key, comparator, comparison_value)
          op = comparator == Prerequisites::PREREQUISITE_NOT_EQUALS ? "NOT EQUALS" : "EQUALS"
          append("Flag '#{prereq_key}' #{op} '#{comparison_value}'")
        end

        # Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`).
        def append_segment_condition(segment_name, comparator)
          op = comparator == Segments::SEGMENT_IS_NOT_IN ? "IS NOT IN SEGMENT" : "IS IN SEGMENT"
          append("User #{op} '#{segment_name}'")
        end

        # Append a bare boolean condition result (`true` / `false`).
        def append_condition_result(result)
          append(bool_to_log_string(result))
        end

        def to_s
          @chunks.join
        end

        private

        def dispatch_user_condition(attr, cmp, kind, sensitive, condition)
          case kind
          when "l"
            lv = condition["l"]
            append_user_condition_string_list(attr, cmp, lv.is_a?(Array) ? lv : nil, sensitive)
          when "s"
            append_user_condition_string(attr, cmp, condition["s"], sensitive)
          when "n"
            dv = condition["d"]
            append_user_condition_number(attr, cmp, dv&.to_f, false)
          else # "dt"
            dv = condition["d"]
            append_user_condition_number(attr, cmp, dv&.to_f, true)
          end
        end

        # Unknown comparator: fall back to the first present value slot.
        def append_unknown_user_condition(attr, cmp, condition)
          sv = condition["s"]
          return append_user_condition_core(attr, cmp, sv) if sv.is_a?(String)

          dv = condition["d"]
          return append_user_condition_core(attr, cmp, Comparators.number_to_canonical_string(dv.to_f)) unless dv.nil?

          lv = condition["l"]
          return append_user_condition_core(attr, cmp, lv[0].to_s) if lv.is_a?(Array) && !lv.empty?

          append_user_condition_core(attr, cmp, "")
        end

        def append_user_condition_core(attr, comparator, value)
          value = INVALID_VALUE_PLACEHOLDER if value == ""
          append("User.#{attr} #{EvalLog.format_user_comparator(comparator)} '#{value}'")
        end

        def append_user_condition_string(attr, comparator, value, is_sensitive)
          return append_user_condition_core(attr, comparator, "") unless value.is_a?(String)
          return append_user_condition_core(attr, comparator, "<hashed value>") if is_sensitive

          append_user_condition_core(attr, comparator, value)
        end

        def append_user_condition_string_list(attr, comparator, values, is_sensitive)
          return append_user_condition_core(attr, comparator, "") unless values.is_a?(Array)

          comparator_text = EvalLog.format_user_comparator(comparator)
          if is_sensitive
            word = values.length == 1 ? "value" : "values"
            return append("User.#{attr} #{comparator_text} [<#{values.length} hashed #{word}>]")
          end
          list_text = EvalLog.format_string_list(values, STRING_LIST_MAX_LENGTH)
          append("User.#{attr} #{comparator_text} [#{list_text}]")
        end

        def append_user_condition_number(attr, comparator, value, is_datetime)
          return append_user_condition_core(attr, comparator, "") if value.nil?

          comparator_text = EvalLog.format_user_comparator(comparator)
          value_text = Comparators.number_to_canonical_string(value)
          if is_datetime
            iso = EvalLog.unix_seconds_to_iso(value)
            return append("User.#{attr} #{comparator_text} '#{value_text}' (#{iso} UTC)") unless iso.nil?
          end
          append("User.#{attr} #{comparator_text} '#{value_text}'")
        end

        def bool_to_log_string(value)
          value ? "true" : "false"
        end
      end
    end
  end
end
