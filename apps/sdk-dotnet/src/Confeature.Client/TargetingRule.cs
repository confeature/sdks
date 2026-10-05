// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// The targeting rule that decided the evaluated value, if any.
/// </summary>
/// <remarks>
/// Mirrors ConfigCat's <c>ConfigCat.Client.TargetingRule</c> shape as a
/// stable type reference. The evaluation engine sets
/// <see cref="EvaluationDetails{T}.MatchedTargetingRule"/> to an instance
/// of this type when a targeting rule decides the value, and leaves it
/// <c>null</c> otherwise. The internal-only constructor keeps consumers
/// from materialising stand-in instances.
/// </remarks>
public sealed class TargetingRule
{
    internal TargetingRule()
    {
    }
}
