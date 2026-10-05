// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// Semver-aligned package version. Stamped into the User-Agent header
/// (<c>confeature-dotnet-sdk/{Version}</c>) sent by the config fetcher.
/// </summary>
/// <remarks>
/// Mirrors <c>apps/sdk-go/version.go</c> and the equivalent constants
/// in sdk-python / sdk-node. Synchronised manually with the
/// <c>&lt;Version&gt;</c> property in
/// <c>src/Confeature.Client/Confeature.Client.csproj</c>.
/// </remarks>
public static class SdkVersion
{
    /// <summary>The semver string. Synchronised with the csproj <c>&lt;Version&gt;</c>.</summary>
    public const string Value = "0.1.0-alpha";
}
