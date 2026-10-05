// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/** Android: the VM's own failures, as on the JVM — see the `expect` declaration. */
@Suppress("DEPRECATION") // ThreadDeath is deprecated on recent JDKs; ART can still raise it.
internal actual fun isFatalError(error: Throwable): Boolean =
    error is VirtualMachineError || error is ThreadDeath || error is LinkageError
