// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/**
 * True when [error] is a fatal runtime error that no library may swallow (#803).
 *
 * <p>The fetcher catches `Throwable`, not `Exception`, because Ktor's JS engine surfaces a failed
 * browser `fetch` as a plain `kotlin.Error`; that catch must not also turn the VM's own failures
 * into a "network error" result. Each target names its fatal errors:
 *
 * - JVM / Android: `VirtualMachineError` (`OutOfMemoryError`, `StackOverflowError`, `InternalError`,
 *   `UnknownError`), `ThreadDeath` and `LinkageError` — the set JVM libraries conventionally
 *   rethrow (e.g. Scala's `NonFatal`).
 * - iOS (Kotlin/Native) and JS: none — Kotlin/Native terminates the process on these conditions
 *   instead of throwing, and every `Error` a JS engine raises is a recoverable script error.
 */
internal expect fun isFatalError(error: Throwable): Boolean
