// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client;

/// <summary>
/// One slot of a <c>config_v6.json</c> setting value record.
/// </summary>
/// <remarks>
/// Exactly one of <see cref="B"/> / <see cref="S"/> / <see cref="I"/> /
/// <see cref="D"/> is non-null for a valid setting. The override evaluator
/// picks the first non-null field in B → S → I → D order, mirroring the
/// canonical TS <c>raw.b ?? raw.s ?? raw.i ?? raw.d</c> coalescing chain.
/// </remarks>
public sealed class SettingValue
{
    /// <summary>Boolean value slot.</summary>
    public bool? B { get; init; }

    /// <summary>String value slot.</summary>
    public string? S { get; init; }

    /// <summary>Int value slot.</summary>
    public int? I { get; init; }

    /// <summary>Double value slot.</summary>
    public double? D { get; init; }

    /// <summary>Convenience factory for a boolean setting value.</summary>
    public static SettingValue Of(bool value) => new() { B = value };

    /// <summary>Convenience factory for a string setting value.</summary>
    /// <exception cref="ArgumentNullException">When <paramref name="value"/> is <c>null</c>.</exception>
    public static SettingValue Of(string value)
    {
        if (value is null)
        {
            throw new ArgumentNullException(nameof(value));
        }

        return new SettingValue { S = value };
    }

    /// <summary>Convenience factory for an int setting value.</summary>
    public static SettingValue Of(int value) => new() { I = value };

    /// <summary>Convenience factory for a double setting value.</summary>
    public static SettingValue Of(double value) => new() { D = value };

    /// <summary>
    /// Returns the boxed underlying value (one of <see cref="bool"/>,
    /// <see cref="string"/>, <see cref="int"/>, <see cref="double"/>, or
    /// <c>null</c> when every slot is null).
    /// </summary>
    /// <remarks>
    /// The slot order matches the canonical TS chain
    /// <c>raw.b ?? raw.s ?? raw.i ?? raw.d</c> exactly.
    /// </remarks>
    internal object? GetRawValue()
    {
        if (B.HasValue)
        {
            return B.Value;
        }

        if (S is not null)
        {
            return S;
        }

        if (I.HasValue)
        {
            return I.Value;
        }

        if (D.HasValue)
        {
            return D.Value;
        }

        return null;
    }
}
