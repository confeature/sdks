// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using System.Text.Json;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

public class ProviderEvaluationDetailsTests
{
    [Fact]
    public void Provider_details_keep_typed_results_and_use_only_the_supplied_context()
    {
        using var config = JsonDocument.Parse("""
            {"f":{"rollout":{"t":0,"v":{"b":false},"i":"base","p":[{"p":100,"v":{"b":true},"i":"split"}]}}}
            """);
        var defaultUser = new User("configured");
        var overrides = FlagOverrides.LocalConfig(config.RootElement, OverrideBehaviour.LocalOnly);
        var snapshot = new ConfeatureSnapshot(null, overrides, defaultUser);

        var native = snapshot.GetValueDetails("rollout", false);
        native.User.Should().BeSameAs(defaultUser);
        native.Value.Should().BeTrue();
        snapshot.GetValueDetails("rollout", false, new User(string.Empty)).Value.Should().BeTrue();

        var (details, status) = snapshot.GetProviderValueDetails("rollout", false, new AnonymousAttributes());
        status.Should().Be(EvaluationError.None);
        details.Value.Should().BeFalse();
        details.IsDefaultValue.Should().BeFalse();
        details.VariationId.Should().Be("base");
        details.User.Should().BeNull();
        snapshot.GetProviderValueDetails("rollout", "fallback", null).Error.Should().Be(EvaluationError.TypeMismatch);
        snapshot.GetProviderValueDetails("absent", "fallback", null).Error.Should().Be(EvaluationError.KeyNotFound);
    }

    [Fact]
    public void Provider_details_classify_an_absent_flat_override_and_a_mismatched_value()
    {
        var overrides = new FlagOverrides(
            new MapOverrideDataSource(new Dictionary<string, object> { ["flag"] = true }),
            OverrideBehaviour.LocalOnly);
        var snapshot = new ConfeatureSnapshot(null, overrides, null);

        snapshot.GetProviderValueDetails("flag", true, null).Error.Should().Be(EvaluationError.None);
        snapshot.GetProviderValueDetails("flag", "fallback", null).Error.Should().Be(EvaluationError.TypeMismatch);
        snapshot.GetProviderValueDetails("missing", false, null).Error.Should().Be(EvaluationError.KeyNotFound);
    }

    private sealed class AnonymousAttributes : IEvalUser
    {
        public string Identifier => string.Empty;

        public object? GetAttribute(string name) => name == "Country" ? "FR" : null;

        public IEnumerable<string> CustomKeysInOrder() => [];
    }
}
