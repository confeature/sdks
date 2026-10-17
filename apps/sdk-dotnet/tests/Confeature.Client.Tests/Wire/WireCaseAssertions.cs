// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;

namespace Confeature.Client.Tests.Wire;

/// <summary>
/// The one request a fetch put on the wire, in the form both wire suites can
/// supply: the hermetic suite reads it from the captured
/// <c>HttpRequestMessage</c>, the live suite from the harness's
/// <c>GET /admin/requests</c>.
/// </summary>
/// <param name="Path">The request target exactly as sent, query excluded.</param>
/// <param name="Target">The request target as sent, query included.</param>
/// <param name="IfNoneMatch">The header's value, or <c>null</c> when it was not sent.</param>
internal sealed record SentRequest(string Path, string Target, string? IfNoneMatch);

/// <summary>
/// What a <c>wire-cases.json</c> case means for sdk-dotnet — ONE
/// implementation, shared by the hermetic suite (<see cref="WireCasesTests"/>,
/// a stub <c>HttpMessageHandler</c>) AND the live suite
/// (<see cref="WireCasesLiveTests"/>, real HTTP against the live-contract
/// harness, #923), so both are judged by the same rules.
/// </summary>
/// <remarks>
/// Mirrors sdk-go's <c>wire_case_assertions_test.go</c> (#921) and sdk-java's
/// <c>WireCaseAssertions</c> (#922).
/// </remarks>
internal static class WireCaseAssertions
{
    /// <summary>
    /// Every <c>given</c> field this consumer reads. A field outside this set
    /// FAILS the case (#803 FR-003): a new precondition is never ignored.
    /// </summary>
    private static readonly HashSet<string> KnownGivenFields = new(StringComparer.Ordinal)
    {
        "previousEtag", "sdkKey", "baseUrl",
    };

    /// <summary>
    /// Every <c>expected</c> field this consumer asserts. A field outside this
    /// set FAILS the case (#803 FR-003): a new expectation is never skipped.
    /// </summary>
    private static readonly HashSet<string> KnownExpectedFields = new(StringComparer.Ordinal)
    {
        "requestHeaderIfNoneMatch", "outcome", "resultingEtag", "hasConfig",
        "errorClass", "requestUrlPrefix", "requestPath",
    };

    /// <summary>
    /// Every top-level case field. A field outside this set FAILS the case
    /// (#803 FR-003), as sdk-go's <c>DisallowUnknownFields</c> decode does.
    /// </summary>
    private static readonly HashSet<string> KnownCaseFields = new(StringComparer.Ordinal)
    {
        "id", "description", "given", "server", "expected",
    };

    /// <summary>
    /// Every <c>server</c> field the behaviour adapter reads. A field outside
    /// this set FAILS the case (#803 FR-003): a new server behaviour knob is
    /// never ignored.
    /// </summary>
    private static readonly HashSet<string> KnownServerFields = new(StringComparer.Ordinal)
    {
        "status", "headers", "body", "bodyRef", "behavior",
    };

    /// <summary>Cached parse of <c>wire-cases.json</c>.</summary>
    private static readonly Lazy<JsonDocument> CorpusDoc = new(LoadCorpusDocument);

    /// <summary>The corpus's cases, in file order.</summary>
    public static JsonElement.ArrayEnumerator Cases =>
        CorpusDoc.Value.RootElement.GetProperty("cases").EnumerateArray();

    /// <summary>The directory holding <c>wire-cases.json</c> and its body fixtures.</summary>
    public static string WireFixturesDir() => Path.Combine(
        WorkspaceRoot.Path,
        "packages",
        "test-fixtures-sdk-parity",
        "fixtures");

    /// <summary>
    /// Fails on any case field this consumer does not read (#803 FR-003).
    /// </summary>
    public static void AssertCaseHasOnlyKnownFields(JsonElement root)
    {
        AssertOnlyKnownFields(root, KnownCaseFields, "case");
        AssertOnlyKnownFields(root.GetProperty("given"), KnownGivenFields, "given");
        AssertOnlyKnownFields(root.GetProperty("server"), KnownServerFields, "server");
        AssertOnlyKnownFields(root.GetProperty("expected"), KnownExpectedFields, "expected");
    }

    /// <summary>
    /// The key a suite configures its fetcher with: the corpus's
    /// <c>given.sdkKey</c> when the case pins one, else the suite's own
    /// default (the live suite's default is the case id, the key the harness
    /// seeds).
    /// </summary>
    public static string SdkKeyFor(JsonElement root, string defaultKey) =>
        ReadNullableString(root.GetProperty("given"), "sdkKey") ?? defaultKey;

    /// <summary>
    /// Judges one fetch of a case — the request it sent and the result it
    /// returned — by the corpus's expectations.
    /// </summary>
    public static void AssertWireCase(JsonElement root, string sdkKey, SentRequest sent, FetchResult result)
    {
        AssertCaseHasOnlyKnownFields(root);
        AssertRequest(root, sdkKey, sent);
        AssertOutcome(root.GetProperty("expected"), result);
    }

    /// <summary>
    /// Maps sdk-dotnet's stringly-typed <see cref="FetchResult.Error"/> onto
    /// the corpus's normalised error-class vocabulary:
    /// <list type="bullet">
    ///   <item><description><c>MALFORMED_JSON</c> → <c>parseFailed</c></description></item>
    ///   <item><description><c>HTTP 403</c> / <c>HTTP 404</c> / <c>INVALID_SDK_KEY</c> → <c>invalidSdkKey</c> (per ConfigCat only 403/404 are invalid-SDK-key statuses; 401 is a generic retryable failure)</description></item>
    ///   <item><description><c>HTTP &lt;other-non-2xx&gt;</c> → <c>fetchFailed</c></description></item>
    ///   <item><description><c>TIMEOUT</c> → <c>timeout</c></description></item>
    ///   <item><description><c>NETWORK_ERROR</c> / <c>CANCELLED</c> → <c>fetchFailed</c></description></item>
    /// </list>
    /// A missing reason or one outside that list maps to
    /// <c>unmapped:&lt;reason&gt;</c>, which matches no corpus class — so it
    /// FAILS, like sdk-go's <c>goErrorToClass</c>. Folding the unknown into
    /// <c>fetchFailed</c> would let any unexpected failure pass every
    /// <c>fetchFailed</c> case.
    /// </summary>
    public static string MapDotnetErrorToClass(string? raw)
    {
        switch (raw)
        {
            case "MALFORMED_JSON":
                return "parseFailed";
            case "HTTP 403":
            case "HTTP 404":
            case "INVALID_SDK_KEY":
                return "invalidSdkKey";
            case "TIMEOUT":
                return "timeout";
            case "NETWORK_ERROR":
            case "CANCELLED":
                return "fetchFailed";
            case null:
                return "unmapped:<none>";
        }

        return raw.StartsWith("HTTP ", StringComparison.Ordinal) ? "fetchFailed" : "unmapped:" + raw;
    }

    /// <summary>Reads a string property, or <c>null</c> when absent or not a string.</summary>
    public static string? ReadNullableString(JsonElement parent, string key)
    {
        if (!parent.TryGetProperty(key, out var el))
        {
            return null;
        }

        return el.ValueKind == JsonValueKind.String ? el.GetString() : null;
    }

    /// <summary>
    /// The request side: the exact path as sent (compared byte for byte), no
    /// legacy <c>/v2/</c> prefix, a custom base leading the URL, and the
    /// If-None-Match round-trip.
    /// </summary>
    private static void AssertRequest(JsonElement root, string sdkKey, SentRequest sent)
    {
        var given = root.GetProperty("given");
        var expected = root.GetProperty("expected");

        // URL shape (#803 FR-001): ConfigCat's <baseURL>/configuration-files/
        // <sdkKey>/config_v6.json, the key's exact bytes. Compared on the
        // path, so a query string (#807) never breaks it.
        var wantedPath = ReadNullableString(expected, "requestPath")
            ?? "/configuration-files/" + sdkKey + "/config_v6.json";
        sent.Path.Should().Be(wantedPath, because: "the SDK MUST request the path the CDN serves");
        sent.Target.Should().NotContain("/v2/", because: "the legacy /v2/ prefix is gone (#803)");

        // A custom base must lead the request URL (custom-base-url). Checked
        // on the fetcher's Url — the one place the URL Fetch GETs is built —
        // so the check holds whatever host the suite really talks to.
        var baseUrl = ReadNullableString(given, "baseUrl");
        var prefix = ReadNullableString(expected, "requestUrlPrefix");
        (baseUrl is null).Should().Be(
            prefix is null,
            because: "given.baseUrl and expected.requestUrlPrefix come together");
        if (baseUrl is not null)
        {
            using var custom = new ConfigFetcher(
                httpClient: null,
                baseUrl: baseUrl,
                sdkKey: sdkKey,
                version: "0.0.0-wire-test",
                timeout: TimeSpan.FromSeconds(1),
                logger: new CapturingLogger());
            custom.Url.Should().NotBeNull();
            custom.Url!.AbsoluteUri.Should().StartWith(prefix);
        }

        // If-None-Match three-state semantics: absent (don't assert),
        // explicit null (header MUST NOT be sent), explicit string
        // (header MUST equal exact value).
        if (expected.TryGetProperty("requestHeaderIfNoneMatch", out var inmEl))
        {
            if (inmEl.ValueKind == JsonValueKind.Null)
            {
                sent.IfNoneMatch.Should().BeNull(
                    because: "a case with previousEtag=null MUST NOT send If-None-Match");
            }
            else
            {
                sent.IfNoneMatch.Should().Be(inmEl.GetString());
            }
        }
    }

    /// <summary>
    /// Maps the fetcher's typed status and reason code onto the corpus's
    /// <c>{fetched, notModified, failed}</c> x errorClass vocabulary, and
    /// checks <c>hasConfig</c>.
    /// </summary>
    private static void AssertOutcome(JsonElement expected, FetchResult result)
    {
        var outcome = expected.GetProperty("outcome").GetString();
        switch (outcome)
        {
            case "fetched":
                result.Status.Should().Be(
                    FetchStatus.Fetched,
                    because: $"corpus expects 'fetched' (raw error: '{result.Error}')");
                AssertResultingEtag(expected, result);
                result.Body.ValueKind.Should().NotBe(
                    JsonValueKind.Undefined,
                    because: "Body must be populated on fetched outcome");
                break;

            case "notModified":
                result.Status.Should().Be(
                    FetchStatus.NotModified,
                    because: $"corpus expects 'notModified' (raw error: '{result.Error}')");
                AssertResultingEtag(expected, result);

                // 304 carries no body; the fetcher's contract is that
                // RawBody stays null on NotModified.
                result.RawBody.Should().BeNull(
                    because: "Body must be unset on notModified outcome");
                break;

            case "failed":
                result.Status.Should().Be(
                    FetchStatus.Failed,
                    because: $"corpus expects 'failed' (raw error: '{result.Error}')");
                MapDotnetErrorToClass(result.Error).Should().Be(
                    expected.GetProperty("errorClass").GetString(),
                    because: $"errorClass mapped from raw='{result.Error}'");
                break;

            default:
                throw new InvalidOperationException(
                    $"Unknown outcome value in corpus: '{outcome}'");
        }

        if (expected.TryGetProperty("hasConfig", out var hasConfigEl))
        {
            (result.Status == FetchStatus.Fetched).Should().Be(
                hasConfigEl.GetBoolean(),
                because: "hasConfig is true exactly when this fetch delivered a config");
        }
    }

    private static void AssertResultingEtag(JsonElement expected, FetchResult result)
    {
        if (expected.TryGetProperty("resultingEtag", out var etag)
            && etag.ValueKind == JsonValueKind.String)
        {
            result.ETag.Should().Be(etag.GetString());
        }
    }

    private static void AssertOnlyKnownFields(JsonElement section, HashSet<string> known, string sectionName)
    {
        foreach (var prop in section.EnumerateObject())
        {
            known.Should().Contain(
                prop.Name,
                because: $"wire-cases '{sectionName}.{prop.Name}' has no .NET adapter — read it, never skip it");
        }
    }

    private static JsonDocument LoadCorpusDocument()
    {
        var corpusPath = Path.Combine(WireFixturesDir(), "wire-cases.json");
        var doc = JsonDocument.Parse(File.ReadAllText(corpusPath));
        if (doc.RootElement.GetProperty("cases").GetArrayLength() == 0)
        {
            throw new InvalidOperationException("wire-cases.json carries no cases");
        }

        return doc;
    }
}
