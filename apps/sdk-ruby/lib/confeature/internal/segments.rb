# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "comparators"

module Confeature
  module Internal
    # Segment-condition resolution (v6 + legacy v5). Ported from the spec-117 TS
    # reference (`packages/sdk-shared/src/segments.ts`) and the spec-118 Python
    # port, itself from common-js `RolloutEvaluator.evaluateSegmentCondition`.
    #
    # A segment condition (`{ "s" => index, "c" => comparator }`) references a
    # segment by index into the config's top-level `s[]` (`{ "n" => name,
    # "r" => [...] }`) and a comparator (`IsIn` / `IsNotIn`). The segment's `r[]`
    # entries are **bare user conditions**, AND-grouped: the user IS-IN the
    # segment iff every condition matches. The decision is then optionally
    # negated by `IsNotIn`.
    #
    # The **sensitive-comparator context salt is the segment NAME** (`n`), NOT
    # the setting key — the crucial divergence from a user condition; getting it
    # wrong silently breaks every hashed segment row.
    #
    # Three-valued outcome: `true` (in segment per the comparator), `false` (not
    # in segment), or a `Comparators::ValidationError`. An error is returned
    # **un-negated** — `IsNotIn` never flips an error into a match.
    module Segments
      SEGMENT_IS_IN = 0
      SEGMENT_IS_NOT_IN = 1

      # A malformed segment reference / name — a fatal config error (fail-closed,
      # caught by the evaluator's rescue-all).
      class SegmentReferenceError < StandardError; end

      module_function

      # Resolve one segment condition. `evaluate_user_condition` is injected (the
      # evaluator owns it) so this module has no back-reference to the evaluator;
      # it evaluates one segment `r[]` user condition with the segment NAME as
      # the context salt.
      def evaluate_segment_condition(condition, segments, has_user, surface_missing_user, evaluate_user_condition)
        # No user → the whole segment condition is the missing-user error
        # (surfaced once per context), exactly like a user condition.
        return Comparators.error(surface_missing_user.call) unless has_user

        index = condition["s"]
        unless index.is_a?(Integer) && !boolean?(index) && index >= 0 && index < segments.length
          raise SegmentReferenceError, "Segment reference is invalid."
        end

        segment = segments[index]
        segment_name = segment["n"]
        unless segment_name.is_a?(String) && !segment_name.empty?
          raise SegmentReferenceError,
                "Segment name is missing."
        end

        # The segment's `r[]` is an AND-group of BARE user conditions; the
        # context salt is the segment NAME. Short-circuit on first non-match.
        in_segment = true
        (segment["r"] || []).each do |uc|
          in_segment = evaluate_user_condition.call(uc, segment_name)
          break if in_segment != true
        end

        # An error is returned un-negated — IsNotIn never converts an error into
        # a match (matches common-js: the comparator switch only runs when the
        # segment result is a clean bool).
        return in_segment unless [true, false].include?(in_segment)

        condition["c"] == SEGMENT_IS_NOT_IN ? !in_segment : in_segment
      end

      def boolean?(value)
        [true, false].include?(value)
      end
    end
  end
end
