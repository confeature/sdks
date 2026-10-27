// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * The setting's `t` discriminator, matching ConfigCat's `SettingType` (`Bool=0`, `String=1`,
 * `Int=2`, `Double=3`). It selects the value slot: `0→v.b`, `1→v.s`, `2→v.i`, `3→v.d`.
 *
 * A module of its own so [Evaluator] and [ConfigValues] both read it without depending on each
 * other (#928).
 */
internal object SettingType {
    const val BOOL: Int = 0
    const val STRING: Int = 1
    const val INT: Int = 2
    const val DOUBLE: Int = 3
}
