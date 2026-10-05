// SPDX-License-Identifier: MIT

#if NETSTANDARD2_0 || NETSTANDARD2_1
namespace System.Runtime.CompilerServices;

/// <summary>
/// Polyfill for the C# 9 <c>init</c> accessor on TFMs that predate it.
/// </summary>
/// <remarks>
/// The C# compiler emits a reference to
/// <c>System.Runtime.CompilerServices.IsExternalInit</c> whenever an
/// <c>init</c>-only setter is declared. The type ships in the BCL from
/// .NET 5 / netstandard 2.1+ onwards but is absent on netstandard 2.0.
/// Providing an internal definition here lets the SDK keep
/// <c>init</c>-only properties everywhere without forcing a separate
/// netstandard2.0 source path.
/// </remarks>
internal static class IsExternalInit
{
}
#endif
