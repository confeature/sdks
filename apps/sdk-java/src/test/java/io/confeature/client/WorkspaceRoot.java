// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Test helper — locates the cross-language fixtures directory.
 *
 * <p>The fixtures live in {@code packages/test-fixtures-sdk-parity/fixtures/} at the repo root.
 * Resolution strategy:
 *
 * <ol>
 *   <li>Read the {@code confeature.repo.root} system property (set by {@code build.gradle.kts}).
 *   <li>Otherwise walk up from {@code user.dir} until a sibling {@code pnpm-workspace.yaml}
 *       appears.
 * </ol>
 */
public final class WorkspaceRoot {

  private WorkspaceRoot() {
    // Utility.
  }

  /** Returns the absolute path of the repo root. */
  public static Path repoRoot() {
    final String prop = System.getProperty("confeature.repo.root");
    if (prop != null && !prop.isEmpty()) {
      return Paths.get(prop).toAbsolutePath();
    }
    Path cursor = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
    while (cursor != null) {
      if (Files.exists(cursor.resolve("pnpm-workspace.yaml"))) {
        return cursor;
      }
      cursor = cursor.getParent();
    }
    throw new IllegalStateException(
        "Could not locate repo root from " + System.getProperty("user.dir"));
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json}. */
  public static Path parityCorpusPath() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json");
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-configs.json}. */
  public static Path parityConfigsPath() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs.json");
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json}. */
  public static Path cacheKeyFixturesPath() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json");
  }

  /**
   * Path to {@code packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json} — the one
   * accept/reject list of SDK-key shapes every SDK validator is tested against (#802).
   */
  public static Path sdkKeyShapesPath() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json");
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json}. */
  public static Path parityCorpusTypedPath() {
    return repoRoot()
        .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json");
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json}. */
  public static Path parityConfigsTypedPath() {
    return repoRoot()
        .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json");
  }

  /**
   * Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json} — the
   * 8-tuple targeting-rule corpus (spec 135 / #430, epic #382, US3), injected via the full-config
   * offline override and consumed verbatim.
   */
  public static Path parityCorpusRulesPath() {
    return repoRoot()
        .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json");
  }

  /**
   * Path to {@code packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json} — the full
   * {@code {p, f, s}} rule corpus configs ({@code injectionMode: "full-config"}). Consumed verbatim
   * by the targeting-rule parity tier.
   */
  public static Path parityConfigsRulesPath() {
    return repoRoot()
        .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json");
  }

  /** Path to {@code packages/test-fixtures-sdk-parity/fixtures/wire-cases.json}. */
  public static Path wireCasesPath() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/wire-cases.json");
  }

  /** Directory containing the cross-language fixtures (resolves bodyRef siblings). */
  public static Path fixturesDir() {
    return repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures");
  }

  /**
   * Absolute path into the vendored upstream ConfigCat conformance corpus ({@code
   * packages/test-fixtures-sdk-parity/fixtures/upstream/}), shared read-only with specs 117–125.
   * The corpus test ({@link EvaluatorUpstreamCorpusTest}) reads the testmatrix CSVs + {@code
   * evaluationlog/} + {@code comparison_*.json} through this accessor.
   */
  public static Path upstreamPath(String relativePath) {
    final Path base = fixturesDir().resolve("upstream");
    return relativePath.isEmpty() ? base : base.resolve(relativePath);
  }

  /** Read a UTF-8 text file under the upstream corpus directory (the testmatrix CSVs). */
  public static String upstreamText(String relativePath) {
    try {
      return new String(
          Files.readAllBytes(upstreamPath(relativePath)), java.nio.charset.StandardCharsets.UTF_8);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Cannot read upstream fixture " + relativePath, e);
    }
  }

  /** Read + JSON-decode a JSON object under the upstream corpus directory. */
  @SuppressWarnings("unchecked")
  public static java.util.Map<String, Object> upstreamJson(String relativePath) {
    try {
      return UPSTREAM_MAPPER.readValue(
          Files.readAllBytes(upstreamPath(relativePath)), java.util.Map.class);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Cannot read upstream fixture " + relativePath, e);
    }
  }

  private static final com.fasterxml.jackson.databind.ObjectMapper UPSTREAM_MAPPER =
      new com.fasterxml.jackson.databind.ObjectMapper();
}
