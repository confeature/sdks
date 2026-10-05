# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "../flag_overrides"
require_relative "evaluator"

module Confeature
  module Internal
    # Synchronous override evaluation — Ruby port of `EvaluateSync`.
    #
    # Byte-identical 7-branch decision tree from
    # `apps/sdk-go/internal/overrideeval/eval.go` (Go) and
    # `packages/sdk-shared/src/override-eval.ts` (TS canonical). The
    # Python port lives at
    # `apps/sdk-python/src/confeature_client/override_eval.py`. The
    # parity corpus is the canonical gate.
    #
    # The helper is intentionally pure: no logger access, no SDK-key
    # access, no I/O. Pure data in → tuple `[found, value]` out.
    #
    # Returns:
    #   - `[false, nil]` when overrides are absent, behaviour is
    #     non-LocalOnly, or no synchronous data source is available
    #     (Branches 1-3: caller falls through to the cache).
    #   - `[true, <value>]` when overrides + LocalOnly + key match
    #     (Branch 7 — typed override value); also
    #     `[true, default_value]` for the LocalOnly fallback branches
    #     4-6 (key absent / empty slot / TYPE_MISMATCH).
    module OverrideEval
      module_function

      def evaluate_sync(flag_overrides, key, default_value)
        # Branch 1: no overrides configured → caller falls through.
        return [false, nil] if flag_overrides.nil?

        # Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
        return [false, nil] if flag_overrides.behaviour != OverrideBehaviour::LOCAL_ONLY

        # Branch 3: no synchronous data source available → fall through.
        data_source = flag_overrides.data_source
        return [false, nil] if data_source.nil?
        return [false, nil] unless data_source.respond_to?(:get_overrides_sync)

        overrides_map = data_source.get_overrides_sync
        return [false, nil] if overrides_map.nil?

        # From here we are committed to the LocalOnly contract: NEVER
        # fall through to the cache — return either the typed override
        # or the supplied default.

        # Branch 4: key absent → return default.
        raw = overrides_map[key]
        return [true, default_value] if raw.nil?

        # Branch 5: override slot empty → return default.
        candidate = raw.picked
        return [true, default_value] if candidate.nil?

        # Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
        # A `nil` default_value intentionally bypasses the check (matches
        # configcat-js's `defaultValue !== null` ternary). In Ruby
        # `true.class` and `false.class` differ (TrueClass / FalseClass)
        # — treat both as the same "boolean" bucket so a `true`
        # override matched against a `false` default is NOT a type
        # mismatch.
        if !default_value.nil? && !boolean_kind_match?(candidate, default_value) &&
           candidate.class != default_value.class
          return [true, default_value]
        end

        # Branch 7: happy path — typed override value.
        [true, candidate]
      end

      def boolean_kind_match?(candidate, default_value)
        boolean?(candidate) && boolean?(default_value)
      end

      def boolean?(value)
        value.is_a?(TrueClass) || value.is_a?(FalseClass)
      end

      # Full-config override resolution — Ruby port of
      # `evaluateFullConfigOverrideSync` (spec 135 / #431).
      #
      # When the override source is a `ConfigOverrideDataSource`, resolve
      # `key` through the real Ruby evaluator so targeting rules /
      # segments / prerequisites / percentage options apply offline — the
      # rule-bearing sibling of `evaluate_sync`'s flat lookup.
      #
      # Returns:
      #   - `[true, <value>]` when overrides + LocalOnly + a
      #     `ConfigOverrideDataSource` apply (LocalOnly: never fall
      #     through to the cache — the evaluator already returns
      #     `default_value` for any non-clean resolution, so this
      #     preserves the contract);
      #   - `[false, nil]` when overrides are absent, behaviour is
      #     non-LocalOnly, or the source is NOT a full-config source
      #     (caller falls through to the flat-map helper / normal eval).
      #
      # INV-4: the evaluator receives the FULL config Hash (`{ p, f, s }`)
      # — salt (`p.s`) + segments (`s`), never just `f` (the spec-129
      # dropped-salt regression class).
      def evaluate_full_config_override_sync(flag_overrides, key, default_value, user)
        return [false, nil] if flag_overrides.nil?
        return [false, nil] if flag_overrides.behaviour != OverrideBehaviour::LOCAL_ONLY

        data_source = flag_overrides.data_source
        return [false, nil] unless data_source.is_a?(ConfigOverrideDataSource)

        # Pass the FULL config Hash (salt + segments + f), never just `f`
        # (INV-4).
        result = Evaluator.evaluate(data_source.config, key, default_value, user)
        [true, result.value]
      end

      # Details-returning sibling of `evaluate_full_config_override_sync`
      # (spec 152 / #475, US2 — Ruby port of Python's
      # `evaluate_full_config_override_details_sync`).
      #
      # Resolves `key` through the real evaluator and returns the full
      # `EvaluationResult` (value + served `variation_id` + matched
      # rule / option) so the PUBLIC `get_value_details` surfaces the
      # override's identity. Closes the #395 gap class: the snapshot's
      # LocalOnly details branch previously routed a
      # `ConfigOverrideDataSource` through the value-only flat-map helper
      # (which cannot read rule-bearing settings and never carries a
      # `variation_id`).
      #
      # Returns:
      #   - `[true, <EvaluationResult>]` when overrides + LocalOnly + a
      #     `ConfigOverrideDataSource` apply;
      #   - `[false, nil]` when overrides are absent, behaviour is
      #     non-LocalOnly, or the source is NOT a full-config source
      #     (caller falls through to the flat-map details branch —
      #     unchanged value-only override semantics).
      #
      # INV-4: the evaluator receives the FULL config Hash (`{ p, f, s }`)
      # — salt (`p.s`) + segments (`s`), never just `f`.
      def evaluate_full_config_override_details_sync(flag_overrides, key, default_value, user)
        return [false, nil] if flag_overrides.nil?
        return [false, nil] if flag_overrides.behaviour != OverrideBehaviour::LOCAL_ONLY

        data_source = flag_overrides.data_source
        return [false, nil] unless data_source.is_a?(ConfigOverrideDataSource)

        # Pass the FULL config Hash (salt + segments + f), never just `f`
        # (INV-4).
        result = Evaluator.evaluate(data_source.config, key, default_value, user)
        [true, result]
      end

      # Shared override router — Ruby port of `evaluateOverride`
      # (spec 135 / #431).
      #
      # Dispatches between the flat-map path and the full-config path so
      # the `get_value` call site changes minimally: a
      # `ConfigOverrideDataSource` routes through the real evaluator;
      # every other source (map / custom) keeps the existing
      # byte-identical flat-map resolution.
      #
      # Returns `[found, value]` — `[false, nil]` when no override applies
      # (the caller then falls through to the normal cache-driven eval).
      # Preserves the LocalOnly no-fall-through contract on both paths.
      def evaluate(flag_overrides, key, default_value, user)
        # Full-config source → ALWAYS resolve through the evaluator; NEVER
        # fall through to the flat-map path (which would mis-read
        # rule-bearing settings as value-only). Dispatch on the source
        # TYPE, not the resolved value, so a full-config source whose
        # evaluator returns the default still stays on the rule path.
        if !flag_overrides.nil? &&
           flag_overrides.behaviour == OverrideBehaviour::LOCAL_ONLY &&
           flag_overrides.data_source.is_a?(ConfigOverrideDataSource)
          return evaluate_full_config_override_sync(flag_overrides, key, default_value, user)
        end

        # Every other source (map / custom) keeps the byte-identical
        # flat-map path.
        evaluate_sync(flag_overrides, key, default_value)
      end
    end
  end
end
