// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * SDK version constant. Stamped into the User-Agent by [io.confeature.kmp.internal.ConfigFetcher]
 * and surfaced to callers that want to log the running SDK version.
 *
 * <p>Mirrors `apps/sdk-java/.../Version.java` exactly — the value MUST track the artefact version
 * declared in `build.gradle.kts`.
 */
public object Version {
    /** Current SDK version (matches `build.gradle.kts:version`). */
    public const val SDK_VERSION: String = "0.1.0"
}
