// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.cio.CIO

/**
 * JVM Ktor engine — CIO (coroutine-based I/O, pure-Kotlin, no native deps). Mirrors the Java
 * SDK's OkHttp choice from a behaviour standpoint (synchronous customer contract via the
 * suspend boundary) but uses Ktor's recommended JVM engine to stay multiplatform-pure.
 */
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient =
    HttpClient(CIO) { block() }
