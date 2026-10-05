// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Spec 039 US1 parity gate — 58/58 byte-identical to ConfigCat.
/// </summary>
/// <remarks>
/// <para>
/// Loads the TS-generated parity corpus + canonical configs from
/// <c>packages/test-fixtures-sdk-parity/fixtures/</c>, parametrises one
/// xUnit theory case per tuple via <see cref="MemberDataAttribute"/>, and
/// asserts that the .NET <see cref="ConfeatureClient"/> resolves each tuple
/// to its <c>expected</c> value.
/// </para>
/// <para>
/// Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST pass.
/// If a tuple drifts, STOP and investigate the override-eval / evaluator
/// code — never mutate the corpus to make the test green.
/// </para>
/// <para>
/// Mirrors <c>apps/sdk-python/tests/parity/test_parity_corpus.py</c> and
/// <c>apps/sdk-go/parity_test.go</c>.
/// </para>
/// </remarks>
public class ParityCorpusTests
{
    private const string ParityTestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    /// <summary>
    /// Loads the 58 corpus tuples + the lookup map of configs from
    /// <c>packages/test-fixtures-sdk-parity/fixtures/</c> and yields one
    /// xUnit test case per tuple. The first element is the description so
    /// xUnit's run report surfaces a drift by its human-readable name.
    /// </summary>
    public static IEnumerable<object?[]> CorpusTuples()
    {
        var corpusJson = File.ReadAllText(WorkspaceRoot.ParityCorpusPath());
        var configsJson = File.ReadAllText(WorkspaceRoot.ParityConfigsPath());

        var tuples = JsonSerializer.Deserialize<List<ParityTuple>>(corpusJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-corpus.json deserialised to null");
        var configRecords = JsonSerializer.Deserialize<List<ParityConfigRecord>>(configsJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-configs.json deserialised to null");

        var configsById = new Dictionary<string, ParityConfigRecord>(StringComparer.Ordinal);
        foreach (var record in configRecords)
        {
            configsById[record.Id] = record;
        }

        foreach (var tuple in tuples)
        {
            if (!configsById.TryGetValue(tuple.ConfigId, out var config))
            {
                throw new InvalidOperationException(
                    $"Corpus tuple '{tuple.Description}' references unknown configId='{tuple.ConfigId}'. "
                    + "Regenerate fixtures via 'pnpm run export:corpus'.");
            }

            yield return new object?[] { tuple.Description, tuple, config };
        }
    }

    /// <summary>
    /// Spec 070 US2 typed-parity gate — loads the 13 typed corpus tuples
    /// + the lookup map of typed configs from
    /// <c>packages/test-fixtures-sdk-parity/fixtures/</c> and yields one
    /// xUnit test case per tuple. Mirrors <see cref="CorpusTuples"/>; the
    /// <c>tuples.Count == 13</c> guard is the .NET analogue of the JVM
    /// family's <c>assertEquals(13, ...)</c>.
    /// </summary>
    public static IEnumerable<object?[]> CorpusTuplesTyped()
    {
        var corpusJson = File.ReadAllText(WorkspaceRoot.ParityCorpusTypedPath());
        var configsJson = File.ReadAllText(WorkspaceRoot.ParityConfigsTypedPath());

        var tuples = JsonSerializer.Deserialize<List<ParityTuple>>(corpusJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-corpus-typed.json deserialised to null");
        var configRecords = JsonSerializer.Deserialize<List<ParityConfigRecord>>(configsJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-configs-typed.json deserialised to null");

        if (tuples.Count != 13)
        {
            throw new InvalidOperationException(
                $"parity-corpus-typed.json must hold 13 tuples; got {tuples.Count}. "
                + "Regenerate fixtures via 'pnpm run export:corpus'.");
        }

        var configsById = new Dictionary<string, ParityConfigRecord>(StringComparer.Ordinal);
        foreach (var record in configRecords)
        {
            configsById[record.Id] = record;
        }

        foreach (var tuple in tuples)
        {
            if (!configsById.TryGetValue(tuple.ConfigId, out var config))
            {
                throw new InvalidOperationException(
                    $"Typed corpus tuple '{tuple.Description}' references unknown configId='{tuple.ConfigId}'. "
                    + "Regenerate fixtures via 'pnpm run export:corpus'.");
            }

            yield return new object?[] { tuple.Description, tuple, config };
        }
    }

    [Theory]
    [MemberData(nameof(CorpusTuples))]
    public void Parity(string description, ParityTuple tuple, ParityConfigRecord config)
    {
        _ = description; // Surfaces in xUnit's test report via [MemberData]'s first element.

        // Build the override map. Corpus values are JSON primitives —
        // System.Text.Json deserialises them into JsonElement; we unwrap
        // to the closest BCL primitive (bool / string / int / double).
        var overridesMap = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var kvp in config.OverridesMap)
        {
            overridesMap[kvp.Key] = UnwrapJsonElement(kvp.Value);
        }

        using var client = new ConfeatureClient(ParityTestSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overridesMap),
                OverrideBehaviour.LocalOnly);
            // Keep the test fully offline + leak-free.
            options.CacheDirectory = ":memory:";
        });

        var defaultValue = UnwrapJsonElement(tuple.DefaultValue);
        var expected = UnwrapJsonElement(tuple.Expected);
        var user = MakeUser(tuple.User);

        var actual = client.GetValue(tuple.Key, defaultValue, user);

        actual.Should().Be(expected,
            because: "spec 039 Principle II NON-NEGOTIABLE — investigate the "
                + "evaluator / override-eval code, do NOT mutate the corpus. "
                + $"Tuple: {tuple.Description}");
    }

    /// <summary>
    /// Spec 070 US2 typed-parity tier — sibling theory consuming the
    /// 13-tuple <c>parity-corpus-typed.json</c>. Mirrors <see cref="Parity"/>
    /// but canonicalises every numeric corpus value to the target setting's
    /// native .NET type (<c>t:2 → int</c>, <c>t:3 → double</c>) so the
    /// OverrideEval class-equality check holds regardless of how the JSON
    /// number was decoded. Non-numeric values pass through unchanged — a
    /// string default against an <c>int</c> setting (a TYPE_MISMATCH tuple)
    /// is left as a <see cref="string"/>.
    /// </summary>
    [Theory]
    [MemberData(nameof(CorpusTuplesTyped))]
    public void ParityTyped(string description, ParityTuple tuple, ParityConfigRecord config)
    {
        _ = description; // Surfaces in xUnit's test report via [MemberData]'s first element.

        var settingTypes = ExtractSettingTypes(config);
        var tupleSettingType = settingTypes.TryGetValue(tuple.Key, out var t) ? t : (int?)null;

        // Build the override map, canonicalising each value against its
        // OWN setting's `t` discriminator (the override map may carry
        // unrelated keys whose runtime types differ from the tuple's).
        var overridesMap = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var kvp in config.OverridesMap)
        {
            var unwrapped = UnwrapJsonElement(kvp.Value);
            var keySettingType = settingTypes.TryGetValue(kvp.Key, out var kt) ? kt : (int?)null;
            overridesMap[kvp.Key] = Canonicalise(unwrapped, keySettingType);
        }

        using var client = new ConfeatureClient(ParityTestSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overridesMap),
                OverrideBehaviour.LocalOnly);
            options.CacheDirectory = ":memory:";
        });

        var defaultValue = Canonicalise(UnwrapJsonElement(tuple.DefaultValue), tupleSettingType);
        var expected = Canonicalise(UnwrapJsonElement(tuple.Expected), tupleSettingType);
        var user = MakeUser(tuple.User);

        var actual = client.GetValue(tuple.Key, defaultValue, user);

        actual.Should().Be(expected,
            because: "spec 070 Principle II NON-NEGOTIABLE — investigate the "
                + "evaluator / override-eval code, do NOT mutate the corpus. "
                + $"Tuple: {tuple.Description}");
    }

    /// <summary>
    /// Reads the <c>config.f[*].t</c> map from a typed config record so
    /// the typed-corpus tier can canonicalise corpus values to the
    /// target setting's native .NET type.
    /// </summary>
    private static Dictionary<string, int> ExtractSettingTypes(ParityConfigRecord config)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        if (config.Config.ValueKind != JsonValueKind.Object)
        {
            return result;
        }

        if (!config.Config.TryGetProperty("f", out var fElement)
            || fElement.ValueKind != JsonValueKind.Object)
        {
            return result;
        }

        foreach (var prop in fElement.EnumerateObject())
        {
            if (prop.Value.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (prop.Value.TryGetProperty("t", out var tElement)
                && tElement.ValueKind == JsonValueKind.Number
                && tElement.TryGetInt32(out var tInt))
            {
                result[prop.Name] = tInt;
            }
        }

        return result;
    }

    /// <summary>
    /// Canonicalises a corpus value to the target setting's native .NET
    /// type. The corpus decoder (<see cref="UnwrapJsonElement"/>) returns
    /// <see cref="int"/> for integer JSON literals and <see cref="double"/>
    /// for non-integer or out-of-range numbers — but a <c>t:3</c> double
    /// setting whose corpus value is <c>0</c> needs the value coerced to
    /// <c>0.0</c> so the OverrideEval class-equality check (which compares
    /// <see cref="object.GetType"/>) holds. Non-numeric values and
    /// non-typed targets pass through unchanged.
    /// </summary>
    private static object Canonicalise(object value, int? settingType)
    {
        if (settingType is null || value is not (int or double or long))
        {
            return value;
        }

        if (settingType == 3)
        {
            return value switch
            {
                int i => (double)i,
                long l => (double)l,
                double d => d,
                _ => value,
            };
        }

        if (settingType == 2)
        {
            return value switch
            {
                int i => i,
                long l => (int)l,
                double d => (int)d,
                _ => value,
            };
        }

        return value;
    }

    private static User? MakeUser(Dictionary<string, JsonElement>? user)
    {
        if (user is null)
        {
            return null;
        }

        string identifier = string.Empty;
        if (user.TryGetValue("identifier", out var idEl) && idEl.ValueKind == JsonValueKind.String)
        {
            identifier = idEl.GetString() ?? string.Empty;
        }

        string? email = null;
        if (user.TryGetValue("email", out var emEl) && emEl.ValueKind == JsonValueKind.String)
        {
            email = emEl.GetString();
        }

        string? country = null;
        if (user.TryGetValue("country", out var coEl) && coEl.ValueKind == JsonValueKind.String)
        {
            country = coEl.GetString();
        }

        Dictionary<string, object>? custom = null;
        if (user.TryGetValue("custom", out var cuEl) && cuEl.ValueKind == JsonValueKind.Object)
        {
            custom = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var prop in cuEl.EnumerateObject())
            {
                if (prop.Value.ValueKind == JsonValueKind.String)
                {
                    custom[prop.Name] = prop.Value.GetString() ?? string.Empty;
                }
            }
        }

        return new User(identifier, email, country, custom);
    }

    /// <summary>
    /// Coerces a <see cref="JsonElement"/> to the closest BCL primitive.
    /// The corpus uses bool / string / int / double exclusively (no
    /// nested objects or arrays at the leaves), matching the v1 boolean
    /// evaluator's supported types.
    /// </summary>
    private static object UnwrapJsonElement(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.String:
                return element.GetString() ?? string.Empty;
            case JsonValueKind.Number:
                if (element.TryGetInt32(out var intValue))
                {
                    return intValue;
                }

                return element.GetDouble();
            case JsonValueKind.Null:
                return null!;
            default:
                throw new InvalidOperationException(
                    $"Unexpected corpus value kind {element.ValueKind}; the parity corpus uses "
                    + "primitives only (bool/string/int/double).");
        }
    }

    /// <summary>Public DTO — required for xUnit's <see cref="MemberDataAttribute"/> marshalling.</summary>
    public sealed class ParityTuple
    {
        [JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;

        [JsonPropertyName("configId")]
        public string ConfigId { get; set; } = string.Empty;

        [JsonPropertyName("key")]
        public string Key { get; set; } = string.Empty;

        [JsonPropertyName("defaultValue")]
        public JsonElement DefaultValue { get; set; }

        [JsonPropertyName("user")]
        public Dictionary<string, JsonElement>? User { get; set; }

        [JsonPropertyName("expected")]
        public JsonElement Expected { get; set; }

        /// <summary>
        /// Optional expected variation id (spec 152 / #475). Present on the 14
        /// variationId-bearing rule-corpus tuples; absent (null) everywhere
        /// else. When present, the rule runner asserts it against the PUBLIC
        /// <c>GetValueDetails(...).VariationId</c> in addition to the value.
        /// </summary>
        [JsonPropertyName("expectedVariationId")]
        public string? ExpectedVariationId { get; set; }
    }

    /// <summary>Public DTO — required for xUnit's <see cref="MemberDataAttribute"/> marshalling.</summary>
    public sealed class ParityConfigRecord
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;

        /// <summary>
        /// The raw <c>config_v6.json</c> body for this record. Used by
        /// the typed-corpus tier to extract <c>f[*].t</c> discriminators
        /// for canonicalisation; unused by the boolean tier.
        /// </summary>
        [JsonPropertyName("config")]
        public JsonElement Config { get; set; }

        [JsonPropertyName("overridesMap")]
        public Dictionary<string, JsonElement> OverridesMap { get; set; } = new();
    }
}
