# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  module Internal
    # Evaluation logger surface (ADR 0003 / epic #494, Ruby slice of #501).
    #
    # The WARN / ERROR / INFO lines the federated evaluator emits during a trace,
    # ported from `packages/sdk-shared/src/logger.ts` (the `LoggerWrapper`
    # helpers `userObjectIsMissing` / `userObjectAttributeIsMissing` /
    # `userObjectAttributeIsMissingForPercentage` / `userObjectAttributeIsInvalid`
    # / `comparisonValueIsInvalid` / `circularDependency`) and the INFO 5000 trace
    # emission point in `evaluator.ts`. Mirrors the Go / Python ports so the
    # federation ports stay consistent.
    #
    # The strings are ported VERBATIM from logger.ts (Principle II —
    # byte-identical to the canonical). The capture format the parity test
    # reconstructs is `"<LEVEL>: [<eventId>] <message>"` per emitted call, joined
    # by "\n", with the INFO 5000 entry carrying the multi-line indented trace.
    #
    # This trace-logging seam is intentionally distinct from the public
    # `Confeature::Logger`: a customer-supplied logger has the
    # `error/warning/info/debug` shape, while the trace test taps a structured
    # `(level, event_id, message)` recorder. Keeping them separate matches the Go
    # / Python factoring and keeps the no-trace hot path zero-cost.
    module EvalLogger
      # Mirrors configcat-common's numeric ordering (logger.ts `LogLevel`). Level
      # filtering ("Info and above") works identically across SDKs. Distinct from
      # the public `Confeature::LogLevel` (stdlib ordering), used ONLY for the
      # trace seam so the gating matches the canonical reference exactly.
      module TraceLevel
        OFF = -1
        ERROR = 1
        WARN = 2
        INFO = 3
        DEBUG = 4
      end

      # Internal logger adapter threaded through the evaluation context. Mirrors
      # logger.ts `LoggerWrapper`: a `nil` inner means tracing is off (zero
      # cost), and every helper is level-gated at the boundary.
      #
      # The injected `inner` is any object responding to `level` (→ a
      # `TraceLevel`) and `log(level, event_id, message)` — the seam the parity
      # test's capture logger implements.
      class TraceLog
        def initialize(inner)
          @inner = inner
        end

        def enabled?(level)
          return false if @inner.nil?

          threshold = @inner.level
          return false if threshold == TraceLevel::OFF

          level <= threshold
        end

        # WARN 3001 (verbatim from logger.ts `userObjectIsMissing`).
        def user_object_is_missing(key)
          emit(
            TraceLevel::WARN, "3001",
            "cannot evaluate targeting rules and % options for setting '#{key}' " \
            "(User Object is missing); you should pass a User Object to the evaluation " \
            "methods like `getValue()` in order to make targeting work properly; read more: " \
            "https://configcat.com/docs/advanced/user-object/"
          )
        end

        # WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`).
        def user_object_attribute_is_missing(key, attribute_name)
          emit(
            TraceLevel::WARN, "3003",
            "cannot evaluate certain targeting rules of setting '#{key}' " \
            "(the User.#{attribute_name} attribute is missing); you should set the " \
            "User.#{attribute_name} attribute in order to make targeting work properly; " \
            "read more: https://configcat.com/docs/advanced/user-object/"
          )
        end

        # WARN 3003, % options variant (verbatim from logger.ts).
        def user_object_attribute_is_missing_for_percentage(key, attribute_name)
          emit(
            TraceLevel::WARN, "3003",
            "cannot evaluate % options for setting '#{key}' " \
            "(the User.#{attribute_name} attribute is missing); you should set the " \
            "User.#{attribute_name} attribute in order to make targeting work properly; " \
            "read more: https://configcat.com/docs/advanced/user-object/"
          )
        end

        # WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`).
        def user_object_attribute_is_invalid(key, attribute_name, reason)
          emit(
            TraceLevel::WARN, "3004",
            "cannot evaluate certain targeting rules of setting '#{key}' " \
            "(the User.#{attribute_name} attribute is invalid (#{reason})); please check the " \
            "User.#{attribute_name} attribute and make sure that its value corresponds to the " \
            "comparison operator"
          )
        end

        # WARN 3004, malformed config operand (#509). Note there is NO "please
        # check the User.<attr>…" suffix (verbatim from logger.ts
        # `comparisonValueIsInvalid`). `inner_message` is the full
        # `comparison value '<v>' is invalid (<reason>)` text.
        def comparison_value_is_invalid(key, inner_message)
          emit(
            TraceLevel::WARN, "3004",
            "cannot evaluate certain targeting rules of setting '#{key}' (#{inner_message})"
          )
        end

        # ERROR 1002 (verbatim from logger.ts `circularDependency`).
        def circular_dependency(key, cycle)
          emit(
            TraceLevel::ERROR, "1002",
            "failed to evaluate setting '#{key}' (circular dependency detected between the " \
            "following depending flags: [#{cycle}])"
          )
        end

        # INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`.
        def info(event_id, message)
          emit(TraceLevel::INFO, event_id, message)
        end

        private

        def emit(level, event_id, message)
          return unless enabled?(level)

          @inner.log(level, event_id, message)
        end
      end
    end
  end
end
