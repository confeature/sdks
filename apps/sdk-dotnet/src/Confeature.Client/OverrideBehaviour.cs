// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// Controls how a <see cref="FlagOverrides"/> instance interacts with the
/// remote configuration.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors <c>ConfigCat.Client.OverrideBehaviour</c> 1:1 per constitution
/// Principle II. Only <see cref="LocalOnly"/> is wired in v1; the other
/// two variants are accepted at construction but log a WARNING on each
/// evaluation and fall back to <c>defaultValue</c>. Deferral matches
/// the Python (spec 037) and Go (spec 038) implementations.
/// </para>
/// </remarks>
public enum OverrideBehaviour
{
    /// <summary>
    /// Only overrides are consulted; the remote config is ignored entirely.
    /// This is the only mode wired in v1.
    /// </summary>
    LocalOnly = 0,

    /// <summary>
    /// Overrides shadow the remote config, falling back when a key is
    /// absent from the override map. Deferred in v1.
    /// </summary>
    LocalOverRemote = 1,

    /// <summary>
    /// Remote config wins; overrides are consulted only when the remote
    /// config lacks the key. Deferred in v1.
    /// </summary>
    RemoteOverLocal = 2,
}
