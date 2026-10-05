// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * Marker type returned by {@link EvaluationDetails#getMatchedPercentageOption()} — non-{@code null}
 * when a percentage option decided the evaluated value (spec 126).
 *
 * <p>Mirrors {@code com.configcat.PercentageOption} as the declared return type. The Confeature
 * evaluator consumes the option from the raw parsed config map, so this type carries no option
 * fields; its presence (vs {@code null}) signals that a percentage option matched.
 */
public final class PercentageOption {

  /** The single shared marker instance — present iff a percentage option decided the value. */
  static final PercentageOption MATCHED = new PercentageOption();

  private PercentageOption() {
    // Constructed only as the shared MATCHED marker.
  }
}
