// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.darwin.Darwin

/**
 * iOS Ktor engine — Darwin (NSURLSession-backed). Matches Apple's `URLSession` semantics:
 * background-eligible connections, automatic HTTP/2, App Transport Security enforcement.
 *
 * <p>The Darwin engine is the only Ktor engine that integrates with Apple's network stack
 * directly, which is the canonical choice for iOS / macOS / watchOS / tvOS builds. Compiles only
 * on macOS hosts.
 */
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient =
    HttpClient(Darwin) { block() }
