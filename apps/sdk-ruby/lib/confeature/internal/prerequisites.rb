# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  module Internal
    # Prerequisite-flag condition resolution + circular-dependency detection.
    # Ported from the spec-117 TS reference
    # (`packages/sdk-shared/src/prerequisites.ts`) and the spec-118 Python port,
    # itself from common-js `RolloutEvaluator.evaluatePrerequisiteFlagCondition`.
    #
    # A prerequisite condition (`{ "f" => key, "c" => comparator, "v" => env }`)
    # is resolved by **re-evaluating the prerequisite flag** in a child context
    # (same config / user, SHARED `visited_flags` list), then comparing its
    # resolved value to the expected `v` via the comparator (`Equals` /
    # `NotEquals`). Both the resolved value and `v` are read through the
    # prerequisite flag's own declared `SettingType`.
    #
    # **Cycle detection** uses the shared `visited_flags` list: push the CURRENT
    # key, check whether the prerequisite key is already on the list BEFORE
    # recursing — if so, push the prerequisite key too and raise
    # `CircularDependencyError`. The outer `evaluate` rescue-all turns that into
    # a fail-closed fallback + error, so a cycle is **bounded** (the key set is
    # finite; the second visit raises) — never a hang, never a `SystemStackError`
    # escape (FR-007, SC-004). On the non-cycle path the current key is popped
    # after the child evaluation returns, restoring the list for siblings.
    module Prerequisites
      PREREQUISITE_EQUALS = 0
      PREREQUISITE_NOT_EQUALS = 1

      # Raised on a detected prerequisite cycle (caught by `evaluate`'s frame).
      # `cycle` carries the `key -> … -> key` chain so the trace logger can emit
      # ConfigCat's distinct ERROR 1002 line (`[<cycle>]`) without re-parsing the
      # message (mirrors the .NET / Rust ports).
      class CircularDependencyError < StandardError
        attr_reader :cycle

        def initialize(cycle)
          @cycle = cycle
          super("Circular dependency detected between the following depending flags: #{cycle}.")
        end
      end

      # A missing / invalid prerequisite flag — a fatal config error
      # (fail-closed, caught by the evaluator's rescue-all).
      class PrerequisiteReferenceError < StandardError; end

      module_function

      # Resolve one prerequisite-flag condition. The setting re-evaluator +
      # value selector are injected so this module has no back-reference to the
      # evaluator. Returns the comparison result (`true` / `false`). Raises
      # `CircularDependencyError` on a detected cycle or
      # `PrerequisiteReferenceError` on a missing prerequisite flag.
      def evaluate_prerequisite_flag_condition(
        condition, current_key, visited_flags, prereq_type, evaluate_prereq_flag, select_value
      )
        prereq_key = condition["f"]
        raise PrerequisiteReferenceError, "Prerequisite flag key is missing or invalid." unless prereq_key.is_a?(String)

        declared_type = prereq_type.call(prereq_key)
        raise PrerequisiteReferenceError, "Prerequisite flag is missing or invalid." if declared_type.nil?

        # The expected comparison value `v`, read through the prereq flag's type.
        comparison_value = select_value.call(condition["v"], declared_type)

        # Cycle detection: push current key, detect a revisit BEFORE recursing.
        visited_flags.push(current_key)
        if visited_flags.include?(prereq_key)
          visited_flags.push(prereq_key)
          raise CircularDependencyError, visited_flags.join(" -> ")
        end

        resolved_envelope = evaluate_prereq_flag.call(prereq_key)
        # Restore the list for sibling prerequisites (common-js pops here).
        visited_flags.pop

        resolved_value = select_value.call(resolved_envelope, declared_type)

        case condition["c"]
        when PREREQUISITE_EQUALS then resolved_value == comparison_value
        when PREREQUISITE_NOT_EQUALS then resolved_value != comparison_value
        else raise PrerequisiteReferenceError, "Comparison operator is missing or invalid."
        end
      end
    end
  end
end
