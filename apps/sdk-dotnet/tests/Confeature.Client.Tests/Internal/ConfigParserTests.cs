// SPDX-License-Identifier: MIT

using System.Text.Json;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="ConfigParser"/>. Covers happy-path parsing
/// of the wire <c>config_v6.json</c> shape, plus the permissive
/// fail-soft branches that return a sentinel <c>Setting</c> rather than
/// throwing on malformed entries.
/// </summary>
public class ConfigParserTests
{
    [Fact]
    public void Parse_returns_null_when_body_is_not_an_object()
    {
        using var doc = JsonDocument.Parse("[]");

        ConfigParser.Parse(doc.RootElement).Should().BeNull();
    }

    [Fact]
    public void Parse_returns_null_when_f_property_missing()
    {
        using var doc = JsonDocument.Parse("{}");

        ConfigParser.Parse(doc.RootElement).Should().BeNull();
    }

    [Fact]
    public void Parse_returns_null_when_f_property_is_not_an_object()
    {
        using var doc = JsonDocument.Parse("{\"f\":42}");

        ConfigParser.Parse(doc.RootElement).Should().BeNull();
    }

    [Fact]
    public void Parse_extracts_boolean_settings_from_the_wire_shape()
    {
        using var doc = JsonDocument.Parse("""
            {
              "f": {
                "feature.dark-mode": { "t": 0, "v": { "b": true } },
                "feature.beta-toggle": { "t": 0, "v": { "b": false } }
              }
            }
            """);

        var settings = ConfigParser.Parse(doc.RootElement);

        settings.Should().NotBeNull();
        settings!.Should().HaveCount(2);
        settings!["feature.dark-mode"].T.Should().Be(0);
        settings!["feature.dark-mode"].V!.B.Should().BeTrue();
        settings!["feature.beta-toggle"].V!.B.Should().BeFalse();
    }

    [Fact]
    public void Parse_emits_sentinel_setting_for_non_object_entries()
    {
        using var doc = JsonDocument.Parse("{\"f\":{\"k\":42}}");

        var settings = ConfigParser.Parse(doc.RootElement);

        settings.Should().ContainKey("k");
        // Sentinel non-bool type so the evaluator returns the default.
        settings!["k"].T.Should().Be(-1);
        settings["k"].V.Should().BeNull();
    }

    [Fact]
    public void Parse_handles_string_int_double_value_slots()
    {
        using var doc = JsonDocument.Parse("""
            {
              "f": {
                "k.bool":   { "t": 0, "v": { "b": true } },
                "k.string": { "t": 1, "v": { "s": "hello" } },
                "k.int":    { "t": 2, "v": { "i": 42 } },
                "k.double": { "t": 3, "v": { "d": 3.14 } }
              }
            }
            """);

        var settings = ConfigParser.Parse(doc.RootElement);

        settings!.Should().HaveCount(4);
        settings!["k.bool"].V!.B.Should().BeTrue();
        settings!["k.string"].V!.S.Should().Be("hello");
        settings!["k.int"].V!.I.Should().Be(42);
        settings!["k.double"].V!.D.Should().Be(3.14);
    }

    [Fact]
    public void Parse_treats_missing_value_object_as_null_slot()
    {
        using var doc = JsonDocument.Parse("{\"f\":{\"k\":{\"t\":0}}}");

        var settings = ConfigParser.Parse(doc.RootElement);

        settings!["k"].T.Should().Be(0);
        settings["k"].V.Should().BeNull();
    }

    [Fact]
    public void Parse_skips_non_number_t_property()
    {
        using var doc = JsonDocument.Parse("{\"f\":{\"k\":{\"t\":\"not-a-number\"}}}");

        var settings = ConfigParser.Parse(doc.RootElement);

        // Falls back to the sentinel -1 when t is not an int.
        settings!["k"].T.Should().Be(-1);
    }
}
