// SPDX-License-Identifier: MIT

using System;
using System.IO;

namespace Confeature.Client.Tests.TestUtils;

/// <summary>
/// Resolves the repository root at test-runtime by walking up from
/// <see cref="AppContext.BaseDirectory"/> until a directory containing
/// <c>pnpm-workspace.yaml</c> is found.
/// </summary>
/// <remarks>
/// The resolved path is cached via <see cref="Lazy{T}"/> across the test
/// session. Same sentinel as the Python (<c>conftest.py</c>) and Go
/// (<c>internal/testutil</c>) test helpers. See research §R1 of spec
/// 039 for the rationale.
/// </remarks>
internal static class WorkspaceRoot
{
    private static readonly Lazy<string> RootLazy = new(Resolve);

    /// <summary>The absolute path to the workspace root.</summary>
    public static string Path => RootLazy.Value;

    /// <summary>Absolute path to <c>parity-corpus.json</c>.</summary>
    public static string ParityCorpusPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-corpus.json");

    /// <summary>Absolute path to <c>parity-configs.json</c>.</summary>
    public static string ParityConfigsPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-configs.json");

    /// <summary>
    /// Absolute path to <c>parity-corpus-typed.json</c> — the 13-tuple
    /// <c>SettingType × value</c> extension corpus shipped by spec 066 /
    /// #253. Consumed verbatim by spec 070's typed parity tier.
    /// </summary>
    public static string ParityCorpusTypedPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-corpus-typed.json");

    /// <summary>
    /// Absolute path to <c>parity-configs-typed.json</c> — the typed
    /// corpus's canonical configs. Consumed verbatim by spec 070's
    /// typed parity tier.
    /// </summary>
    public static string ParityConfigsTypedPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-configs-typed.json");

    /// <summary>
    /// Absolute path to <c>parity-corpus-rules.json</c> — the 8-tuple
    /// targeting-rule corpus (spec 135 / #429, epic #382, US3). Injected via
    /// the full-config offline override and consumed verbatim.
    /// </summary>
    public static string ParityCorpusRulesPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-corpus-rules.json");

    /// <summary>
    /// Absolute path to <c>parity-configs-rules.json</c> — the full
    /// <c>{p, f, s}</c> rule corpus configs (<c>injectionMode: "full-config"</c>).
    /// Consumed verbatim by the targeting-rule parity tier.
    /// </summary>
    public static string ParityConfigsRulesPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "parity-configs-rules.json");

    /// <summary>Absolute path to <c>cache-key-fixtures.json</c>.</summary>
    public static string CacheKeyFixturesPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "cache-key-fixtures.json");

    /// <summary>
    /// Absolute path to <c>sdk-key-shapes.json</c> — the one accept/reject
    /// list of SDK key shapes every Confeature SDK validator is tested
    /// against (#802, FR-006b).
    /// </summary>
    public static string SdkKeyShapesPath() => System.IO.Path.Combine(
        Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures",
        "sdk-key-shapes.json");

    /// <summary>
    /// Absolute path to a file under
    /// <c>packages/test-fixtures-sdk-parity/fixtures/upstream/</c> — the
    /// vendored ConfigCat evaluation matrix (spec 122 / SC-001). The
    /// relative segments are joined with the platform separator. Mirrors the
    /// PHP <c>WorkspaceRoot::upstream*</c> accessors (spec 121).
    /// </summary>
    public static string UpstreamPath(params string[] relativeSegments)
    {
        var parts = new string[4 + relativeSegments.Length];
        parts[0] = "packages";
        parts[1] = "test-fixtures-sdk-parity";
        parts[2] = "fixtures";
        parts[3] = "upstream";
        Array.Copy(relativeSegments, 0, parts, 4, relativeSegments.Length);
        return System.IO.Path.Combine(Path, System.IO.Path.Combine(parts));
    }

    /// <summary>Read a vendored upstream file as UTF-8 text.</summary>
    public static string UpstreamText(string relativePath) =>
        File.ReadAllText(UpstreamPath(relativePath.Split('/')));

    /// <summary>Read + parse a vendored upstream JSON file to a <see cref="JsonDocument"/>.</summary>
    public static System.Text.Json.JsonDocument UpstreamJson(string relativePath) =>
        System.Text.Json.JsonDocument.Parse(UpstreamText(relativePath));

    private static string Resolve()
    {
        var dir = AppContext.BaseDirectory;
        while (!string.IsNullOrEmpty(dir))
        {
            if (File.Exists(System.IO.Path.Combine(dir, "pnpm-workspace.yaml")))
            {
                return dir;
            }

            var parent = Directory.GetParent(dir);
            if (parent is null)
            {
                break;
            }

            dir = parent.FullName;
        }

        throw new InvalidOperationException(
            $"Could not locate pnpm-workspace.yaml above {AppContext.BaseDirectory}. " +
            "Tests must run from a path inside the Confeature workspace.");
    }
}
