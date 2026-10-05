// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Unit tests for <see cref="MapOverrideDataSource"/>. Covers the four
/// supported primitive coercions, the sync + async accessors, and the
/// error paths for null / unsupported value types.
/// </summary>
public class MapOverrideDataSourceTests
{
    [Fact]
    public void Constructor_rejects_null_map()
    {
        var act = () => new MapOverrideDataSource(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_rejects_null_override_value()
    {
        var act = () => new MapOverrideDataSource(new Dictionary<string, object> { ["k"] = null! });

        act.Should().Throw<ArgumentException>()
            .WithMessage("*Override value*null*");
    }

    [Fact]
    public void Constructor_rejects_unsupported_value_type()
    {
        var act = () => new MapOverrideDataSource(new Dictionary<string, object>
        {
            ["k"] = new object(),
        });

        act.Should().Throw<ArgumentException>()
            .WithMessage("*Unsupported override value type*");
    }

    [Fact]
    public void Coerces_bool_string_int_double_into_SettingValue()
    {
        var source = new MapOverrideDataSource(new Dictionary<string, object>
        {
            ["k.bool"] = true,
            ["k.string"] = "hello",
            ["k.int"] = 42,
            ["k.double"] = 3.14,
        });

        var map = source.GetOverridesSync();

        map.Should().NotBeNull();
        map!["k.bool"].B.Should().BeTrue();
        map["k.string"].S.Should().Be("hello");
        map["k.int"].I.Should().Be(42);
        map["k.double"].D.Should().Be(3.14);
    }

    [Fact]
    public async System.Threading.Tasks.Task GetOverridesAsync_returns_same_map_as_sync()
    {
        var source = new MapOverrideDataSource(new Dictionary<string, object>
        {
            ["k"] = true,
        });

        var sync = source.GetOverridesSync();
        var async = await source.GetOverridesAsync();

        async.Should().BeSameAs(sync);
    }
}
