// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="Evaluator"/>. Covers the four-type happy
/// paths (boolean / string / int / double), missing-key fallback,
/// genuinely-unknown setting type (UNSUPPORTED_TYPE), default-type
/// disagreement (TYPE_MISMATCH), malformed value, and null config.
/// </summary>
public class EvaluatorTests
{
    private static Dictionary<string, Setting> Settings(params (string Key, int Type, SettingValue? Value)[] items)
    {
        var dict = new Dictionary<string, Setting>();
        foreach (var (key, type, value) in items)
        {
            dict[key] = new Setting { T = type, V = value };
        }

        return dict;
    }

    // -----------------------------------------------------------------
    // Happy path — boolean (unchanged behaviour from the v1 evaluator).
    // -----------------------------------------------------------------

    [Fact]
    public void Evaluate_returns_cached_boolean_on_happy_path()
    {
        var settings = Settings(("k", 0, SettingValue.Of(true)));

        var result = Evaluator.Evaluate<bool>(settings, "k", false, user: null);

        result.Value.Should().Be(true);
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void Evaluate_returns_default_when_settings_null()
    {
        var result = Evaluator.Evaluate<bool>(settings: null, "k", true, user: null);

        result.Value.Should().Be(true);
        result.Error.Should().Be(EvaluationError.NoConfig);
    }

    [Fact]
    public void Evaluate_returns_default_when_key_absent()
    {
        var settings = Settings(("other", 0, SettingValue.Of(true)));

        var result = Evaluator.Evaluate<bool>(settings, "missing", false, user: null);

        result.Value.Should().Be(false);
        result.Error.Should().Be(EvaluationError.KeyNotFound);
    }

    // -----------------------------------------------------------------
    // Spec 070 FR-003 — UNSUPPORTED_TYPE applies only to a genuinely
    // unknown `T` discriminator (negative, ≥ 4, or non-numeric). The
    // pre-existing assertion that asserted UNSUPPORTED_TYPE for `t:1`
    // is reshaped per FR-010 — `t:1` now resolves through the widened
    // evaluator.
    // -----------------------------------------------------------------

    [Fact]
    public void Evaluate_returns_default_when_setting_type_genuinely_unknown()
    {
        var settings = Settings(("k", 99, SettingValue.Of(true)));

        var result = Evaluator.Evaluate<bool>(settings, "k", true, user: null);

        result.Value.Should().Be(true);
        result.Error.Should().Be(EvaluationError.UnsupportedType);
        result.IsUnsupportedType.Should().BeTrue();
    }

    [Fact]
    public void EvaluateDynamic_returns_default_when_setting_type_genuinely_unknown()
    {
        var settings = Settings(("k", -1, SettingValue.Of(true)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: false, user: null);

        result.Value.Should().Be(false);
        result.Error.Should().Be(EvaluationError.UnsupportedType);
    }

    [Fact]
    public void Evaluate_returns_default_when_default_is_not_boolean()
    {
        var settings = Settings(("k", 0, SettingValue.Of(true)));

        var result = Evaluator.Evaluate<int>(settings, "k", 42, user: null);

        result.Value.Should().Be(42);
        result.Error.Should().Be(EvaluationError.TypeMismatch);
        result.IsTypeMismatch.Should().BeTrue();
    }

    [Fact]
    public void Evaluate_returns_default_when_setting_value_slot_empty()
    {
        var settings = Settings(("k", 0, new SettingValue { B = null }));

        var result = Evaluator.Evaluate<bool>(settings, "k", false, user: null);

        result.Value.Should().Be(false);
        result.Error.Should().Be(EvaluationError.MalformedValue);
    }

    [Fact]
    public void EvaluateDynamic_routes_int_default_to_TYPE_MISMATCH()
    {
        var settings = Settings(("k", 0, SettingValue.Of(true)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: 42, user: null);

        result.Value.Should().Be(42);
        result.Error.Should().Be(EvaluationError.TypeMismatch);
    }

    [Fact]
    public void EvaluateDynamic_returns_boolean_on_happy_path()
    {
        var settings = Settings(("k", 0, SettingValue.Of(true)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: false, user: null);

        result.Value.Should().Be(true);
        result.Error.Should().Be(EvaluationError.None);
    }

    // -----------------------------------------------------------------
    // Spec 070 FR-001/FR-002 — typed happy paths for string (t:1),
    // int (t:2), double (t:3) across BOTH evaluator entry points.
    // -----------------------------------------------------------------

    [Fact]
    public void Evaluate_returns_string_for_string_setting()
    {
        var settings = Settings(("k", 1, SettingValue.Of("hello")));

        var result = Evaluator.Evaluate<string>(settings, "k", "fallback", user: null);

        result.Value.Should().Be("hello");
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void Evaluate_returns_int_for_int_setting()
    {
        var settings = Settings(("k", 2, SettingValue.Of(5)));

        var result = Evaluator.Evaluate<int>(settings, "k", -1, user: null);

        result.Value.Should().Be(5);
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void Evaluate_returns_double_for_double_setting()
    {
        var settings = Settings(("k", 3, SettingValue.Of(0.25)));

        var result = Evaluator.Evaluate<double>(settings, "k", 0.0, user: null);

        result.Value.Should().Be(0.25);
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void EvaluateDynamic_returns_string_for_string_setting()
    {
        var settings = Settings(("k", 1, SettingValue.Of("hello")));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: "fallback", user: null);

        result.Value.Should().Be("hello");
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void EvaluateDynamic_returns_int_for_int_setting()
    {
        var settings = Settings(("k", 2, SettingValue.Of(5)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: -1, user: null);

        result.Value.Should().Be(5);
        result.Error.Should().Be(EvaluationError.None);
    }

    [Fact]
    public void EvaluateDynamic_returns_double_for_double_setting()
    {
        var settings = Settings(("k", 3, SettingValue.Of(0.25)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: 0.0, user: null);

        result.Value.Should().Be(0.25);
        result.Error.Should().Be(EvaluationError.None);
    }

    // -----------------------------------------------------------------
    // Spec 070 FR-003 — typed TYPE_MISMATCH: a default whose runtime
    // type disagrees with the setting's `t` returns the caller's default
    // with TYPE_MISMATCH, NOT UNSUPPORTED_TYPE.
    // -----------------------------------------------------------------

    [Fact]
    public void EvaluateDynamic_returns_default_for_string_setting_with_number_default()
    {
        var settings = Settings(("k", 1, SettingValue.Of("hello")));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: 0, user: null);

        result.Value.Should().Be(0);
        result.Error.Should().Be(EvaluationError.TypeMismatch);
    }

    [Fact]
    public void EvaluateDynamic_returns_default_for_int_setting_with_string_default()
    {
        var settings = Settings(("k", 2, SettingValue.Of(5)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: "not-a-number", user: null);

        result.Value.Should().Be("not-a-number");
        result.Error.Should().Be(EvaluationError.TypeMismatch);
    }

    [Fact]
    public void EvaluateDynamic_returns_default_for_double_setting_with_string_default()
    {
        var settings = Settings(("k", 3, SettingValue.Of(0.25)));

        var result = Evaluator.EvaluateDynamic(settings, "k", defaultValue: "not-a-number", user: null);

        result.Value.Should().Be("not-a-number");
        result.Error.Should().Be(EvaluationError.TypeMismatch);
    }

    // -----------------------------------------------------------------
    // Spec 070 FR-002 — typed MALFORMED_VALUE: a setting with `t:1/2/3`
    // whose corresponding `V.S` / `V.I` / `V.D` slot is null fails with
    // MalformedValue (mirrors the existing boolean `V.B` empty-slot
    // assertion).
    // -----------------------------------------------------------------

    [Fact]
    public void Evaluate_returns_default_when_string_setting_value_slot_empty()
    {
        var settings = Settings(("k", 1, new SettingValue { S = null }));

        var result = Evaluator.Evaluate<string>(settings, "k", "fallback", user: null);

        result.Value.Should().Be("fallback");
        result.Error.Should().Be(EvaluationError.MalformedValue);
    }

    [Fact]
    public void Evaluate_returns_default_when_int_setting_value_slot_empty()
    {
        var settings = Settings(("k", 2, new SettingValue { I = null }));

        var result = Evaluator.Evaluate<int>(settings, "k", -1, user: null);

        result.Value.Should().Be(-1);
        result.Error.Should().Be(EvaluationError.MalformedValue);
    }

    [Fact]
    public void Evaluate_returns_default_when_double_setting_value_slot_empty()
    {
        var settings = Settings(("k", 3, new SettingValue { D = null }));

        var result = Evaluator.Evaluate<double>(settings, "k", 0.0, user: null);

        result.Value.Should().Be(0.0);
        result.Error.Should().Be(EvaluationError.MalformedValue);
    }
}
