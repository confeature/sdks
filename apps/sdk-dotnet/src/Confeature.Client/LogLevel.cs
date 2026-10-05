// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// Severity threshold applied to log calls.
/// </summary>
/// <remarks>
/// Mirrors <c>ConfigCat.Client.LogLevel</c> 1:1 per constitution
/// Principle II. The default for <c>ConfeatureClientOptions.LogLevel</c>
/// is <see cref="Warning"/>.
/// </remarks>
public enum LogLevel
{
    /// <summary>No log output at any severity.</summary>
    Off = 0,

    /// <summary>Errors only.</summary>
    Error = 1,

    /// <summary>Errors + warnings. Default.</summary>
    Warning = 2,

    /// <summary>Errors + warnings + informational messages.</summary>
    Info = 3,

    /// <summary>Every log call, including diagnostic detail.</summary>
    Debug = 4,
}
