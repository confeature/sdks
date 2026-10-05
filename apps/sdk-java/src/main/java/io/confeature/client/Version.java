// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * SDK version constant. Stamped into the User-Agent by {@link
 * io.confeature.client.internal.ConfigFetcher} and surfaced to callers that want to log the running
 * SDK version.
 *
 * <p>Mirrors {@code apps/sdk-go/version.go} and {@code apps/sdk-dotnet/.../Version.cs} exactly —
 * the value MUST track the artefact version declared in {@code build.gradle.kts}.
 */
public final class Version {

  /** Current SDK version (matches {@code build.gradle.kts:version}). */
  public static final String SDK_VERSION = "0.1.0";

  private Version() {
    // Utility class — not instantiable.
  }
}
