// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * v1 placeholder type returned by [EvaluationDetails.matchedTargetingRule].
 *
 * The v1 evaluator produces no targeting-rule matches; this type exists only so the
 * upstream-aligned property has a non-`Any` declared type and so customer code that compiles
 * against `com.configcat.TargetingRule` (via reflection / generic plumbing) keeps a matching type
 * to reference. Bodies populated in a future targeting-rules spec.
 *
 * The constructor is `internal` — the only legitimate value reaching customers in v1 is `null`.
 */
public class TargetingRule internal constructor()
