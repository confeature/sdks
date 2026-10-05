// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Targeting-rule parity (spec 135 / #429, epic #382, US3) — the
/// <c>CORPUS_RULES</c> corpus injected through the full-config offline
/// override.
/// </summary>
/// <remarks>
/// <para>
/// Unlike the flat <c>parity-corpus</c> / <c>parity-corpus-typed</c> corpora
/// (which feed a value-only <c>overridesMap</c> via
/// <see cref="MapOverrideDataSource"/>), the rule corpus carries the whole
/// <c>{p, f, s}</c> config and is injected via
/// <see cref="FlagOverrides.LocalConfig"/> + <see cref="OverrideBehaviour.LocalOnly"/>.
/// The SDK then resolves targeting rules / segments / % options offline through
/// the real .NET evaluator, exactly as it would against a CDN-served config —
/// no network round-trip.
/// </para>
/// <para>
/// Runner contract (mirrors <c>apps/sdk-node/tests/parity/parity-rules.test.ts</c>
/// and <c>apps/sdk-python/tests/parity/test_parity_rules.py</c>): every tuple
/// branches on the config's <c>injectionMode</c>:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>"full-config"</c> → capability-probe <see cref="FlagOverrides.LocalConfig"/>.
/// If sdk-dotnet exposes it, build the override and assert the PUBLIC
/// <c>client.GetValue</c> returns <c>tuple.expected</c>. If it does NOT, SKIP
/// with a reason — NEVER fall back to the flat-map path (SC-004: no
/// <c>"full-config"</c> tuple is ever resolved on the map path).
/// </description></item>
/// </list>
/// <para>
/// sdk-dotnet HAS adopted the full-config path, so all 8 rule tuples run and
/// pass; there are no skips for this family.
/// </para>
/// <para>
/// AC4: if a tuple fails because of a real .NET evaluator targeting-rule gap
/// (not override wiring), STOP and file a discrete #382 follow-up — never a
/// corpus or test workaround.
/// </para>
/// </remarks>
public class ParityRulesTests
{
    private const string ParityTestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    /// <summary>Characters that make a JSON number non-integral ('.', exponent).</summary>
    private static readonly char[] NonIntegralNumberMarkers = { '.', 'e', 'E' };

    /// <summary>
    /// Capability probe: does this SDK expose the in-memory full-config
    /// override factory <see cref="FlagOverrides.LocalConfig"/>? The
    /// full-config path is gated on this — never silently resolved on the
    /// flat-map path (SC-004 / AC4).
    /// </summary>
    private static readonly MethodInfo? LocalConfigFactory = typeof(FlagOverrides).GetMethod(
        nameof(FlagOverrides.LocalConfig),
        BindingFlags.Public | BindingFlags.Static,
        binder: null,
        types: new[] { typeof(JsonElement), typeof(OverrideBehaviour) },
        modifiers: null);

    private static bool HasFullConfigOverrides => LocalConfigFactory is not null;

    /// <summary>
    /// Loads the 8 rule corpus tuples + the lookup map of full-config records
    /// from <c>packages/test-fixtures-sdk-parity/fixtures/</c> and yields one
    /// xUnit test case per tuple. The first element is the description so a
    /// drift surfaces by its human-readable name.
    /// </summary>
    public static IEnumerable<object?[]> RuleCorpusTuples()
    {
        var corpusJson = File.ReadAllText(WorkspaceRoot.ParityCorpusRulesPath());
        var configsJson = File.ReadAllText(WorkspaceRoot.ParityConfigsRulesPath());

        var tuples = JsonSerializer.Deserialize<List<ParityCorpusTests.ParityTuple>>(corpusJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-corpus-rules.json deserialised to null");
        var configRecords = JsonSerializer.Deserialize<List<RuleConfigRecord>>(configsJson, JsonOptions)
            ?? throw new InvalidOperationException("parity-configs-rules.json deserialised to null");

        var configsById = new Dictionary<string, RuleConfigRecord>(StringComparer.Ordinal);
        foreach (var record in configRecords)
        {
            configsById[record.Id] = record;
        }

        foreach (var tuple in tuples)
        {
            if (!configsById.TryGetValue(tuple.ConfigId, out var config))
            {
                throw new InvalidOperationException(
                    $"Rule corpus tuple '{tuple.Description}' references unknown configId='{tuple.ConfigId}'. "
                    + "Regenerate fixtures via 'pnpm run export:corpus'.");
            }

            yield return new object?[] { tuple.Description, tuple, config };
        }
    }

    [Theory]
    [MemberData(nameof(RuleCorpusTuples))]
    public void ParityRules(string description, ParityCorpusTests.ParityTuple tuple, RuleConfigRecord config)
    {
        _ = description; // Surfaces in xUnit's report via [MemberData]'s first element.

        // The rule corpus is full-config only; a flat-map tuple here would mean
        // a corpus regression, never a silent flat-map fallback (SC-004).
        config.InjectionMode.Should().Be("full-config",
            because: $"rule corpus tuple '{tuple.Description}' must be full-config (SC-004)");

        if (!HasFullConfigOverrides)
        {
            // SC-004: NEVER fall back to the flat-map path — skip with a reason.
            // xUnit has no first-class runtime skip on a fact body; we encode
            // the skip via Assert.True over the capability so a CI run surfaces
            // it explicitly rather than false-greening on the map path.
            Assert.True(HasFullConfigOverrides,
                "SDK has not adopted full-config overrides — skipping the rule tuple "
                + "rather than resolving it on the flat-map path (SC-004).");
            return;
        }

        using var client = new ConfeatureClient(ParityTestSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.FlagOverrides = FlagOverrides.LocalConfig(config.Config, OverrideBehaviour.LocalOnly);
            // Keep the test fully offline + leak-free.
            options.CacheDirectory = ":memory:";
        });

        var expected = UnwrapJsonElement(tuple.Expected);
        var user = MakeUser(tuple.User);

        // Spec 152 / #475 US2: tuples that carry `expectedVariationId` (14 of
        // 234, incl. 4 decimal-double) assert the matched variation id via the
        // PUBLIC GetValueDetails<T>. To keep the int-vs-double TYPE_MISMATCH
        // guard strict (Principle II — do NOT relax the evaluator), the typed
        // default MUST match the setting's `t`: double for t=3, int for t=2.
        // The corpus default is read once and re-typed per `t`.
        int settingType = SettingType(config.Config, tuple.Key);

        if (tuple.ExpectedVariationId is null)
        {
            // Value-only path — the boxed default mirrors the corpus' natural
            // JSON type (int / double / bool / string), with a numeric retype
            // to satisfy the strict type guard for double settings.
            var defaultValue = TypedDefault(tuple.DefaultValue, settingType);
            var actual = client.GetValue(tuple.Key, defaultValue, user);
            AssertValueEquals(actual, expected, settingType, tuple.Description);
            return;
        }

        // VariationId path: dispatch on `t` so GetValueDetails<T> closes over
        // the right T (a typed default matching the setting's type satisfies the
        // TYPE_MISMATCH guard). Assert BOTH the value and the public VariationId.
        var (actualValue, actualVariationId) = ResolveDetails(client, tuple, settingType, user);

        AssertValueEquals(actualValue, expected, settingType, tuple.Description);

        actualVariationId.Should().Be(tuple.ExpectedVariationId,
            because: "spec 152 / #475 US2 — the PUBLIC GetValueDetails(...).VariationId "
                + "must match the corpus' expectedVariationId (the #395 override→details "
                + "VariationId-propagation gap class). If this null/diverges, fix the "
                + $"dotnet override→GetValueDetails path, not the corpus. Tuple: {tuple.Description}");
    }

    /// <summary>
    /// Calls the PUBLIC <see cref="ConfeatureClient.GetValueDetails{T}"/> with a
    /// typed default matching the setting's <c>t</c> discriminator, returning the
    /// boxed value plus the resolved <c>VariationId</c>. Keeps int-vs-double
    /// strict by passing a <see cref="double"/> default for t=3 and an
    /// <see cref="int"/> default for t=2.
    /// </summary>
    private static (object? Value, string? VariationId) ResolveDetails(
        ConfeatureClient client, ParityCorpusTests.ParityTuple tuple, int settingType, User? user)
    {
        switch (settingType)
        {
            case 0:
                {
                    var details = client.GetValueDetails(tuple.Key, DefaultBool(tuple.DefaultValue), user);
                    return (details.Value, details.VariationId);
                }

            case 1:
                {
                    var details = client.GetValueDetails(tuple.Key, DefaultString(tuple.DefaultValue), user);
                    return (details.Value, details.VariationId);
                }

            case 2:
                {
                    var details = client.GetValueDetails(tuple.Key, DefaultInt(tuple.DefaultValue), user);
                    return (details.Value, details.VariationId);
                }

            case 3:
                {
                    var details = client.GetValueDetails(tuple.Key, DefaultDouble(tuple.DefaultValue), user);
                    return (details.Value, details.VariationId);
                }

            default:
                throw new InvalidOperationException(
                    $"Unexpected setting type t={settingType} for key '{tuple.Key}'.");
        }
    }

    /// <summary>
    /// Reads the setting-type discriminator <c>f[key].t</c> from a full-config
    /// blob (0 = bool, 1 = string, 2 = int, 3 = double).
    /// </summary>
    private static int SettingType(JsonElement config, string key)
    {
        if (config.TryGetProperty("f", out var settings)
            && settings.ValueKind == JsonValueKind.Object
            && settings.TryGetProperty(key, out var setting)
            && setting.TryGetProperty("t", out var t)
            && t.ValueKind == JsonValueKind.Number
            && t.TryGetInt32(out var typeCode))
        {
            return typeCode;
        }

        throw new InvalidOperationException(
            $"Could not read setting type 't' for key '{key}' from the full-config blob.");
    }

    /// <summary>
    /// Boxes the corpus default re-typed to the setting's <c>t</c> — notably a
    /// JSON integer default (<c>-1</c>) for a DOUBLE setting (t=3) widens to a
    /// CLR <see cref="double"/> so the strict TYPE_MISMATCH guard is satisfied.
    /// </summary>
    private static object TypedDefault(JsonElement defaultValue, int settingType) => settingType switch
    {
        0 => DefaultBool(defaultValue),
        1 => DefaultString(defaultValue),
        2 => DefaultInt(defaultValue),
        3 => DefaultDouble(defaultValue),
        _ => throw new InvalidOperationException($"Unexpected setting type t={settingType}."),
    };

    private static bool DefaultBool(JsonElement e) =>
        e.ValueKind == JsonValueKind.True || e.ValueKind == JsonValueKind.False
            ? e.GetBoolean()
            : false;

    private static string DefaultString(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? e.GetString() ?? string.Empty : string.Empty;

    private static int DefaultInt(JsonElement e) =>
        e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var i) ? i : -1;

    private static double DefaultDouble(JsonElement e) =>
        e.ValueKind == JsonValueKind.Number ? e.GetDouble() : -1d;

    /// <summary>
    /// Asserts the resolved value equals the expected leaf. Numeric settings
    /// (t=2 int, t=3 double) compare NUMERICALLY (the corpus encodes a whole
    /// double as a JSON integer), every other type compares by value.
    /// </summary>
    private static void AssertValueEquals(object? actual, object expected, int settingType, string description)
    {
        var because = "spec 135 / #429 Principle II NON-NEGOTIABLE — investigate the "
            + "evaluator / override router, do NOT mutate the corpus. If this is a "
            + "real .NET targeting-rule engine gap (not an override-wiring bug), STOP "
            + "and file a discrete #382 follow-up (AC4). "
            + $"Tuple: {description}";

        if (settingType is 2 or 3)
        {
            Convert.ToDouble(actual, System.Globalization.CultureInfo.InvariantCulture)
                .Should().Be(
                    Convert.ToDouble(expected, System.Globalization.CultureInfo.InvariantCulture),
                    because);
            return;
        }

        actual.Should().Be(expected, because);
    }

    /// <summary>
    /// The in-memory full-config override factory is exposed on this SDK (no
    /// skips for the rule family).
    /// </summary>
    [Fact]
    public void FullConfigFactoryIsExposed()
    {
        HasFullConfigOverrides.Should().BeTrue(
            because: "FlagOverrides.LocalConfig must be exposed; sdk-dotnet has "
                + "adopted the in-memory full-config override path (#429).");
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
                // The typed-attribute encoding (spec 151 / #468): a custom value
                // is decoded by its NATURAL JSON type, so a number / bool / array
                // / Date reaches the typed User un-stringified. Non-finite numbers
                // (NaN / ±Infinity), which cannot survive a plain JSON round-trip,
                // are carried by the {"$num": "..."} sentinel (#479) and decoded
                // back to the matching CLR double — mirroring the TS / Python rule
                // runners.
                var decoded = DecodeCustomValue(prop.Value);
                if (decoded is not null)
                {
                    custom[prop.Name] = decoded;
                }
            }
        }

        return new User(identifier, email, country, custom);
    }

    /// <summary>
    /// Decodes one typed-attribute-encoded <c>user.custom</c> value into the
    /// native CLR type the typed <see cref="User"/> carries (spec 151 / #468):
    /// string→<c>string</c>, number→<c>long</c>/<c>double</c>, bool→<c>bool</c>,
    /// array→<c>string[]</c>, <c>{"$date":n}</c>→<see cref="DateTimeOffset"/> at
    /// epoch seconds, <c>{"$num":"NaN"|"Infinity"|"-Infinity"}</c>→the matching
    /// non-finite <see cref="double"/> (#479), null→absent (returns <c>null</c>).
    /// Mirrors the TS / Python <c>_decode_custom_value</c> inverse of the
    /// exporter's encoder.
    /// </summary>
    private static object? DecodeCustomValue(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                return value.GetString() ?? string.Empty;
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                // Integral numbers decode as long; fractional / exponent forms as
                // double, matching the natural-JSON-type encoding (number → JSON
                // number). A raw text with '.', 'e', or 'E' is non-integral.
                var raw = value.GetRawText();
                if (raw.IndexOfAny(NonIntegralNumberMarkers) < 0 && value.TryGetInt64(out var l))
                {
                    return l;
                }

                return value.GetDouble();
            case JsonValueKind.Array:
                {
                    var list = new List<string>();
                    foreach (var item in value.EnumerateArray())
                    {
                        list.Add(item.GetString() ?? string.Empty);
                    }

                    return list.ToArray();
                }

            case JsonValueKind.Object:
                // Date sentinel: {"$date": <unix-epoch-seconds>} → a UTC
                // DateTimeOffset, the inverse of the exporter's encoder. The
                // evaluator converts it back to fractional epoch seconds exactly.
                if (value.TryGetProperty("$date", out var dateEl) && dateEl.ValueKind == JsonValueKind.Number)
                {
                    var epochSeconds = dateEl.GetDouble();
                    return DateTimeOffset.UnixEpoch.AddMilliseconds(epochSeconds * 1000.0);
                }

                // Non-finite number sentinel (#479): {"$num": "NaN"|"Infinity"|
                // "-Infinity"} → the matching CLR double. The exporter emits this
                // tag (parallel to {$date}) because `JSON.stringify(NaN|±Infinity)`
                // collapses to a lossy `null` — so these 6 number/date-to-string
                // conversion tuples can round-trip and RUN. The evaluator's
                // attribute→string (Comparators.NumberToCanonicalString) prints
                // them as "NaN"/"Infinity"/"-Infinity", byte-identical to the
                // canonical TS oracle.
                if (value.TryGetProperty("$num", out var numEl) && numEl.ValueKind == JsonValueKind.String)
                {
                    return numEl.GetString() switch
                    {
                        "NaN" => double.NaN,
                        "Infinity" => double.PositiveInfinity,
                        "-Infinity" => double.NegativeInfinity,
                        var other => throw new InvalidOperationException(
                            $"Unexpected {{$num}} sentinel value '{other}'; expected "
                            + "\"NaN\", \"Infinity\", or \"-Infinity\"."),
                    };
                }

                return null;
            case JsonValueKind.Null:
            default:
                return null;
        }
    }

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
                    $"Unexpected corpus value kind {element.ValueKind}; the rule corpus uses "
                    + "primitives only (bool/string/int/double) at the leaves.");
        }
    }

    /// <summary>
    /// Public DTO for the rule corpus configs — required for xUnit's
    /// <see cref="MemberDataAttribute"/> marshalling. Adds the
    /// <c>injectionMode</c> discriminator the flat
    /// <see cref="ParityCorpusTests.ParityConfigRecord"/> lacks.
    /// </summary>
    public sealed class RuleConfigRecord
    {
        [System.Text.Json.Serialization.JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [System.Text.Json.Serialization.JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;

        [System.Text.Json.Serialization.JsonPropertyName("injectionMode")]
        public string InjectionMode { get; set; } = string.Empty;

        /// <summary>The full <c>config_v6</c> blob (<c>{p, f, s}</c>).</summary>
        [System.Text.Json.Serialization.JsonPropertyName("config")]
        public JsonElement Config { get; set; }
    }
}
