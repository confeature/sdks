// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using RichardSzalay.MockHttp;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// #826 — ConfigCat reserves no setting key, so the api serves
/// <c>__proto__</c> as an ordinary key of config_v6 <c>f</c>. A JS SDK once
/// dropped it by copying settings into a plain object; these tests hold the
/// .NET SDK to keeping it from the served bytes and from a local override.
/// </summary>
public class ProtoKeyTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private const string Served =
        "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"},"
        + "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}";

    [Fact]
    public async Task A_served_proto_flag_returns_its_served_value()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond("application/json", Served);
        using var http = new HttpClient(mockHttp);
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = "https://cdn.test.confeature.io";
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        (await client.ForceRefreshAsync(CancellationToken.None)).IsSuccess.Should().BeTrue();

        client.GetValue("__proto__", defaultValue: false).Should().BeTrue();
    }

    [Fact]
    public void A_local_only_override_keyed_proto_returns_the_override()
    {
        var overrides = new Dictionary<string, object> { ["__proto__"] = true };
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overrides),
                OverrideBehaviour.LocalOnly);
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("__proto__", defaultValue: false).Should().BeTrue();
    }
}
