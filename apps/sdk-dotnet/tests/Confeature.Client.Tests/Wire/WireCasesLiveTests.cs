// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Wire;

/// <summary>
/// sdk-dotnet live wire-cases (#923, after sdk-go's #921).
/// </summary>
/// <remarks>
/// <para>
/// sdk-dotnet's own <see cref="ConfigFetcher"/> — built the way
/// <see cref="ConfeatureClient"/> builds it, with its own
/// <c>HttpClient</c> and version string — against a RUNNING live-contract
/// harness serving the reference origin of the CDN read path. Every seeded
/// wire-case is replayed and judged by <see cref="WireCaseAssertions"/>, the
/// SAME rules the hermetic suite (<see cref="WireCasesTests"/>) applies to a
/// stub handler. Nothing is hand-built and no admin write is made:
/// </para>
/// <list type="bullet">
///   <item><description>the case set comes from the running harness
///     (<c>GET /admin/state</c> → <c>keys</c>), never recomputed from the
///     corpus — <c>http-403</c> among them, an unseeded key answered by the
///     Worker itself;</description></item>
///   <item><description>the request each case sent is read back from the
///     harness (<c>GET /admin/requests?sdkKey=</c>), and each fetch must add
///     exactly one entry;</description></item>
///   <item><description>a timeout case is ended by the SDK's OWN deadline (a
///     quarter of the harness's hold).</description></item>
/// </list>
/// <para>
/// Each case is its own theory row, so every failing case is reported. Run
/// it through the harness wrapper (the manifest's <c>liveSuite.runner</c>).
/// GATING (fail closed): skipped only when <c>CONFEATURE_LIVE</c> is unset —
/// the hermetic <c>dotnet test</c>. When it is set without
/// <c>LIVE_HARNESS_URL</c>, or the harness does not answer, the row source
/// throws and the theory FAILS; it never skips.
/// </para>
/// </remarks>
public class WireCasesLiveTests
{
    /// <summary>The row naming the US4 probe: no seed, no fault.</summary>
    private const string UnseededKeyRow = "unseeded-key";

    /// <summary>A key the harness never seeds.</summary>
    private const string NeverSeededKey = "never-seeded-923";

    private static readonly TimeSpan DefaultDeadline = TimeSpan.FromSeconds(10);

    /// <summary>One shared client for the harness's admin routes.</summary>
    private static readonly HttpClient Admin = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>
    /// Theory row source: one row per key the running harness seeded, plus
    /// the unseeded-key probe. Only enumerated when <see cref="LiveTheoryAttribute"/>
    /// did not skip, i.e. when <c>CONFEATURE_LIVE=1</c>.
    /// </summary>
    public static IEnumerable<object[]> LiveCases()
    {
        using var state = GetJson("/admin/state");
        var keys = state.RootElement.GetProperty("keys").EnumerateArray()
            .Select(k => k.GetString()!)
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToList();
        if (keys.Count == 0)
        {
            throw new InvalidOperationException(
                "the harness reports no seeded case — an empty run checks nothing");
        }

        var corpusIds = WireCaseAssertions.Cases
            .Select(c => c.GetProperty("id").GetString())
            .ToHashSet(StringComparer.Ordinal);
        var unknown = keys.Where(k => !corpusIds.Contains(k)).ToList();
        if (unknown.Count > 0)
        {
            throw new InvalidOperationException(
                "seeded keys missing from the corpus: " + string.Join(", ", unknown));
        }

        return keys.Append(UnseededKeyRow).Select(k => new object[] { k });
    }

    /// <summary>Replays one seeded case (or the unseeded-key probe) against the harness.</summary>
    [LiveTheory]
    [MemberData(nameof(LiveCases))]
    public async Task Live_wire_case_conforms_to_corpus(string id)
    {
        if (id == UnseededKeyRow)
        {
            await AssertUnseededKeyIsInvalidSdkKey();
            return;
        }

        var root = WireCaseAssertions.Cases.Single(c => c.GetProperty("id").GetString() == id);
        var hold = HoldFor(root, id);
        var deadline = hold > TimeSpan.Zero ? TimeSpan.FromTicks(hold.Ticks / 4) : DefaultDeadline;

        // The harness seeds each case under its id; a case that pins
        // given.sdkKey is configured with that key instead (#803 FR-003).
        var sdkKey = WireCaseAssertions.SdkKeyFor(root, id);
        var loggedBefore = RequestsFor(sdkKey).Count;

        var previousETag = WireCaseAssertions.ReadNullableString(root.GetProperty("given"), "previousEtag");
        var stopwatch = Stopwatch.StartNew();
        FetchResult result;
        using (var fetcher = NewFetcher(sdkKey, deadline))
        {
            result = await fetcher.FetchAsync(previousETag, CancellationToken.None);
        }

        stopwatch.Stop();

        var log = RequestsFor(sdkKey);

        // Exactly one request per fetch: a retrying SDK, or a request logged
        // by an earlier run, must not stand in for the one under test.
        (log.Count - loggedBefore).Should().Be(1, because: "one fetch sends exactly one request");
        if (hold > TimeSpan.Zero)
        {
            stopwatch.Elapsed.Should().BeLessThan(
                hold,
                because: "the SDK's own deadline ends the fetch, not the harness releasing it");
        }

        var last = log[log.Count - 1];
        var target = last.GetProperty("url").GetString()!;
        var queryAt = target.IndexOf('?', StringComparison.Ordinal);
        var path = queryAt < 0 ? target : target.Substring(0, queryAt);
        var inm = last.GetProperty("ifNoneMatch");
        var sent = new SentRequest(
            path,
            target,
            inm.ValueKind == JsonValueKind.String ? inm.GetString() : null);

        WireCaseAssertions.AssertWireCase(root, sdkKey, sent, result);
    }

    /// <summary>
    /// US4: no seed, no fault — the CDN's own unknown-key answer,
    /// ConfigCat's 403 since #785, classed like a 404 as invalidSdkKey.
    /// </summary>
    private static async Task AssertUnseededKeyIsInvalidSdkKey()
    {
        using var fetcher = NewFetcher(NeverSeededKey, DefaultDeadline);
        var result = await fetcher.FetchAsync(null, CancellationToken.None);
        result.Status.Should().Be(FetchStatus.Failed);
        WireCaseAssertions.MapDotnetErrorToClass(result.Error).Should().Be(
            "invalidSdkKey",
            because: $"raw='{result.Error}'");
    }

    /// <summary>
    /// The fetcher as <see cref="ConfeatureClient"/> builds it when no
    /// customer <c>HttpClient</c> is supplied: it owns a client whose timeout
    /// is the deadline, and stamps the SDK's own version.
    /// </summary>
    private static ConfigFetcher NewFetcher(string sdkKey, TimeSpan deadline) => new(
        httpClient: null,
        baseUrl: HarnessBase(),
        sdkKey: sdkKey,
        version: SdkVersion.Value,
        timeout: deadline,
        logger: new CapturingLogger());

    /// <summary>
    /// The harness's hold for a timeout case — the SDK's deadline is derived
    /// from it (#783 A8) — or zero for any other behaviour.
    /// </summary>
    private static TimeSpan HoldFor(JsonElement root, string id)
    {
        if (WireCaseAssertions.ReadNullableString(root.GetProperty("server"), "behavior") != "timeout")
        {
            return TimeSpan.Zero;
        }

        using var state = GetJson("/admin/state");
        var ms = state.RootElement.GetProperty("faults").TryGetProperty(id, out var fault)
            && fault.ValueKind == JsonValueKind.Object
            && fault.TryGetProperty("ms", out var msEl)
            && msEl.ValueKind == JsonValueKind.Number
                ? msEl.GetInt32()
                : 0;
        ms.Should().BePositive(because: $"{id} must be seeded with a timeout fault");
        return TimeSpan.FromMilliseconds(ms);
    }

    /// <summary>The requests the harness logged for a key, oldest first.</summary>
    private static List<JsonElement> RequestsFor(string sdkKey)
    {
        using var body = GetJson("/admin/requests?sdkKey=" + Uri.EscapeDataString(sdkKey));
        body.RootElement.GetProperty("ok").GetBoolean().Should().BeTrue(
            because: "the harness must answer /admin/requests");
        return body.RootElement.GetProperty("requests").EnumerateArray()
            .Select(r => r.Clone())
            .ToList();
    }

    /// <summary>
    /// The harness base URL. Throws when unset: a live suite must never pass
    /// by skipping.
    /// </summary>
    private static string HarnessBase()
    {
        var url = Environment.GetEnvironmentVariable("LIVE_HARNESS_URL")?.TrimEnd('/');
        if (string.IsNullOrEmpty(url))
        {
            throw new InvalidOperationException(
                "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through "
                + "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping");
        }

        return url!;
    }

    /// <summary>GETs an admin route and parses its JSON; a non-200 answer throws.</summary>
    private static JsonDocument GetJson(string pathAndQuery)
    {
        using var response = Admin.GetAsync(new Uri(HarnessBase() + pathAndQuery)).GetAwaiter().GetResult();
        var raw = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"harness {pathAndQuery} answered {(int)response.StatusCode}: {raw}");
        }

        return JsonDocument.Parse(raw);
    }
}

/// <summary>
/// A <see cref="TheoryAttribute"/> that skips unless <c>CONFEATURE_LIVE=1</c>:
/// the hermetic <c>dotnet test</c> reports the live theory as skipped (its row
/// source, which needs the harness, is never enumerated), and a live run with
/// the variable set runs every row.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class LiveTheoryAttribute : TheoryAttribute
{
    /// <summary>Sets <see cref="FactAttribute.Skip"/> when the run is hermetic.</summary>
    public LiveTheoryAttribute()
    {
        if (Environment.GetEnvironmentVariable("CONFEATURE_LIVE") != "1")
        {
            Skip = "hermetic run: CONFEATURE_LIVE is not set";
        }
    }
}
