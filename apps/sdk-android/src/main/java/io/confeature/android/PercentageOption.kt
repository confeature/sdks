// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * v1 placeholder type returned by [EvaluationDetails.matchedPercentageOption].
 *
 * The v1 evaluator produces no percentage-option matches; this type exists only so the
 * upstream-aligned property has a non-`Any` declared return type. Bodies populated in a future
 * targeting-rules spec.
 *
 * The constructor is `internal` — the only legitimate value reaching customers in v1 is `null`.
 */
public class PercentageOption internal constructor()
