// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.JsonParser
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Test helper — locates the cross-language fixtures directory.
 *
 * The fixtures live in `packages/test-fixtures-sdk-parity/fixtures/` at the repo root. Resolution
 * strategy:
 * 1. Read the `confeature.repo.root` system property (set by `build.gradle.kts`).
 * 2. Otherwise walk up from `user.dir` until a sibling `pnpm-workspace.yaml` appears.
 */
public object WorkspaceRoot {
    /** Returns the absolute path of the repo root. */
    @JvmStatic
    public fun repoRoot(): Path {
        val prop = System.getProperty("confeature.repo.root")
        if (!prop.isNullOrEmpty()) return Paths.get(prop).toAbsolutePath()
        var cursor: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
        while (cursor != null) {
            if (Files.exists(cursor.resolve("pnpm-workspace.yaml"))) return cursor
            cursor = cursor.parent
        }
        throw IllegalStateException("Could not locate repo root from ${System.getProperty("user.dir")}")
    }

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json`. */
    @JvmStatic
    public fun parityCorpusPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs.json`. */
    @JvmStatic
    public fun parityConfigsPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`. */
    @JvmStatic
    public fun cacheKeyFixturesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json")

    /**
     * Path to `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json` — the one
     * accept/reject list of SDK-key shapes every SDK validator is tested against (#802).
     */
    @JvmStatic
    public fun sdkKeyShapesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json`. */
    @JvmStatic
    public fun parityCorpusTypedPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json`. */
    @JvmStatic
    public fun parityConfigsTypedPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json")

    /**
     * Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json` — the 8-tuple
     * targeting-rule corpus (spec 135 / #440, epic #382, US3), injected via the full-config offline
     * override and consumed verbatim.
     */
    @JvmStatic
    public fun parityCorpusRulesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json")

    /**
     * Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json` — the full
     * `{p, f, s}` rule corpus configs (`injectionMode: "full-config"`). Consumed verbatim by the
     * targeting-rule parity tier.
     */
    @JvmStatic
    public fun parityConfigsRulesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. */
    @JvmStatic
    public fun wireCasesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/wire-cases.json")

    /** Directory containing the cross-language fixtures (resolves `bodyRef` siblings). */
    @JvmStatic
    public fun fixturesDir(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures")

    /**
     * Absolute path into the vendored upstream ConfigCat conformance corpus
     * (`packages/test-fixtures-sdk-parity/fixtures/upstream/`), shared read-only with specs 117–126.
     * The corpus test ([EvaluatorUpstreamCorpusTest]) reads the testmatrix CSVs + `evaluationlog/` +
     * `comparison_*.json` through this accessor. Mirrors the Java `WorkspaceRoot.upstreamPath`.
     */
    @JvmStatic
    public fun upstreamPath(relativePath: String): Path {
        val base = fixturesDir().resolve("upstream")
        return if (relativePath.isEmpty()) base else base.resolve(relativePath)
    }

    /** Read a UTF-8 text file under the upstream corpus directory (the testmatrix CSVs). */
    @JvmStatic
    public fun upstreamText(relativePath: String): String =
        try {
            String(Files.readAllBytes(upstreamPath(relativePath)), StandardCharsets.UTF_8)
        } catch (ex: java.io.IOException) {
            throw IllegalStateException("Cannot read upstream fixture $relativePath", ex)
        }

    /**
     * Read + JSON-decode a JSON object under the upstream corpus directory. Uses the SDK's
     * [JsonParser] (org.json) so numeric coercion matches the runtime decode path.
     */
    @JvmStatic
    public fun upstreamJson(relativePath: String): Map<String, Any?> =
        JsonParser.parseObject(upstreamText(relativePath))
}
