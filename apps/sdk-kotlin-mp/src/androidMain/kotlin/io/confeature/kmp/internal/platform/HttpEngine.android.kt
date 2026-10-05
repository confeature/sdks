// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.okhttp.OkHttp

/**
 * Android Ktor engine — OkHttp. The OkHttp engine integrates with Android's connection pool
 * lifecycle and HTTP/2 stack, which is the canonical choice for Android apps. Mirrors the
 * sdk-android SDK's HTTP client.
 */
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient =
    HttpClient(OkHttp) { block() }
