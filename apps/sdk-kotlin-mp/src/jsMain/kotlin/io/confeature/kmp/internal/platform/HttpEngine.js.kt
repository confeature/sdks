// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.js.Js

/**
 * JS Ktor engine — `Js`, which delegates to:
 *
 * - Browser: `fetch` (with `XMLHttpRequest` fallback for older browsers).
 * - Node 18+: the built-in `fetch` implementation.
 *
 * <p>Multiplatform Kotlin/JS targets both runtimes from the same source set — no further
 * branching needed at the engine layer.
 */
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient =
    HttpClient(Js) { block() }
