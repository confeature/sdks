# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "json"
require_relative "hashing"
require_relative "semver"
require_relative "comparators"
require_relative "segments"
require_relative "prerequisites"
require_relative "eval_log"
require_relative "eval_logger"

module Confeature
  module Internal
    # ConfigCat-parity flag evaluator — full decision engine (spec 120).
    #
    # Ported from the spec-117 TS reference
    # (`packages/sdk-shared/src/evaluator.ts`) and the spec-118 Python port
    # (`apps/sdk-python/src/confeature_client/evaluator.py`). The evaluator
    # consumes a parsed `config_v6.json` Hash and a (key, default, user) tuple
    # and returns an `EvaluationResult` carrying the resolved value, an optional
    # reason-coded error, the variation id, and the matched targeting rule /
    # percentage option.
    #
    # Decision flow (mirrors `evaluator.ts::evaluateSetting`):
    #   1. walk `setting["r"]` first-match-wins; each rule's `c` conditions are
    #      AND-grouped (short-circuit); a matched rule serves its fixed value
    #      `s` or buckets into its percentage options `p`;
    #   2. no rule matches → setting-level percentage options `p`;
    #   3. else → served fallback `setting["v"]`.
    #
    # Conditions dispatch to the 36 comparators (`comparators.rb`), segment
    # membership (`segments.rb`), and prerequisite flags with bounded
    # circular-dependency detection (`prerequisites.rb`).
    #
    # Preserved invariants (SC-006 — NON-NEGOTIABLE, Principle II):
    #   - the existing typed-widening + TYPE_MISMATCH / VALUE_NOT_BOOL decision
    #     tree (strict int/double, the bool-is-int guard) runs UNCHANGED on the
    #     resolved value envelope, whatever its source (rule / % / fallback);
    #   - fail-closed: the function NEVER raises; any unexpected state (incl. a
    #     detected prerequisite cycle) resolves to the caller's default with a
    #     reason-coded error (`EVAL_EXCEPTION`), bounded (FR-007/SC-004);
    #   - the rule-less / no-user path is byte-identical to the pre-engine
    #     behaviour.
    #
    # No-user / missing-attribute on a rule is NOT an error to the caller — the
    # rule simply does not match and evaluation continues; an informational
    # reason is surfaced on `EvaluationResult.eval_error` (FR-016), while `error`
    # stays nil because a value WAS cleanly resolved.
    module Evaluator
      # `SettingType` discriminators from
      # `packages/sdk-shared/src/config-json.ts`.
      SETTING_TYPE_BOOL = 0
      SETTING_TYPE_STRING = 1
      SETTING_TYPE_INT = 2
      SETTING_TYPE_DOUBLE = 3

      MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing"

      IDENTIFIER_ATTRIBUTE = "Identifier"
      EMAIL_ATTRIBUTE = "Email"
      COUNTRY_ATTRIBUTE = "Country"

      # Result of `evaluate(...)`. `error` carries the reason-coded fail-closed
      # signal (`KEY_NOT_FOUND`, `TYPE_MISMATCH`, `EVAL_EXCEPTION`, …) — nil
      # whenever a value was cleanly resolved (incl. via a targeting rule,
      # percentage option, or served fallback). `eval_error` is the
      # informational rule-engine reason (e.g. "User Object is missing")
      # surfaced when a rule could not be evaluated but a value WAS still
      # resolved (FR-016) — it never changes `error`.
      EvaluationResult = Struct.new(
        :value, :error, :variation_id,
        :matched_targeting_rule, :matched_percentage_option, :eval_error,
        keyword_init: true
      ) do
        def ok?
          error.nil?
        end
      end

      # Raw result of `evaluate_setting`: the resolved `v` envelope + identity.
      SettingResult = Struct.new(:value, :variation_id, :matched_rule, :matched_option, keyword_init: true)

      # Per-evaluation context threaded through rule / condition / prereq walks.
      #
      # `log` + `log_builder` are the eval-log trace seam (ADR 0003), present
      # only when an INFO-enabled trace logger is attached. Every trace append is
      # guarded by `unless ctx.log_builder.nil?`, so the no-trace hot path pays
      # nothing. `log_builder` is shared across the recursion (a prerequisite
      # re-evaluates nested in `( … )` on the SAME builder).
      EvalContext = Struct.new(
        :key, :setting, :settings, :segments, :config_salt, :user, :visited_flags, :state,
        :log, :log_builder,
        keyword_init: true
      )

      # Mutable evaluation-scoped flags shared across the recursion.
      #
      # `missing_user_object_logged` dedups the no-user WARN 3001 to once per
      # context (common-js parity): a prerequisite flag evaluates in its OWN
      # context, so a prereq referenced by N rules logs the WARN N times, but a
      # single rule with multiple no-user conditions logs it once.
      EvalState = Struct.new(:eval_error, :missing_user_object_logged)

      # Internal: a malformed rule/option config that must fail closed.
      class MalformedConfigError < StandardError; end

      module_function

      # Read the typed value out of a `v` envelope by the setting's `t`.
      # Mirrors `evaluator.ts::selectSettingValue`. The key is chosen from `t`,
      # never from the runtime shape of the parsed value.
      def select_setting_value(value, setting_type)
        return nil unless value.is_a?(::Hash)

        case setting_type
        when SETTING_TYPE_BOOL then value["b"]
        when SETTING_TYPE_STRING then value["s"]
        when SETTING_TYPE_INT then value["i"]
        when SETTING_TYPE_DOUBLE then value["d"]
        end
      end

      # Resolve `key` against `config`. Fail-closed to `default_value`.
      #
      # The function NEVER raises. Any internal exception (incl. a detected
      # prerequisite cycle) is converted to a fail-closed result with
      # `error="EVAL_EXCEPTION"`.
      def evaluate(config, key, default_value, user = nil)
        evaluate_traced(config, key, default_value, user, nil)
      end

      # `evaluate` with an optional trace logger. When the logger is
      # INFO-enabled it drives the ConfigCat byte-identical evaluation-log trace:
      # the WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and
      # the final INFO 5000 multi-line indented trace (ADR 0003 / epic #494). A
      # `nil` logger (the hot path) is zero-cost — identical to `evaluate`.
      def evaluate_traced(config, key, default_value, user = nil, logger = nil)
        return EvaluationResult.new(value: default_value, error: "NO_CONFIG") if config.nil?
        return EvaluationResult.new(value: default_value, error: "MALFORMED_CONFIG") unless config.is_a?(::Hash)

        log = EvalLogger::TraceLog.new(logger)

        settings = config["f"]
        return EvaluationResult.new(value: default_value, error: "MALFORMED_CONFIG") unless settings.is_a?(::Hash)

        setting = settings[key]
        return EvaluationResult.new(value: default_value, error: "KEY_NOT_FOUND") if setting.nil?

        setting_type = setting["t"]
        # `t` must be an Integer discriminator. Anything else is malformed.
        unless setting_type.is_a?(Integer) && !boolean?(setting_type)
          return EvaluationResult.new(value: default_value, error: "MALFORMED_CONFIG")
        end

        # Type guard BEFORE evaluating rules (mirrors evaluator.ts): the default
        # must be type-compatible with the setting's declared type. A `nil`
        # default bypasses the check — used by the variation-id matrix, which
        # evaluates with a `nil` default to read `variation_id` regardless of
        # value type.
        unless default_value.nil?
          mismatch = check_default_type(setting_type, default_value)
          return EvaluationResult.new(value: default_value, error: mismatch) unless mismatch.nil?
        end

        run_eval(config, key, setting, settings, setting_type, default_value, user, log)
      rescue Prerequisites::CircularDependencyError => e
        # A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
        # (naming the setting + the chain), not the generic evaluation-error path.
        log.circular_dependency(key, e.cycle)
        EvaluationResult.new(value: default_value, error: "EVAL_EXCEPTION")
      rescue StandardError
        # Bounded fail-closed (FR-007/SC-004): every internal failure — a
        # malformed prereq / segment reference, a malformed-config raise, or any
        # unexpected error — resolves to the caller's default with an
        # `EVAL_EXCEPTION` reason. The cycle raise is what bounds an otherwise
        # unbounded recursion (no SystemStackError escape).
        EvaluationResult.new(value: default_value, error: "EVAL_EXCEPTION")
      end

      # Evaluation core (the seam): resolve the setting to a `v` envelope +
      # matched-rule/option identity, then run the typed-widening decision tree.
      # For a rule-less config this collapses to the served `setting["v"]`,
      # byte-identical to the pre-engine behaviour. Split out so the entry's
      # guard ladder stays flat.
      def run_eval(config, key, setting, settings, setting_type, default_value, user, log)
        log_builder = nil
        if log.enabled?(EvalLogger::TraceLevel::INFO)
          log_builder = EvalLog::Builder.new
          log_builder.append("Evaluating '#{key}'")
          log_builder.append(" for User '#{user_attributes_for_log_json(user)}'") unless user.nil?
        end

        ctx = EvalContext.new(
          key: key, setting: setting, settings: settings,
          segments: config_segments(config), config_salt: config_salt(config),
          user: user, visited_flags: [], state: EvalState.new(nil, false),
          log: log, log_builder: log_builder
        )
        result = evaluate_setting(ctx)

        value_slot = result.value
        return EvaluationResult.new(value: default_value, error: "MALFORMED_VALUE") unless value_slot.is_a?(::Hash)

        variation_id = result.variation_id
        variation_id = setting["i"] if variation_id.nil? && setting["i"].is_a?(String)

        typed = resolve_typed(setting_type, value_slot, default_value, variation_id, result, ctx.state.eval_error)

        # Footer + emit. The INFO 5000 trace is emitted only when the resolved
        # value is clean (no error); a type/value error fails closed without a
        # footer (matching evaluator.ts, which emits after the value guard).
        unless log_builder.nil? || !typed.error.nil?
          log_builder.new_line("Returning '#{EvalLog.setting_value_to_log_string(typed.value)}'.")
          log.info(EvalLog::EVAL_LOG_EVENT_ID, log_builder.to_s)
        end
        typed
      end

      def config_salt(config)
        prefs = config["p"]
        salt = prefs["s"] if prefs.is_a?(::Hash)
        salt.is_a?(String) ? salt : ""
      end

      def config_segments(config)
        raw = config["s"]
        raw.is_a?(Array) ? raw : []
      end

      # Render the user's attributes as the eval-log header shows them — a
      # Confeature-canonical object `{Identifier, Email?, Country?, …custom}`
      # JSON-serialized to the `for User '…'` token (ADR 0003 addendum). This is
      # the configcat-js form (the vendored go-sdk oracle's map is transformed to
      # it in the corpus so the cross-SDK trace stays byte-identical).
      #
      # Insertion order is fixed (Identifier, Email, Country, then custom in the
      # order the user's custom map yields) and the serialization is compact (no
      # spaces) with JS-JSON string escaping — mirroring
      # `JSON.stringify(userAttributesForLog(user))`.
      def user_attributes_for_log_json(user)
        parts = ["\"Identifier\":#{js_json_string(user_identifier(user))}"]
        parts << "\"Email\":#{js_json_string(user.email)}" unless user.email.nil?
        parts << "\"Country\":#{js_json_string(user.country)}" unless user.country.nil?
        custom = user.custom
        if custom.is_a?(::Hash)
          custom.each do |name, value|
            parts << "#{js_json_string(name)}:#{js_json_string(Comparators.user_attribute_value_to_string(value))}"
          end
        end
        "{#{parts.join(",")}}"
      end

      # Serialize a string exactly as ECMAScript `JSON.stringify` of a string:
      # wrapped in double quotes, with `"`, `\`, and the C0 control characters
      # escaped (`\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, else `\u00XX`), all
      # other code points (incl. `/` and non-ASCII) verbatim.
      def js_json_string(str)
        out = +'"'
        str.each_char do |ch|
          out << js_json_escape_char(ch)
        end
        out << '"'
        out
      end

      def js_json_escape_char(char)
        case char
        when '"' then '\\"'
        when "\\" then "\\\\"
        when "\b" then "\\b"
        when "\t" then "\\t"
        when "\n" then "\\n"
        when "\f" then "\\f"
        when "\r" then "\\r"
        else
          char.ord < 0x20 ? format("\\u%04x", char.ord) : char
        end
      end

      # Return a TYPE_MISMATCH reason code if the default type is wrong, else nil.
      def check_default_type(setting_type, default_value)
        case setting_type
        when SETTING_TYPE_BOOL
          return "TYPE_MISMATCH" unless boolean?(default_value)
        when SETTING_TYPE_STRING
          return "TYPE_MISMATCH" unless default_value.is_a?(String)
        when SETTING_TYPE_INT
          return "TYPE_MISMATCH" if boolean?(default_value) || !default_value.is_a?(Integer)
        when SETTING_TYPE_DOUBLE
          return "TYPE_MISMATCH" unless default_value.is_a?(Float)
        end
        nil
      end

      # Read the typed primitive from the resolved envelope (spec-072 widening).
      def resolve_typed(setting_type, value_slot, default_value, variation_id, result, eval_error)
        ok = lambda do |raw|
          EvaluationResult.new(
            value: raw,
            variation_id: variation_id,
            matched_targeting_rule: result.matched_rule,
            matched_percentage_option: result.matched_option,
            eval_error: eval_error
          )
        end

        case setting_type
        when SETTING_TYPE_BOOL
          raw = value_slot["b"]
          return EvaluationResult.new(value: default_value, error: "VALUE_NOT_BOOL") unless boolean?(raw)

          ok.call(raw)
        when SETTING_TYPE_STRING
          raw = value_slot["s"]
          return EvaluationResult.new(value: default_value, error: "MALFORMED_VALUE") unless raw.is_a?(String)

          ok.call(raw)
        when SETTING_TYPE_INT
          raw = value_slot["i"]
          if boolean?(raw) || !raw.is_a?(Integer)
            return EvaluationResult.new(value: default_value, error: "MALFORMED_VALUE")
          end

          ok.call(raw)
        when SETTING_TYPE_DOUBLE
          raw = value_slot["d"]
          return EvaluationResult.new(value: default_value, error: "MALFORMED_VALUE") if boolean?(raw)

          # JSON numbers without a fractional part decode as Integer; ConfigCat
          # double settings legitimately carry integral doubles (e.g. 5.0 → 5).
          raw = raw.to_f if raw.is_a?(Integer)
          return EvaluationResult.new(value: default_value, error: "MALFORMED_VALUE") unless raw.is_a?(Float)

          ok.call(raw)
        else
          EvaluationResult.new(value: default_value, error: "UNSUPPORTED_TYPE")
        end
      end

      # -----------------------------------------------------------------------
      # Evaluation core — rule walk / conditions / percentage
      # -----------------------------------------------------------------------

      def evaluate_setting(ctx)
        setting = ctx.setting

        # 1. Targeting rules — first-match-wins (US1).
        rules = setting["r"] || []
        unless rules.empty?
          rule_result = evaluate_targeting_rules(rules, ctx)
          return rule_result unless rule_result.nil?
        end

        # 2. Setting-level percentage options (US3).
        options = setting["p"] || []
        unless options.empty?
          option_result = evaluate_percentage_options(options, nil, ctx)
          return option_result unless option_result.nil?
        end

        # 3. Served fallback `setting["v"]`.
        SettingResult.new(value: setting["v"], variation_id: setting["i"])
      end

      # Walk rules in document order; return the first whose conditions all match.
      def evaluate_targeting_rules(rules, ctx)
        lb = ctx.log_builder
        lb&.new_line("Evaluating targeting rules and applying the first match if any:")
        rules.each do |rule|
          outcome = evaluate_conditions(rule["c"] || [], ctx.key, ctx, rule)
          unless outcome == true
            # A rule whose conditions ERRORED (missing user/attr) is ignored and
            # evaluation continues — ConfigCat emits this trace line. A rule that
            # merely did NOT match (false) just continues, with no such line.
            if !lb.nil? && outcome.is_a?(Comparators::ValidationError)
              lb.increase_indent.new_line(
                "The current targeting rule is ignored and the evaluation continues with the next rule."
              ).decrease_indent
            end
            next
          end

          served = rule["s"]
          return SettingResult.new(value: served["v"], variation_id: served["i"], matched_rule: rule) unless served.nil?

          # A rule serving % options: the block is traced one level deeper (under
          # the rule). If the options can't resolve (no user / missing attr) the
          # rule is ignored and evaluation continues.
          options = rule["p"] || []
          lb&.increase_indent
          option_result = evaluate_percentage_options(options, rule, ctx)
          unless option_result.nil?
            lb&.decrease_indent
            return option_result
          end
          lb&.new_line(
            "The current targeting rule is ignored and the evaluation continues with the next rule."
          )&.decrease_indent
        end
        nil
      end

      # Resolve a percentage-option list to its bucket (US3, SHA-1 unsalted).
      # Returns nil (skip) when there is no user or the keying attribute is
      # missing — never raises on a skippable condition. Mirrors common-js.
      def evaluate_percentage_options(options, matched_rule, ctx)
        lb = ctx.log_builder
        if ctx.user.nil?
          surface_missing_user(ctx)
          lb&.new_line("Skipping % options because the User Object is missing.")
          return nil
        end

        attr_name = ctx.setting["a"]
        if attr_name.nil?
          attr_name = IDENTIFIER_ATTRIBUTE
          attr_value = user_identifier(ctx.user)
        else
          attr_value = get_user_attribute(ctx.user, attr_name)
        end
        if attr_value.nil?
          ctx.state.eval_error ||= missing_user_attribute_error(attr_name)
          ctx.log.user_object_attribute_is_missing_for_percentage(ctx.key, attr_name)
          lb&.new_line("Skipping % options because the User.#{attr_name} attribute is missing.")
          return nil
        end

        hash_value = Hashing.percentage_bucket(ctx.key, Comparators.user_attribute_value_to_string(attr_value))

        unless lb.nil?
          lb.new_line("Evaluating % options based on the User.#{attr_name} attribute:")
          lb.new_line(
            "- Computing hash in the [0..99] range from User.#{attr_name} => #{hash_value} " \
            "(this value is sticky and consistent across all SDKs)"
          )
        end

        select_percentage_option(options, matched_rule, ctx, hash_value)
      end

      def select_percentage_option(options, matched_rule, ctx, hash_value)
        lb = ctx.log_builder
        setting_type = ctx.setting["t"]
        bucket = 0
        options.each_with_index do |option, index|
          width = option["p"] || 0
          bucket += width
          next if hash_value >= bucket

          value = option["v"]
          if !lb.nil? && setting_type.is_a?(Integer) && !boolean?(setting_type)
            selected = select_setting_value(value, setting_type)
            lb.new_line(
              "- Hash value #{hash_value} selects % option #{index + 1} (#{width}%), " \
              "'#{EvalLog.setting_value_to_log_string(selected)}'."
            )
          end
          return SettingResult.new(
            value: value, variation_id: option["i"],
            matched_rule: matched_rule, matched_option: option
          )
        end
        # Sum of widths < 100 — a malformed config. Raise so the outer
        # fail-closed frame returns the default (common-js throws here too).
        raise MalformedConfigError, "Sum of percentage option percentages is less than 100."
      end

      # Evaluate an AND-grouped condition list, short-circuiting on first
      # non-match / error. `true` = all matched; `false` = a condition did not
      # match; ValidationError = a condition errored (surfaced — FR-010).
      #
      # `rule` is the owning targeting rule when this is a rule's condition list
      # (nil for a bare segment's condition list). When present and tracing is
      # on, the rule's THEN consequence is appended after the AND group.
      def evaluate_conditions(conditions, context_salt, ctx, rule = nil)
        lb = ctx.log_builder
        lb&.new_line("- ")
        result = true
        conditions.each_with_index do |condition, i|
          trace_condition_prefix(lb, i) unless lb.nil?
          result = dispatch_condition(condition, context_salt, ctx)
          unless lb.nil?
            # The go-sdk oracle always shows the per-condition consequence (even
            # for a single-condition rule). A clean match is true; anything else
            # (no-match or surfaced error) renders the `=> false, skipping…` form.
            lb.append_condition_consequence(result == true)
            lb.decrease_indent
          end
          break if result != true
        end

        append_rule_consequence(lb, rule, conditions, result, ctx) unless rule.nil? || lb.nil?
        result
      end

      def trace_condition_prefix(builder, index)
        if index.zero?
          builder.append("IF ").increase_indent
        else
          builder.increase_indent.new_line("AND ")
        end
      end

      def dispatch_condition(condition, context_salt, ctx)
        if !condition["u"].nil?
          evaluate_user_condition(condition["u"], context_salt, ctx)
        elsif !condition["p"].nil?
          evaluate_prerequisite_condition(condition["p"], ctx)
        elsif !condition["s"].nil?
          evaluate_segment_condition(condition["s"], ctx)
        else
          Comparators.error("empty condition")
        end
      end

      # Append the rule's THEN consequence (rule-owned condition list only). The
      # go oracle newlines THEN when the rule has conditions.
      def append_rule_consequence(builder, rule, conditions, result, ctx)
        then_value, has_then = rule_then_value(rule, ctx)
        outcome =
          if result == true
            EvalLog.match_true
          elsif result.is_a?(Comparators::ValidationError)
            EvalLog.match_error(result.message)
          else
            EvalLog.match_false
          end
        builder.append_targeting_rule_consequence(has_then ? then_value : nil, outcome, !conditions.empty?)
      end

      # A rule's formatted served value (e.g. `Dog`) for a fixed-value rule;
      # `[nil, false]` for a rule serving `% options`.
      def rule_then_value(rule, ctx)
        served = rule["s"]
        return [nil, false] unless served.is_a?(::Hash)

        setting_type = ctx.setting["t"]
        return [nil, false] unless setting_type.is_a?(Integer) && !boolean?(setting_type)

        value = select_setting_value(served["v"], setting_type)
        [EvalLog.setting_value_to_log_string(value), true]
      end

      INVALID_ATTR_RE = /\Acannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)\z/

      # Dispatch one user condition to its comparator (US2).
      def evaluate_user_condition(condition, context_salt, ctx)
        ctx.log_builder&.append_user_condition(condition)
        if ctx.user.nil?
          surface_missing_user(ctx)
          return Comparators.error(MISSING_USER_OBJECT_ERROR)
        end

        attr_name = condition["a"].is_a?(String) ? condition["a"] : nil
        attr_value = attr_name.nil? ? nil : get_user_attribute(ctx.user, attr_name)
        if attr_name.nil? || attr_value.nil? || attr_value == ""
          msg = missing_user_attribute_error(condition["a"].to_s)
          ctx.state.eval_error ||= msg
          # ConfigCat logs a WARN 3003 per targeting rule whose attribute is
          # missing (not deduped — AND short-circuit means one per rule).
          ctx.log.user_object_attribute_is_missing(ctx.key, condition["a"].to_s)
          return Comparators.error(msg)
        end

        result = dispatch_user_comparator(condition, attr_name, attr_value, context_salt, ctx)
        surface_user_condition_error(result, ctx) if result.is_a?(Comparators::ValidationError)
        result
      end

      # Surface + log the typed validation / malformed-operand outcomes the trace
      # replays. An attribute-invalid error → WARN 3004
      # (user_object_attribute_is_invalid); a malformed config operand (#509) →
      # WARN 3004 (comparison_value_is_invalid). Both also feed state.eval_error
      # (FR-016) the way the missing paths do.
      def surface_user_condition_error(result, ctx)
        ctx.state.eval_error ||= result.message
        m = INVALID_ATTR_RE.match(result.message)
        if m
          ctx.log.user_object_attribute_is_invalid(ctx.key, m[1], m[2])
        elsif result.is_a?(Comparators::ComparisonValueError)
          ctx.log.comparison_value_is_invalid(ctx.key, result.message)
        end
      end

      def dispatch_user_comparator(condition, attr_name, attr_value, context_salt, ctx)
        cmp = condition["c"]
        list = condition["l"] || []
        sv = condition["s"] || ""
        dv = condition["d"] || 0
        dispatch_comparator(cmp, attr_name, attr_value, list, sv, dv, ctx.config_salt, context_salt, condition["d"])
      end

      def dispatch_comparator(cmp, attr_name, attr_value, list, sv, dv, salt, context_salt, raw_dv = nil) # rubocop:disable Metrics/AbcSize,Metrics/CyclomaticComplexity,Metrics/MethodLength,Metrics/PerceivedComplexity
        c = Comparators
        text = -> { c.attribute_as_text(attr_value) }
        case cmp
        when c::TEXT_EQUALS, c::TEXT_NOT_EQUALS
          c.evaluate_text_equals(text.call, sv, cmp == c::TEXT_NOT_EQUALS)
        when c::SENSITIVE_TEXT_EQUALS, c::SENSITIVE_TEXT_NOT_EQUALS
          c.evaluate_sensitive_text_equals(text.call, sv, salt, context_salt, cmp == c::SENSITIVE_TEXT_NOT_EQUALS)
        when c::TEXT_IS_ONE_OF, c::TEXT_IS_NOT_ONE_OF
          c.evaluate_text_is_one_of(text.call, list, cmp == c::TEXT_IS_NOT_ONE_OF)
        when c::SENSITIVE_TEXT_IS_ONE_OF, c::SENSITIVE_TEXT_IS_NOT_ONE_OF
          c.evaluate_sensitive_text_is_one_of(text.call, list, salt, context_salt,
                                              cmp == c::SENSITIVE_TEXT_IS_NOT_ONE_OF)
        when c::TEXT_STARTS_WITH_ANY_OF, c::TEXT_NOT_STARTS_WITH_ANY_OF
          c.evaluate_text_slice_equals_any_of(text.call, list, true, cmp == c::TEXT_NOT_STARTS_WITH_ANY_OF)
        when c::SENSITIVE_TEXT_STARTS_WITH_ANY_OF, c::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF
          c.evaluate_sensitive_text_slice_equals_any_of(
            text.call, list, salt, context_salt, true, cmp == c::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF
          )
        when c::TEXT_ENDS_WITH_ANY_OF, c::TEXT_NOT_ENDS_WITH_ANY_OF
          c.evaluate_text_slice_equals_any_of(text.call, list, false, cmp == c::TEXT_NOT_ENDS_WITH_ANY_OF)
        when c::SENSITIVE_TEXT_ENDS_WITH_ANY_OF, c::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF
          c.evaluate_sensitive_text_slice_equals_any_of(
            text.call, list, salt, context_salt, false, cmp == c::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF
          )
        when c::TEXT_CONTAINS_ANY_OF, c::TEXT_NOT_CONTAINS_ANY_OF
          c.evaluate_text_contains_any_of(text.call, list, cmp == c::TEXT_NOT_CONTAINS_ANY_OF)
        when c::SEMVER_IS_ONE_OF, c::SEMVER_IS_NOT_ONE_OF
          r = c.attribute_as_semver(attr_name, attr_value)
          r.is_a?(c::ValidationError) ? r : c.evaluate_semver_is_one_of(r, list, cmp == c::SEMVER_IS_NOT_ONE_OF)
        when c::SEMVER_LESS, c::SEMVER_LESS_OR_EQUALS, c::SEMVER_GREATER, c::SEMVER_GREATER_OR_EQUALS
          # configcat-common validates the CONFIG comparison value BEFORE the
          # user attribute (#509): a malformed operand wins even when the
          # attribute is also malformed.
          cv = c.comparison_value_as_semver(sv)
          return cv if cv.is_a?(c::ValidationError)

          r = c.attribute_as_semver(attr_name, attr_value)
          r.is_a?(c::ValidationError) ? r : c.evaluate_semver_relation(r, cmp, sv)
        when c::NUMBER_EQUALS, c::NUMBER_NOT_EQUALS, c::NUMBER_LESS, c::NUMBER_LESS_OR_EQUALS,
             c::NUMBER_GREATER, c::NUMBER_GREATER_OR_EQUALS
          cv = c.comparison_value_as_number(raw_dv&.to_f)
          return cv if cv.is_a?(c::ValidationError)

          r = c.attribute_as_number(attr_name, attr_value)
          r.is_a?(c::ValidationError) ? r : c.evaluate_number_relation(r, cmp, dv.to_f)
        when c::DATETIME_BEFORE, c::DATETIME_AFTER
          cv = c.comparison_value_as_unix_time_seconds(raw_dv&.to_f)
          return cv if cv.is_a?(c::ValidationError)

          r = c.attribute_as_unix_time_seconds(attr_name, attr_value)
          r.is_a?(c::ValidationError) ? r : c.evaluate_datetime_relation(r, dv.to_f, cmp == c::DATETIME_BEFORE)
        when c::ARRAY_CONTAINS_ANY_OF, c::ARRAY_NOT_CONTAINS_ANY_OF
          r = c.attribute_as_string_array(attr_name, attr_value)
          if r.is_a?(c::ValidationError)
            r
          else
            c.evaluate_array_contains_any_of(r, list,
                                             cmp == c::ARRAY_NOT_CONTAINS_ANY_OF)
          end
        when c::SENSITIVE_ARRAY_CONTAINS_ANY_OF, c::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF
          r = c.attribute_as_string_array(attr_name, attr_value)
          if r.is_a?(c::ValidationError)
            r
          else
            c.evaluate_sensitive_array_contains_any_of(
              r, list, salt, context_salt, cmp == c::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF
            )
          end
        else
          c.error("unknown comparator #{cmp}")
        end
      end

      # Resolve a prerequisite-flag condition (US4) — child context, shared stack.
      def evaluate_prerequisite_condition(condition, ctx)
        prereq_type = lambda do |prereq_key|
          s = ctx.settings[prereq_key]
          t = s["t"] if s.is_a?(::Hash)
          t.is_a?(Integer) && !boolean?(t) ? t : nil
        end

        trace_prerequisite_condition(condition, ctx, prereq_type) unless ctx.log_builder.nil?

        evaluate_prereq_flag = ->(prereq_key) { evaluate_prereq_flag(prereq_key, ctx, prereq_type) }

        Prerequisites.evaluate_prerequisite_flag_condition(
          condition, ctx.key, ctx.visited_flags,
          prereq_type, evaluate_prereq_flag, method(:select_setting_value)
        )
      end

      # Trace the `Flag 'X' EQUALS 'Y'` condition before recursing (the
      # comparison value is read through the prereq flag's own declared type).
      def trace_prerequisite_condition(condition, ctx, prereq_type)
        prereq_key = condition["f"]
        cmp_text = ""
        if prereq_key.is_a?(String)
          pt = prereq_type.call(prereq_key)
          unless pt.nil?
            cmp_val = select_setting_value(condition["v"], pt)
            cmp_text = EvalLog.setting_value_to_log_string(cmp_val) unless cmp_val.nil?
          end
        end
        cmp = condition["c"]
        ctx.log_builder.append_prerequisite_flag_condition(
          prereq_key.is_a?(String) ? prereq_key : "",
          cmp.is_a?(Integer) && !boolean?(cmp) ? cmp : -1,
          cmp_text
        )
      end

      def evaluate_prereq_flag(prereq_key, ctx, prereq_type)
        prereq_setting = ctx.settings[prereq_key]
        unless prereq_setting.is_a?(::Hash)
          raise Prerequisites::PrerequisiteReferenceError, "Prerequisite flag is missing or invalid."
        end

        # A prerequisite flag evaluates in its OWN context (configcat
        # forPrerequisiteFlag): the no-user WARN dedups per flag, so a prereq
        # referenced by N rules logs it N times — hence a fresh state that
        # carries forward the already-surfaced eval_error (FR-016).
        lb = ctx.log_builder
        child_state = EvalState.new(ctx.state.eval_error, false)
        child = EvalContext.new(
          key: prereq_key, setting: prereq_setting, settings: ctx.settings,
          segments: ctx.segments, config_salt: ctx.config_salt, user: ctx.user,
          visited_flags: ctx.visited_flags, state: child_state, log: ctx.log, log_builder: lb
        )

        unless lb.nil?
          lb.new_line("(").increase_indent.new_line("Evaluating '#{prereq_key}'")
          lb.append(" for User '#{user_attributes_for_log_json(ctx.user)}'") unless ctx.user.nil?
        end
        resolved = evaluate_setting(child)
        ctx.state.eval_error ||= child_state.eval_error
        unless lb.nil?
          declared_type = prereq_type.call(prereq_key)
          child_value = declared_type.nil? ? nil : select_setting_value(resolved.value, declared_type)
          lb.new_line("Returning '#{EvalLog.setting_value_to_log_string(child_value)}'.")
            .decrease_indent.new_line(")")
        end
        resolved.value
      end

      # Resolve a segment condition (US4) — segment name as the context salt.
      #
      # On the no-trace hot path this delegates to
      # `Segments.evaluate_segment_condition` unchanged. When tracing is on it
      # ports `evaluator.ts::evaluateSegmentCondition` incl. its nested `( … )`
      # block: the segment's `r[]` is an AND-group of bare user conditions routed
      # through `evaluate_conditions` so the trace renders the IF/AND structure
      # (the segment NAME is the sensitive-comparator context salt).
      def evaluate_segment_condition(condition, ctx)
        return evaluate_segment_condition_hot(condition, ctx) if ctx.log_builder.nil?

        evaluate_segment_condition_traced(condition, ctx)
      end

      def evaluate_segment_condition_hot(condition, ctx)
        surface = lambda do
          surface_missing_user(ctx)
          MISSING_USER_OBJECT_ERROR
        end

        Segments.evaluate_segment_condition(
          condition, ctx.segments, !ctx.user.nil?, surface,
          ->(uc, salt) { evaluate_user_condition(uc, salt, ctx) }
        )
      end

      # Traced path (mirrors Go's evaluateSegmentCond). Resolve the segment name
      # first so the `User IS [NOT] IN SEGMENT 'X'` line is appended before the
      # no-user / reference guards, exactly like the oracle.
      def evaluate_segment_condition_traced(condition, ctx)
        lb = ctx.log_builder
        segment = resolve_segment(condition, ctx)
        segment_name = segment.is_a?(::Hash) && segment["n"].is_a?(String) ? segment["n"] : ""
        cmp = condition["c"]
        cmp_int = cmp.is_a?(Integer) && !boolean?(cmp) ? cmp : Segments::SEGMENT_IS_IN
        lb.append_segment_condition(segment_name, cmp_int)

        if ctx.user.nil?
          surface_missing_user(ctx)
          return Comparators.error(MISSING_USER_OBJECT_ERROR)
        end
        raise Segments::SegmentReferenceError, "Segment reference is invalid." if segment.nil? || segment_name == ""

        lb.new_line("(").increase_indent.new_line("Evaluating segment '#{segment_name}':")
        wrapped = (segment["r"] || []).map { |uc| { "u" => uc } }
        in_segment = evaluate_conditions(wrapped, segment_name, ctx, nil)
        trace_segment_result(lb, segment_name, cmp_int, in_segment, ctx)
      end

      def resolve_segment(condition, ctx)
        index = condition["s"]
        return nil unless index.is_a?(Integer) && !boolean?(index) && index >= 0 && index < ctx.segments.length

        candidate = ctx.segments[index]
        candidate.is_a?(::Hash) ? candidate : nil
      end

      def trace_segment_result(builder, segment_name, cmp_int, in_segment, ctx)
        errored = in_segment.is_a?(Comparators::ValidationError)
        # IsNotIn negates a clean boolean outcome; an errored segment is surfaced
        # un-negated — IsNotIn never flips an error into a match.
        result = in_segment
        result = !in_segment if !errored && cmp_int == Segments::SEGMENT_IS_NOT_IN

        builder.new_line("Segment evaluation result: ")
        if errored
          builder.append(ctx.state.eval_error || "")
        else
          builder.append(in_segment == true ? "User IS IN SEGMENT" : "User IS NOT IN SEGMENT")
        end
        builder.append(".")
        builder.new_line("Condition (").append_segment_condition(segment_name, cmp_int).append(")")
        if errored
          builder.append(" failed to evaluate")
        else
          builder.append(" evaluates to ").append_condition_result(result == true)
        end
        builder.append(".").decrease_indent.new_line(")")

        return Comparators.error(ctx.state.eval_error || MISSING_USER_OBJECT_ERROR) if errored

        result
      end

      # Surface the "User Object is missing" reason once per context (FR-016).
      # Also logs the WARN 3001 once per context (common-js parity).
      def surface_missing_user(ctx)
        ctx.state.eval_error ||= MISSING_USER_OBJECT_ERROR
        return if ctx.state.missing_user_object_logged

        ctx.log.user_object_is_missing(ctx.key)
        ctx.state.missing_user_object_logged = true
      end

      def missing_user_attribute_error(attr)
        "cannot evaluate, the User.#{attr} attribute is missing"
      end

      # Read a well-known or custom attribute off a user-like object. Mirrors
      # `user.ts::getUserAttribute`: `Identifier` → identifier ?? "", `Email` →
      # email, `Country` → country, else → custom[name]. Returns nil for an
      # absent attribute (the evaluator treats nil and "" as "missing"). Reads
      # are duck-typed (`identifier/email/country/custom` readers) so the corpus
      # harness can feed typed custom values without redesigning the public
      # `Confeature::User`.
      def get_user_attribute(user, name)
        case name
        when IDENTIFIER_ATTRIBUTE then user_identifier(user)
        when EMAIL_ATTRIBUTE then user.email
        when COUNTRY_ATTRIBUTE then user.country
        else
          custom = user.custom
          custom.is_a?(::Hash) ? custom[name] : nil
        end
      end

      def user_identifier(user)
        id = user.identifier
        id.nil? ? "" : id
      end

      def boolean?(value)
        [true, false].include?(value)
      end
    end
  end
end
