// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature.consumer

import android.app.Activity
import android.os.Bundle
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

class FixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        (::main).startCoroutine(Continuation(EmptyCoroutineContext) { it.getOrThrow() })
    }
}
