// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Unit tests for <see cref="User"/>. Exercises constructor validation,
/// custom-attribute defaults, equality semantics across the relevant
/// permutations, and the hash-code path.
/// </summary>
public class UserTests
{
    [Fact]
    public void Constructor_rejects_null_identifier()
    {
        var act = () => new User(identifier: null!);
        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_accepts_empty_identifier_per_ConfigCat_contract()
    {
        var user = new User(identifier: string.Empty);

        user.Identifier.Should().BeEmpty();
        user.Email.Should().BeNull();
        user.Country.Should().BeNull();
        user.Custom.Should().BeEmpty();
    }

    [Fact]
    public void Custom_defaults_to_empty_dictionary_when_null()
    {
        var user = new User("alice");

        user.Custom.Should().NotBeNull();
        user.Custom.Should().BeEmpty();
    }

    [Fact]
    public void Equals_returns_true_for_same_reference()
    {
        var user = new User("alice");

        user.Equals(user).Should().BeTrue();
    }

    [Fact]
    public void Equals_returns_false_for_null_other()
    {
        var user = new User("alice");

        user.Equals((User?)null).Should().BeFalse();
    }

    [Fact]
    public void Equals_object_overload_returns_false_for_null()
    {
        var user = new User("alice");

        // Cast through object.Equals to drive the User.Equals(object?) override.
        var result = ((object)user).Equals(null!);
        result.Should().BeFalse();
    }

    [Fact]
    public void Equals_object_overload_returns_false_for_non_user_type()
    {
        var user = new User("alice");

        var result = ((object)user).Equals("not-a-user");
        result.Should().BeFalse();
    }

    [Fact]
    public void Equals_inspects_all_fields()
    {
        var a = new User("alice", email: "a@x", country: "FR",
            custom: new Dictionary<string, object> { ["plan"] = "pro" });
        var b = new User("alice", email: "a@x", country: "FR",
            custom: new Dictionary<string, object> { ["plan"] = "pro" });

        a.Equals(b).Should().BeTrue();
        a.GetHashCode().Should().Be(b.GetHashCode());
    }

    [Fact]
    public void Equals_returns_false_when_identifier_differs()
    {
        var a = new User("alice");
        var b = new User("bob");

        a.Equals(b).Should().BeFalse();
    }

    [Fact]
    public void Equals_returns_false_when_email_differs()
    {
        var a = new User("alice", email: "a@x");
        var b = new User("alice", email: "different@x");

        a.Equals(b).Should().BeFalse();
    }

    [Fact]
    public void Equals_returns_false_when_country_differs()
    {
        var a = new User("alice", country: "FR");
        var b = new User("alice", country: "US");

        a.Equals(b).Should().BeFalse();
    }

    [Fact]
    public void Equals_returns_false_when_custom_count_differs()
    {
        var a = new User("alice", custom: new Dictionary<string, object> { ["k"] = "v" });
        var b = new User("alice", custom: new Dictionary<string, object>());

        a.Equals(b).Should().BeFalse();
    }

    [Fact]
    public void Equals_returns_false_when_custom_value_differs()
    {
        var a = new User("alice", custom: new Dictionary<string, object> { ["k"] = "v1" });
        var b = new User("alice", custom: new Dictionary<string, object> { ["k"] = "v2" });

        a.Equals(b).Should().BeFalse();
    }

    [Fact]
    public void Equals_returns_false_when_custom_key_differs()
    {
        var a = new User("alice", custom: new Dictionary<string, object> { ["k1"] = "v" });
        var b = new User("alice", custom: new Dictionary<string, object> { ["k2"] = "v" });

        a.Equals(b).Should().BeFalse();
    }
}
