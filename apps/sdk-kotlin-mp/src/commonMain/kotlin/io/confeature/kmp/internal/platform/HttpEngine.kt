// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig

/**
 * Multiplatform Ktor [HttpClient] factory. Each target provides an `actual` implementation:
 *
 * - JVM: CIO engine.
 * - Android: OkHttp engine.
 * - iOS: Darwin engine.
 * - JS: Js engine (Fetch / XHR).
 *
 * <p>The [block] lets the common-side [io.confeature.kmp.internal.ConfigFetcher] install
 * timeouts, default headers, and plugins (JSON, Logging) before the engine is bound.
 */
public expect fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient
