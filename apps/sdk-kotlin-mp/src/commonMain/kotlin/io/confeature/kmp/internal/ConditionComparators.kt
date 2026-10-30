// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * ConfigCat's `PrerequisiteFlagComparator` codes. [ConditionEvaluator] decides with them and
 * [EvalLog] traces them, so they live apart from both and from [Evaluator] (#928).
 */
internal object PrerequisiteComparator {
    const val EQUALS: Int = 0
    const val NOT_EQUALS: Int = 1
}

/** ConfigCat's `SegmentComparator` codes; see [PrerequisiteComparator] for why they live here. */
internal object SegmentComparator {
    const val IS_IN: Int = 0
    const val IS_NOT_IN: Int = 1
}
