// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Cross-language parity gate for <see cref="SdkKey.DeriveCacheKey"/> +
/// unit tests for <see cref="SdkKey.Redact"/> and
/// <see cref="SdkKey.IsValidConfeatureKeyFormat"/>. The validator's
/// accept/reject cases come from the shared
/// <c>packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json</c>
/// list (#802), never a per-SDK list.
/// </summary>
/// <remarks>
/// <para>
/// The cache-key fixture at
/// <c>packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json</c>
/// pins ≥ 5 <c>(sdkKey, expectedCacheKey)</c> pairs derived from the
/// canonical TS <c>deriveCacheKey</c>. The Python and Go SDKs already
/// pass against the same corpus; this is the 4th language to consume it.
/// </para>
/// <para>
/// If any drift is detected, <strong>C# is wrong</strong>: TS is the
/// canonical reference, Python + Go are pre-validated. The cross-language
/// 4-runtime invariant is the gate.
/// </para>
/// </remarks>
public class SdkKeyTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public static IEnumerable<object[]> LoadCacheKeyFixtures()
    {
        var raw = File.ReadAllText(WorkspaceRoot.CacheKeyFixturesPath());
        var fixtures = JsonSerializer.Deserialize<List<CacheKeyFixture>>(raw, JsonOptions);
        Assert.NotNull(fixtures);
        Assert.True(fixtures!.Count >= 5, $"Expected ≥ 5 cache-key fixtures; found {fixtures.Count}.");

        foreach (var f in fixtures)
        {
            yield return new object[] { f };
        }
    }

    [Theory]
    [MemberData(nameof(LoadCacheKeyFixtures))]
    public void DeriveCacheKey_matches_canonical_TS_output(CacheKeyFixture fixture)
    {
        var actual = SdkKey.DeriveCacheKey(fixture.SdkKey);

        actual.Should().Be(
            fixture.ExpectedCacheKey,
            because: "C# DeriveCacheKey output MUST be byte-identical to TS / Python / Go for cross-language cache compatibility (constitution Principle II)");
    }

    [Fact]
    public void DeriveCacheKey_produces_prefix_plus_32_chars()
    {
        var key = SdkKey.DeriveCacheKey("any-sdk-key");

        key.Should().StartWith("confeature:cache:v1:");
        key.Substring("confeature:cache:v1:".Length).Should().HaveLength(32);
    }

    [Fact]
    public void DeriveCacheKey_is_deterministic_for_same_input()
    {
        const string Key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

        SdkKey.DeriveCacheKey(Key).Should().Be(SdkKey.DeriveCacheKey(Key));
    }

    [Fact]
    public void Redact_returns_sentinel_for_empty_string()
    {
        SdkKey.Redact(string.Empty).Should().Be("[redacted]");
    }

    [Fact]
    public void Redact_returns_sentinel_for_null()
    {
        SdkKey.Redact(null).Should().Be("[redacted]");
    }

    [Fact]
    public void Redact_returns_sentinel_for_short_key()
    {
        // < 16 chars triggers the full-mask sentinel.
        SdkKey.Redact("short").Should().Be("[redacted]");
        SdkKey.Redact("fifteen-chars-x").Should().Be("[redacted]");
    }

    [Fact]
    public void Redact_masks_middle_for_normal_key()
    {
        // 72-char Confeature v1 key: visible = 72/10 = 7 chars at each end.
        const string Key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

        var redacted = SdkKey.Redact(Key);

        redacted.Should().NotContain(Key, because: "the raw SDK key must NEVER appear verbatim in redacted output");
        redacted.Should().Contain("[redacted]");
        redacted.Should().StartWith("confeatu", because: "the head prefix should equal the first ~10% of the key");
        redacted.Should().EndWith("BBBBBBBB", because: "the tail suffix should equal the last ~10% of the key");
    }

    [Fact]
    public void Redact_masks_middle_for_configcat_shaped_key()
    {
        // 61-char `configcat-sdk-1/<22>/<22>` key (#802): visible = 61/10 = 6
        // chars at each end — the head is all prefix, the tail 6 secret
        // chars, fewer than the legacy shape's 8. The `/` is plain text.
        const string SegmentA = "aB3_-dE5fG7hI9jK1lM3nO";
        const string SegmentB = "pQ5rS7tU9vW1xY3zA5bC7d";
        const string Key = "configcat-sdk-1/" + SegmentA + "/" + SegmentB;

        var redacted = SdkKey.Redact(Key);

        redacted.Should().Be("config…[redacted]…A5bC7d");
        redacted.Should().NotContain(SegmentA, because: "no secret segment may appear whole in redacted output");
        redacted.Should().NotContain(SegmentB, because: "no secret segment may appear whole in redacted output");
    }

    /// <summary>
    /// Every <c>valid</c> entry of the shared
    /// <c>packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json</c>
    /// list (#802, FR-006b) — the ONE list every SDK validator reads.
    /// </summary>
    public static IEnumerable<object[]> LoadValidKeyShapes() => LoadKeyShapes(valid: true);

    /// <summary>Every <c>invalid</c> entry of the shared key-shape list.</summary>
    public static IEnumerable<object[]> LoadInvalidKeyShapes() => LoadKeyShapes(valid: false);

    [Theory]
    [MemberData(nameof(LoadValidKeyShapes))]
    public void IsValidConfeatureKeyFormat_accepts_every_shared_valid_shape(string name, string sdkKey)
    {
        SdkKey.IsValidConfeatureKeyFormat(sdkKey).Should().BeTrue(because: $"'{name}' is listed as valid in sdk-key-shapes.json");
    }

    [Theory]
    [MemberData(nameof(LoadInvalidKeyShapes))]
    public void IsValidConfeatureKeyFormat_rejects_every_shared_invalid_shape(string name, string sdkKey)
    {
        SdkKey.IsValidConfeatureKeyFormat(sdkKey).Should().BeFalse(because: $"'{name}' is listed as invalid in sdk-key-shapes.json");
    }

    [Fact]
    public void IsValidConfeatureKeyFormat_rejects_a_trailing_newline()
    {
        // .NET's `$` also matches before a trailing `\n`; the JS reference's
        // does not. The pattern anchors with `\z` so both agree.
        const string Key = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";

        SdkKey.IsValidConfeatureKeyFormat(Key).Should().BeTrue();
        SdkKey.IsValidConfeatureKeyFormat(Key + "\n").Should().BeFalse();
    }

    [Fact]
    public void IsValidConfeatureKeyFormat_returns_false_for_null()
    {
        SdkKey.IsValidConfeatureKeyFormat(null).Should().BeFalse();
    }

    private static IEnumerable<object[]> LoadKeyShapes(bool valid)
    {
        var raw = File.ReadAllText(WorkspaceRoot.SdkKeyShapesPath());
        var shapes = JsonSerializer.Deserialize<KeyShapes>(raw, JsonOptions);
        Assert.NotNull(shapes);
        var list = valid ? shapes!.Valid : shapes!.Invalid;
        Assert.True(list.Count > 0, $"sdk-key-shapes.json has no {(valid ? "valid" : "invalid")} entries.");

        foreach (var shape in list)
        {
            yield return new object[] { shape.Name, shape.Key };
        }
    }

    /// <summary>Wire-shape mirror of <c>sdk-key-shapes.json</c>.</summary>
    public sealed class KeyShapes
    {
        [JsonPropertyName("valid")]
        public List<KeyShape> Valid { get; set; } = new();

        [JsonPropertyName("invalid")]
        public List<KeyShape> Invalid { get; set; } = new();
    }

    /// <summary>One named entry of <c>sdk-key-shapes.json</c>.</summary>
    public sealed class KeyShape
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("key")]
        public string Key { get; set; } = string.Empty;
    }

    /// <summary>
    /// Wire-shape mirror of a single <c>cache-key-fixtures.json</c> entry.
    /// </summary>
    public sealed class CacheKeyFixture
    {
        [JsonPropertyName("sdkKey")]
        public string SdkKey { get; set; } = string.Empty;

        [JsonPropertyName("expectedCacheKey")]
        public string ExpectedCacheKey { get; set; } = string.Empty;

        public override string ToString() => $"sdkKey={SdkKey}";
    }
}
