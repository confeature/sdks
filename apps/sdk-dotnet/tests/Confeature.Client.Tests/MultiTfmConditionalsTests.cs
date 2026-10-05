// SPDX-License-Identifier: MIT

using System;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Reflection-based gate proving the conditional-interface story across
/// every TFM in the multi-target matrix. Mirrors spec 039's Phase 5
/// User-Story 2 independent test: <see cref="ConfeatureClient"/>
/// implements <see cref="IDisposable"/> unconditionally; it implements
/// <see cref="IAsyncDisposable"/> on <c>netstandard2.1</c> and
/// <c>net8.0+</c> (the TFMs where <see cref="IAsyncDisposable"/> exists
/// in the BCL).
/// </summary>
/// <remarks>
/// The test project itself targets <c>net8.0;net10.0</c>, so both
/// assertions run on every CI lane it executes against. Local execution
/// on <c>net10.0</c> is a positive assertion.
/// </remarks>
public class MultiTfmConditionalsTests
{
    [Fact]
    public void ConfeatureClient_implements_IDisposable_on_every_TFM()
    {
        var interfaces = typeof(ConfeatureClient).GetInterfaces();

        interfaces.Should().Contain(typeof(IDisposable));
    }

    [Fact]
    public void ConfeatureClient_implements_IAsyncDisposable_on_net8_and_net10()
    {
        var interfaces = typeof(ConfeatureClient).GetInterfaces();

        interfaces.Should().Contain(typeof(IAsyncDisposable));
    }

    [Fact]
    public void ConfeatureClient_exposes_DisposeAsync_method_on_net8_and_net10()
    {
        // Surface-level smoke: the method exists with the canonical
        // signature so callers using `await using` compile across TFMs.
        var method = typeof(ConfeatureClient).GetMethod("DisposeAsync");

        method.Should().NotBeNull();
        method!.ReturnType.Should().Be<System.Threading.Tasks.ValueTask>();
        method.GetParameters().Should().BeEmpty();
    }

    [Fact]
    public void ConfeatureClient_exposes_canonical_public_API_members()
    {
        var publicMethods = typeof(ConfeatureClient)
            .GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Select(m => m.Name)
            .ToHashSet();

        publicMethods.Should().Contain("GetValue");
        publicMethods.Should().Contain("Snapshot");
        publicMethods.Should().Contain("ForceRefresh");
        publicMethods.Should().Contain("ForceRefreshAsync");
        publicMethods.Should().Contain("Dispose");
    }
}
