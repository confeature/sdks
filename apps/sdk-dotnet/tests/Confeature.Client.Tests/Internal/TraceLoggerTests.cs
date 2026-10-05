// SPDX-License-Identifier: MIT

using System;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="TraceLogger"/>. Exercises the
/// <see cref="LogLevel"/> filtering predicate + each severity entry point.
/// </summary>
public class TraceLoggerTests
{
    [Fact]
    public void IsEnabled_returns_false_for_Off_level()
    {
        var logger = new TraceLogger { LogLevel = LogLevel.Off };

        logger.IsEnabled(LogLevel.Off).Should().BeFalse();
        logger.IsEnabled(LogLevel.Error).Should().BeFalse();
    }

    [Theory]
    [InlineData(LogLevel.Error, LogLevel.Error, true)]
    [InlineData(LogLevel.Error, LogLevel.Warning, false)]
    [InlineData(LogLevel.Warning, LogLevel.Warning, true)]
    [InlineData(LogLevel.Warning, LogLevel.Error, true)]
    [InlineData(LogLevel.Info, LogLevel.Debug, false)]
    [InlineData(LogLevel.Debug, LogLevel.Debug, true)]
    [InlineData(LogLevel.Debug, LogLevel.Error, true)]
    public void IsEnabled_filters_relative_to_configured_threshold(
        LogLevel configured, LogLevel call, bool expected)
    {
        var logger = new TraceLogger { LogLevel = configured };

        logger.IsEnabled(call).Should().Be(expected);
    }

    [Fact]
    public void Severity_entry_points_short_circuit_when_disabled()
    {
        var logger = new TraceLogger { LogLevel = LogLevel.Off };

        // Verify each path returns cleanly when filtered out. We can't
        // assert anything about Trace output here — the point is to drive
        // through the early-return branches for coverage.
        logger.Error("msg");
        logger.Warning("msg");
        logger.Info("msg");
        logger.Debug("msg");
    }

    [Fact]
    public void Severity_entry_points_emit_when_enabled()
    {
        var logger = new TraceLogger { LogLevel = LogLevel.Debug };

        logger.Error("err");
        logger.Error("err-with-ex", new InvalidOperationException("boom"));
        logger.Warning("warn");
        logger.Info("info");
        logger.Debug("debug");
        // No assertion — the gate is that none of these throw on net10.0.
    }
}
