// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * JVM test helper — locates the cross-language fixtures directory.
 *
 * Mirrors `apps/sdk-java/.../WorkspaceRoot.java`. Two-step resolution:
 *
 * 1. Honour the `confeature.repo.root` system property set by `build.gradle.kts`
 *    (`systemProperty("confeature.repo.root", rootProject.projectDir.parentFile.parentFile.absolutePath)`).
 * 2. Otherwise walk up from `user.dir` until a sibling `pnpm-workspace.yaml` appears.
 */
object WorkspaceRoot {

    /** Returns the absolute path of the repo root. */
    fun repoRoot(): Path {
        val prop = System.getProperty("confeature.repo.root")
        if (!prop.isNullOrEmpty()) {
            return Paths.get(prop).toAbsolutePath()
        }
        var cursor: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
        while (cursor != null) {
            if (Files.exists(cursor.resolve("pnpm-workspace.yaml"))) {
                return cursor
            }
            cursor = cursor.parent
        }
        throw IllegalStateException(
            "Could not locate repo root from " + System.getProperty("user.dir"),
        )
    }

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json`. */
    fun parityCorpusPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs.json`. */
    fun parityConfigsPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`. */
    fun cacheKeyFixturesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json")

    /**
     * Path to `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json` — the one
     * accept/reject list of SDK-key shapes every SDK validator is tested against (#802).
     */
    fun sdkKeyShapesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json`. */
    fun parityCorpusTypedPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-typed.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json`. */
    fun parityConfigsTypedPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-typed.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json` (spec 135). */
    fun parityCorpusRulesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-corpus-rules.json")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json` (spec 135). */
    fun parityConfigsRulesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/parity-configs-rules.json")

    /** Path to the shared SDK-parity fixtures directory. */
    fun fixturesDir(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures")

    /** Path to `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. */
    fun wireCasesPath(): Path =
        repoRoot().resolve("packages/test-fixtures-sdk-parity/fixtures/wire-cases.json")

    // -----------------------------------------------------------------------
    // Vendored upstream ConfigCat conformance corpus (shared read-only with
    // specs 117–128). The KMP evaluator (commonMain) is exercised on the JVM
    // target — the authoritative parity target — via EvaluatorUpstreamCorpusTest.
    // -----------------------------------------------------------------------

    /**
     * Absolute path into the vendored upstream ConfigCat conformance corpus
     * (`packages/test-fixtures-sdk-parity/fixtures/upstream/`). Mirrors the Android
     * `WorkspaceRoot.upstreamPath`.
     */
    fun upstreamPath(relativePath: String): Path =
        fixturesDir().resolve("upstream").resolve(relativePath)

    /** Read a UTF-8 text file under the upstream corpus directory (the testmatrix CSVs). */
    fun upstreamText(relativePath: String): String =
        try {
            String(Files.readAllBytes(upstreamPath(relativePath)), Charsets.UTF_8)
        } catch (ex: Exception) {
            throw IllegalStateException("Cannot read upstream fixture $relativePath", ex)
        }

    /**
     * Read + JSON-decode a JSON object under the upstream corpus directory into the loosely-typed
     * `Map<String,Any?>` the evaluator consumes (kotlinx-serialization → Kotlin primitives /
     * List / Map; JSON integers decode to Int/Long, decimals to Double, mirroring the SDK's own
     * `decodeJsonElement`).
     */
    @Suppress("UNCHECKED_CAST")
    fun upstreamJson(relativePath: String): Map<String, Any?> {
        val el = Json.parseToJsonElement(upstreamText(relativePath))
        val decoded = decodeJsonElement(el)
        return decoded as? Map<String, Any?>
            ?: throw IllegalStateException("Upstream fixture $relativePath is not a JSON object")
    }

    private fun decodeJsonElement(el: JsonElement?): Any? = when (el) {
        null, is JsonNull -> null
        is JsonObject -> el.mapValues { decodeJsonElement(it.value) }
        is JsonArray -> el.map { decodeJsonElement(it) }
        is JsonPrimitive -> decodePrimitive(el)
    }

    private fun decodePrimitive(p: JsonPrimitive): Any? {
        if (p.isString) return p.content
        p.booleanOrNull?.let { return it }
        p.longOrNull?.let { return if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else it }
        p.doubleOrNull?.let { return it }
        return p.contentOrNull
    }
}
