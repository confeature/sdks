// SPDX-License-Identifier: MIT

using System;
using System.Net.Http;

namespace Confeature.Client;

/// <summary>
/// Customer-facing configuration bag consumed by
/// <see cref="ConfeatureClient"/>'s constructor. Idiomatic .NET options
/// pattern: a mutable object the customer populates via an
/// <see cref="Action{T}"/> configure callback.
/// </summary>
/// <remarks>
/// <para>
/// Defaults match the ConfigCat SDK verbatim (constitution Principle II):
/// </para>
/// <list type="bullet">
///   <item><description><see cref="BaseUrl"/> = <see cref="DefaultBaseUrl"/> (<c>https://cdn-global.confeature.io</c>).</description></item>
///   <item><description><see cref="HttpTimeout"/> = 30 seconds.</description></item>
///   <item><description><see cref="LogLevel"/> = <see cref="LogLevel.Warning"/>.</description></item>
///   <item><description><see cref="PollingMode"/> = AutoPoll (60s poll, 5s init wait) when left <c>null</c>.</description></item>
/// </list>
/// </remarks>
public sealed class ConfeatureClientOptions
{
    /// <summary>Default CDN base URL. Customers override for self-hosted Confeature.</summary>
    public const string DefaultBaseUrl = "https://cdn-global.confeature.io";

    /// <summary>Default per-request HTTP timeout.</summary>
    public static readonly TimeSpan DefaultHttpTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Optional customer-supplied <see cref="HttpClient"/>. When set, the
    /// customer owns lifecycle and the SDK MUST NOT dispose it.
    /// </summary>
    public HttpClient? HttpClient { get; set; }

    /// <summary>Per-request HTTP timeout. Must be positive.</summary>
    public TimeSpan HttpTimeout { get; set; } = DefaultHttpTimeout;

    /// <summary>
    /// Filesystem path to the cache directory. Defaults to
    /// <c>{LocalApplicationData}/Confeature</c>. The literal <c>":memory:"</c>
    /// forces memory-only mode (no filesystem writes ever attempted).
    /// </summary>
    public string? CacheDirectory { get; set; }

    /// <summary>Optional custom logger. Defaults to a <see cref="System.Diagnostics.Trace"/>-backed sink.</summary>
    public IConfeatureLogger? Logger { get; set; }

    /// <summary>Severity threshold applied to the configured logger.</summary>
    public LogLevel LogLevel { get; set; } = LogLevel.Warning;

    /// <summary>Polling strategy. Defaults to <see cref="Client.PollingMode.AutoPoll(TimeSpan?, TimeSpan?)"/> when <c>null</c>.</summary>
    public PollingMode? PollingMode { get; set; }

    /// <summary>Optional flag overrides. Only <see cref="OverrideBehaviour.LocalOnly"/> is wired in v1.</summary>
    public FlagOverrides? FlagOverrides { get; set; }

    /// <summary>Optional custom cache. Defaults to a filesystem cache rooted at <see cref="CacheDirectory"/>.</summary>
    public IConfigCache? Cache { get; set; }

    /// <summary>CDN base URL. Defaults to <see cref="DefaultBaseUrl"/>.</summary>
    public string? BaseUrl { get; set; }

    /// <summary>Optional default <see cref="User"/> consulted when <c>GetValue</c>'s user argument is <c>null</c>.</summary>
    public User? DefaultUser { get; set; }

    /// <summary>
    /// Validates the populated options. Throws on first invariant
    /// violation. Called by <see cref="ConfeatureClient"/>'s constructor
    /// after the customer's configure callback has run.
    /// </summary>
    internal void Validate()
    {
        if (HttpTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(HttpTimeout),
                HttpTimeout,
                "HttpTimeout must be positive.");
        }

        if (FlagOverrides is not null && FlagOverrides.DataSource is null)
        {
            throw new ArgumentException(
                "FlagOverrides.DataSource must be non-null.",
                nameof(FlagOverrides));
        }
    }
}
