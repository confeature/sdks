// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * Marker type returned by {@link EvaluationDetails#getMatchedTargetingRule()} — non-{@code null}
 * when a targeting rule decided the evaluated value (spec 126).
 *
 * <p>Mirrors {@code com.configcat.TargetingRule} as the declared return type so customer code that
 * compiles against the upstream type keeps a matching reference. The Confeature evaluator consumes
 * the rule from the raw parsed config map, so this type carries no rule fields; its presence (vs
 * {@code null}) signals that a rule matched.
 */
public final class TargetingRule {

  /** The single shared marker instance — present iff a targeting rule decided the value. */
  static final TargetingRule MATCHED = new TargetingRule();

  private TargetingRule() {
    // Constructed only as the shared MATCHED marker.
  }
}
