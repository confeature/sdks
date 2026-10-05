// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * v1 placeholder type returned by [TypedEvaluationDetails.matchedPercentageOption].
 *
 * <p>The v1 evaluator produces no percentage-option matches; this type exists only so the
 * upstream-aligned property has a non-`Any` declared return type. Bodies populated in a future
 * targeting-rules spec.
 *
 * <p>The constructor is `internal` — the only legitimate value reaching customers in v1 is `null`.
 */
public class PercentageOption internal constructor()
