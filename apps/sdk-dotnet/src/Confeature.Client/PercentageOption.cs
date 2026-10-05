// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// The percentage option that was used to select the evaluated value, if any.
/// </summary>
/// <remarks>
/// Mirrors ConfigCat's <c>ConfigCat.Client.PercentageOption</c> shape as
/// a stable type reference. The evaluation engine sets
/// <see cref="EvaluationDetails{T}.MatchedPercentageOption"/> to an
/// instance of this type when a percentage option decides the value, and
/// leaves it <c>null</c> otherwise. The internal-only constructor keeps
/// consumers from materialising stand-in instances.
/// </remarks>
public sealed class PercentageOption
{
    internal PercentageOption()
    {
    }
}
