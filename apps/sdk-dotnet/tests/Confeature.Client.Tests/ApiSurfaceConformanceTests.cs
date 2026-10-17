// SPDX-License-Identifier: MIT

using System.Linq;
using System.Reflection;
using ConfigCat.Client;
using ConfigCat.Client.Configuration;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Spec 070 US3 — API-surface conformance test for <c>sdk-dotnet</c>.
/// </summary>
/// <remarks>
/// <para>
/// Reflects over the official ConfigCat .NET SDK
/// (<see cref="ConfigCat.Client.ConfigCatClient"/>, pinned via a
/// test-scope <c>&lt;PackageReference&gt;</c> in
/// <c>Confeature.Client.Tests.csproj</c> at version <c>9.5.0</c>) and the
/// Confeature <see cref="ConfeatureClient"/>, and asserts that the
/// Confeature client's public surface is a conforming superset of
/// ConfigCat's <em>core</em> evaluation surface — a consumer migrating
/// from <c>ConfigCat.Client</c> changes only the SDK key + the
/// <c>using</c> directive, and every core type / method they reference
/// still resolves.
/// </para>
/// <para>
/// Unlike the self-regression <see cref="PublicImportTests"/> (which
/// guards against accidental renames against a Confeature-authored
/// expectation list), this test guards against drift <em>from
/// ConfigCat</em> — the reference is the official SDK on the test
/// classpath.
/// </para>
/// <para>
/// <strong>KNOWN DIVERGENCE (#264 / #266..#269).</strong> Epic #264's
/// audit found five .NET API-surface gaps versus ConfigCat. Spec 070 is
/// SPLIT-scoped (research §R0) — it delivers typed-value parity + this
/// conformance test only; the corrections are DEFERRED to the
/// #266-#269 follow-on. Each gap below is asserted as a drift-guard:
/// the method is currently ABSENT on <see cref="ConfeatureClient"/>,
/// and the assertion is written so it fails loudly the day the
/// follow-on adds it — at which point this test is updated to assert
/// presence + conformance.
/// </para>
/// <list type="bullet">
///   <item><description><c>GetValueDetails&lt;T&gt;</c> / <c>GetValueDetailsAsync&lt;T&gt;</c> — #266 (an <c>EvaluationDetails</c>-shaped result type).</description></item>
///   <item><description><c>GetAllValues</c> / <c>GetAllValuesAsync</c> — #266.</description></item>
///   <item><description>client-level <c>GetAllKeys</c> / <c>GetAllKeysAsync</c> — #269.</description></item>
///   <item><description><c>SetOnline</c> / <c>SetOffline</c> / <c>IsOffline</c> — #267.</description></item>
///   <item><description>hook events (<c>ClientReady</c> / <c>ConfigChanged</c> / <c>FlagEvaluated</c> / <c>Error</c>) — #268.</description></item>
/// </list>
/// <para>
/// Reflection only — no network, no client instantiation.
/// </para>
/// </remarks>
public class ApiSurfaceConformanceTests
{
    /// <summary>
    /// The core evaluation surface ConfigCat's <c>ConfigCatClient</c>
    /// exposes that every ConfigCat-compatible client MUST mirror by
    /// name — the methods a migrating consumer's code references.
    /// </summary>
    private static readonly string[] CoreInstanceMethods =
    {
        "GetValue",
        "ForceRefresh",
        "ForceRefreshAsync",
        "Snapshot",
        // Spec 077 / #269 — client-level GetAllKeys landed.
        "GetAllKeys",
        // Spec 083 / #266 slice 5/12 — GetValueDetails(Async) + GetAllValues(Async) landed.
        "GetValueDetails",
        "GetValueDetailsAsync",
        "GetAllValues",
        "GetAllValuesAsync",
        // Spec 094 / #267 slice 5/14 — online/offline triplet methods landed.
        "SetOnline",
        "SetOffline",
        "Dispose",
    };

    /// <summary>
    /// ConfigCat .NET API-surface gaps deferred to the #266-#269
    /// follow-on (epic #264). Asserted absent on
    /// <see cref="ConfeatureClient"/> as drift-guards.
    /// </summary>
    private static readonly (string MethodName, string IssueNote)[] KnownDivergences264 =
    {
        // NOTE: `GetValueDetails(Async)` + `GetAllValues(Async)` moved to
        // CoreInstanceMethods under spec 083 / #266 slice 5 (the four
        // ConfigCat-aligned typed-details + bulk-read methods landed).
        ("GetAllValueDetails", "#266"),
        ("GetAllValueDetailsAsync", "#266"),
        // NOTE: `GetAllKeys` moved to CoreInstanceMethods under spec
        // 077 / #269 (the sync client-level enumerator landed). The
        // async sibling `GetAllKeysAsync` remains deferred to the
        // follow-on that adds the async bulk-read family.
        ("GetAllKeysAsync", "#269"),
        // NOTE: `SetOnline` + `SetOffline` moved to CoreInstanceMethods
        // under spec 094 / #267 slice 5/14 (both landed). `IsOffline`
        // is a property (mirrors upstream shape) — see
        // `ConfeatureClient_carries_IsOffline_property`.
    };

    /// <summary>
    /// ConfigCat hook events deferred to #268. Asserted absent on
    /// <see cref="ConfeatureClient"/> as drift-guards.
    /// </summary>
    private static readonly string[] KnownDivergentEvents264 =
    {
        "ClientReady",
        "ConfigChanged",
        "ConfigFetched",
        "FlagEvaluated",
        "Error",
    };

    private static System.Collections.Generic.HashSet<string> PublicMethodNames(System.Type type)
    {
        var names = new System.Collections.Generic.HashSet<string>(System.StringComparer.Ordinal);
        foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (m.DeclaringType == typeof(object))
            {
                continue;
            }

            // Strip property / event accessor prefixes — only "real"
            // methods participate in surface conformance.
            var name = m.Name;
            if (name.StartsWith("get_", System.StringComparison.Ordinal)
                || name.StartsWith("set_", System.StringComparison.Ordinal)
                || name.StartsWith("add_", System.StringComparison.Ordinal)
                || name.StartsWith("remove_", System.StringComparison.Ordinal))
            {
                continue;
            }

            names.Add(name);
        }

        return names;
    }

    [Fact]
    public void Official_ConfigCat_SDK_is_on_the_test_classpath()
    {
        // Sanity guard — the reflective comparison is meaningless if
        // the official SDK failed to resolve at compile time.
        var configCatType = typeof(ConfigCatClient);
        configCatType.Namespace.Should().Be("ConfigCat.Client",
            because: "ApiSurfaceConformanceTests requires ConfigCat.Client 9.5.0 as a test-scope dependency");
    }

    [Fact]
    public void ConfeatureClient_covers_ConfigCat_core_evaluation_surface()
    {
        var confeature = PublicMethodNames(typeof(ConfeatureClient));
        var configCat = PublicMethodNames(typeof(ConfigCatClient));

        foreach (var core in CoreInstanceMethods)
        {
            configCat.Should().Contain(core,
                because: $"ConfigCat's ConfigCatClient is expected to expose the core method {core}");
            confeature.Should().Contain(core,
                because: $"ConfeatureClient MUST expose ConfigCat's core method {core} "
                    + "(Principle II — drop-in compatibility)");
        }
    }

    [Fact]
    public void ConfeatureClient_carries_generic_GetValue_with_ConfigCat_signature()
    {
        // ConfigCat: T GetValue<T>(string key, T defaultValue, User user = null)
        // Confeature: T GetValue<T>(string key, T defaultValue, User? user = null)
        // Conformance: both expose a 3-parameter generic GetValue<T>.
        var confeatureGetValue = typeof(ConfeatureClient)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.Name == "GetValue" && m.IsGenericMethodDefinition)
            .ToList();

        confeatureGetValue.Should().NotBeEmpty(
            because: "ConfeatureClient MUST expose a generic GetValue<T>(...) overload");
        confeatureGetValue.Should().Contain(m => m.GetParameters().Length == 3,
            because: "ConfeatureClient MUST expose a 3-parameter generic GetValue<T>(key, default, user)");
    }

    [Fact]
    public void ConfeatureClient_exposes_non_generic_GetValue_as_Confeature_superset()
    {
        // The non-generic GetValue(string, object?, User?) is a Confeature
        // SUPERSET extension — ConfigCat has no equivalent (it surfaces
        // only the generic GetValue<T>). The conformance bar is "superset",
        // so this is a legitimate addition; recorded here to document the
        // deliberate divergence direction.
        var configCatNonGeneric = typeof(ConfigCatClient)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.Name == "GetValue" && !m.IsGenericMethodDefinition)
            .ToList();
        configCatNonGeneric.Should().BeEmpty(
            because: "ConfigCat's ConfigCatClient has no non-generic GetValue — Confeature's is additive");

        var confeatureNonGeneric = typeof(ConfeatureClient)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.Name == "GetValue" && !m.IsGenericMethodDefinition)
            .ToList();
        confeatureNonGeneric.Should().NotBeEmpty(
            because: "ConfeatureClient exposes a non-generic GetValue(key, object?, User?) — the parity-corpus entry point");
    }

    [Fact]
    public void ConfeatureClient_carries_ForceRefresh_signatures()
    {
        var confeatureType = typeof(ConfeatureClient);
        confeatureType.GetMethod("ForceRefresh", System.Type.EmptyTypes)
            .Should().NotBeNull(because: "ConfeatureClient MUST mirror ConfigCat's ForceRefresh()");
        confeatureType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Any(m => m.Name == "ForceRefreshAsync")
            .Should().BeTrue(because: "ConfeatureClient MUST mirror ConfigCat's ForceRefreshAsync(...)");
    }

    [Fact]
    public void ConfeatureClient_carries_Snapshot()
    {
        // ConfigCat exposes Snapshot() returning ConfigCatClientSnapshot;
        // Confeature exposes Snapshot() returning ConfeatureSnapshot. The
        // conformance bar is "name + arity match" — the return type
        // differs by design (each SDK projects its own snapshot type).
        var confeatureSnapshot = typeof(ConfeatureClient).GetMethod("Snapshot", System.Type.EmptyTypes);
        confeatureSnapshot.Should().NotBeNull(because: "ConfeatureClient MUST expose a 0-arg Snapshot() method");

        var configCatSnapshot = typeof(ConfigCatClient).GetMethod("Snapshot", System.Type.EmptyTypes);
        configCatSnapshot.Should().NotBeNull(because: "ConfigCat's ConfigCatClient is expected to expose Snapshot()");
    }

    [Fact]
    public void ConfeatureClient_carries_Dispose_and_async_dispose()
    {
        // ConfigCat exposes Dispose() (IDisposable) only.
        // Confeature exposes Dispose() (IDisposable) + DisposeAsync()
        // (IAsyncDisposable) on net8.0+ / netstandard2.1+ — a Confeature
        // SUPERSET. The test project targets net8.0+net10.0 so
        // DisposeAsync is always reachable in this assembly.
        var confeatureType = typeof(ConfeatureClient);
        confeatureType.GetMethod("Dispose", System.Type.EmptyTypes)
            .Should().NotBeNull(because: "ConfeatureClient MUST mirror ConfigCat's Dispose()");
        confeatureType.GetMethod("DisposeAsync", System.Type.EmptyTypes)
            .Should().NotBeNull(because: "ConfeatureClient adds IAsyncDisposable as a Confeature superset on net8.0+/netstandard2.1+");
    }

    [Fact]
    public void ConfeatureClient_uses_constructor_instead_of_static_factory_by_design()
    {
        // DIVERGENCE-BY-DESIGN (NOT a #264 divergence — no follow-on issue).
        // ConfigCat constructs via static `ConfigCatClient.Get(sdkKey, options => …)`
        // (its public ctors set is empty).
        // Confeature constructs via `new ConfeatureClient(sdkKey, options => …)` —
        // idiomatic .NET ergonomics. Both forms are recognised; a future spec
        // could converge them but Principle II's wire-and-method-name compat
        // does not require it.
        var configCatGet = typeof(ConfigCatClient).GetMethod(
            "Get",
            BindingFlags.Public | BindingFlags.Static,
            null,
            new[] { typeof(string), typeof(System.Action<ConfigCatClientOptions>) },
            null);
        configCatGet.Should().NotBeNull(
            because: "ConfigCat exposes the static Get(string, Action<ConfigCatClientOptions>) factory");
        typeof(ConfigCatClient).GetConstructors().Should().BeEmpty(
            because: "ConfigCat hides the constructor — the static factory is the documented construction path");

        var confeatureCtor = typeof(ConfeatureClient).GetConstructor(
            new[] { typeof(string), typeof(System.Action<ConfeatureClientOptions>) });
        confeatureCtor.Should().NotBeNull(
            because: "ConfeatureClient exposes a public (sdkKey, Action<ConfeatureClientOptions>?) constructor by design");
    }

    [Fact]
    public void Known_divergences_264_are_absent_drift_guard()
    {
        // KNOWN DIVERGENCE (#264 / #266..#269) — spec 070 is SPLIT-scoped:
        // the corrections are DEFERRED. These methods are EXPECTED to be
        // absent on ConfeatureClient today. The assertion is a drift-guard:
        // when the #266-#269 follow-on adds one, this test fails and MUST
        // be updated to assert presence + conformance against ConfigCat.
        var confeature = PublicMethodNames(typeof(ConfeatureClient));
        var configCat = PublicMethodNames(typeof(ConfigCatClient));

        foreach (var (method, issue) in KnownDivergences264)
        {
            configCat.Should().Contain(method,
                because: $"sanity — ConfigCat 9.5.0 is expected to expose {method} (the divergence is meaningful only if the reference still carries it)");
            confeature.Should().NotContain(method,
                because: $"KNOWN DIVERGENCE (#264 / {issue}): {method} is deferred to the #266-#269 follow-on and MUST still be absent on ConfeatureClient. "
                    + "If this fails, the follow-on landed — update this conformance test to assert presence + ConfigCat conformance.");
        }
    }

    [Fact]
    public void ConfeatureClient_carries_IsOffline_property()
    {
        // Spec 094 / #267 slice 5/14 — IsOffline is a property (NOT a method) on the upstream
        // ConfigCat .NET client surface. ConfeatureClient mirrors that exact shape (Principle II
        // — drop-in compatibility). The property returns bool and is read-only (no setter — flip
        // through the SetOnline() / SetOffline() methods).
        var configCatIsOffline = typeof(ConfigCatClient).GetProperty(
            "IsOffline", BindingFlags.Public | BindingFlags.Instance);
        configCatIsOffline.Should().NotBeNull(
            because: "sanity — ConfigCat 9.5.0 is expected to expose IsOffline as a property");
        configCatIsOffline!.PropertyType.Should().Be<bool>(
            because: "sanity — ConfigCat IsOffline is a bool property");

        var confeatureIsOffline = typeof(ConfeatureClient).GetProperty(
            "IsOffline", BindingFlags.Public | BindingFlags.Instance);
        confeatureIsOffline.Should().NotBeNull(
            because: "ConfeatureClient MUST expose IsOffline as a property (Principle II — "
                + "drop-in compatibility with ConfigCat's IsOffline property)");
        confeatureIsOffline!.PropertyType.Should().Be<bool>(
            because: "ConfeatureClient.IsOffline MUST return bool to match ConfigCat's signature");
    }

    [Fact]
    public void ConfeatureClient_carries_hook_events()
    {
        // Spec 106 / #268 slice 4/14 — ConfigCat exposes the hooks surface as public events on
        // ConfigCatClient (ClientReady / ConfigChanged / ConfigFetched / FlagEvaluated / Error).
        // Confeature mirrors all five so a migrating consumer's subscription call sites compile
        // unchanged (Principle II — drop-in compatibility).
        var configCatEvents = typeof(ConfigCatClient)
            .GetEvents(BindingFlags.Public | BindingFlags.Instance)
            .Select(e => e.Name)
            .ToHashSet(System.StringComparer.Ordinal);
        var confeatureEvents = typeof(ConfeatureClient)
            .GetEvents(BindingFlags.Public | BindingFlags.Instance)
            .Select(e => e.Name)
            .ToHashSet(System.StringComparer.Ordinal);

        foreach (var evt in KnownDivergentEvents264)
        {
            configCatEvents.Should().Contain(evt,
                because: $"sanity — ConfigCat 9.5.0 is expected to expose the {evt} event");
            confeatureEvents.Should().Contain(evt,
                because: $"ConfeatureClient MUST expose the {evt} hook event (Principle II — "
                    + "drop-in compatibility with ConfigCat's hooks surface).");
        }
    }

    // PROOF (#915, FR-013): a deliberate break. This pull request is closed unmerged.
    [Fact]
    public void Proof915TurnsTheDotnetGateRed()
    {
        "proof".Should().Be("red");
    }
}
