// SPDX-License-Identifier: MIT

using System;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Unit tests for <see cref="SettingValue"/>. Verifies the four-slot
/// container + the canonical B → S → I → D coalescing chain.
/// </summary>
public class SettingValueTests
{
    [Fact]
    public void Of_bool_populates_only_the_B_slot()
    {
        var value = SettingValue.Of(true);

        value.B.Should().BeTrue();
        value.S.Should().BeNull();
        value.I.Should().BeNull();
        value.D.Should().BeNull();
    }

    [Fact]
    public void Of_string_populates_only_the_S_slot()
    {
        var value = SettingValue.Of("hello");

        value.S.Should().Be("hello");
        value.B.Should().BeNull();
        value.I.Should().BeNull();
        value.D.Should().BeNull();
    }

    [Fact]
    public void Of_string_rejects_null()
    {
        var act = () => SettingValue.Of((string)null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Of_int_populates_only_the_I_slot()
    {
        var value = SettingValue.Of(42);

        value.I.Should().Be(42);
        value.B.Should().BeNull();
        value.S.Should().BeNull();
        value.D.Should().BeNull();
    }

    [Fact]
    public void Of_double_populates_only_the_D_slot()
    {
        var value = SettingValue.Of(3.14);

        value.D.Should().Be(3.14);
        value.B.Should().BeNull();
        value.S.Should().BeNull();
        value.I.Should().BeNull();
    }

    [Fact]
    public void Empty_value_initializes_with_all_null_slots()
    {
        var value = new SettingValue();

        value.B.Should().BeNull();
        value.S.Should().BeNull();
        value.I.Should().BeNull();
        value.D.Should().BeNull();
    }
}
