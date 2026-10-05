// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/** JVM: the VM's own failures — see the `expect` declaration. */
@Suppress("DEPRECATION") // ThreadDeath is deprecated (JDK 20+) yet still thrown by Thread.stop on JDK 11.
internal actual fun isFatalError(error: Throwable): Boolean =
    error is VirtualMachineError || error is ThreadDeath || error is LinkageError
