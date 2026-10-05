// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Targeting context passed to {@code ConfeatureClient#getValue}.
 *
 * <p>Field names mirror ConfigCat's {@code com.configcat.User} 1:1 per constitution Principle II.
 * {@link #getIdentifier()} is the only required field; {@link #getEmail()}, {@link #getCountry()},
 * and {@link #getCustom()} are optional and feed targeting-rule comparisons.
 *
 * <p>Custom attributes are <b>typed</b> ({@code Map<String, Object>}), exactly mirroring
 * ConfigCat's {@code com.configcat.User.Builder.custom(Map<String, Object>)}. Values may be {@link
 * String}, any boxed numeric ({@link Integer} / {@link Long} / {@link Double} / {@code …}), {@link
 * Boolean}, {@link java.util.Date} / {@link java.time.Instant}, {@code String[]} or a {@link
 * java.util.List} of strings. Non-string values are converted at evaluation time using ConfigCat's
 * rules (number → invariant decimal, Date/Instant → Unix epoch seconds, string array → JSON), so a
 * targeting rule comparing against the stringified form behaves identically to ConfigCat. The
 * String-valued path is unchanged.
 *
 * <p>Instances are immutable. Build via {@link #builder(String)}.
 */
public final class User {

  private final String identifier;
  private final String email;
  private final String country;
  private final Map<String, Object> custom;

  private User(String identifier, String email, String country, Map<String, Object> custom) {
    this.identifier = Objects.requireNonNull(identifier, "identifier");
    this.email = email;
    this.country = country;
    this.custom = custom;
  }

  /** Targeting identifier. Never {@code null}; may be the empty string. */
  public String getIdentifier() {
    return identifier;
  }

  /** Optional email for email-based targeting rules. */
  public String getEmail() {
    return email;
  }

  /** Optional country for country-based targeting rules. */
  public String getCountry() {
    return country;
  }

  /**
   * Custom attribute bag. Never {@code null}; empty by default. Values are typed ({@link Object}),
   * mirroring ConfigCat's {@code com.configcat.User} custom map.
   */
  public Map<String, Object> getCustom() {
    return custom;
  }

  /**
   * Returns the value of a well-known ({@code Identifier} / {@code Email} / {@code Country}) or
   * custom attribute, or {@code null} when absent. Mirrors ConfigCat's {@code
   * com.configcat.User.getAttribute(String)}.
   */
  public Object getAttribute(String name) {
    Objects.requireNonNull(name, "name");
    switch (name) {
      case "Identifier":
        return identifier;
      case "Email":
        return email;
      case "Country":
        return country;
      default:
        return custom.get(name);
    }
  }

  /** Returns a new builder seeded with {@code identifier}. */
  public static Builder builder(String identifier) {
    return new Builder(identifier);
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (!(o instanceof User)) {
      return false;
    }
    final User user = (User) o;
    return Objects.equals(identifier, user.identifier)
        && Objects.equals(email, user.email)
        && Objects.equals(country, user.country)
        && Objects.equals(custom, user.custom);
  }

  @Override
  public int hashCode() {
    return Objects.hash(identifier, email, country, custom);
  }

  /** Builder for {@link User}. */
  public static final class Builder {

    private final String identifier;
    private String email;
    private String country;
    private Map<String, Object> custom = Collections.emptyMap();

    private Builder(String identifier) {
      this.identifier = Objects.requireNonNull(identifier, "identifier");
    }

    /** Sets {@link User#getEmail()}. */
    public Builder email(String email) {
      this.email = email;
      return this;
    }

    /** Sets {@link User#getCountry()}. */
    public Builder country(String country) {
      this.country = country;
      return this;
    }

    /**
     * Sets {@link User#getCustom()} (defensively copied). Accepts typed values exactly as
     * ConfigCat's {@code com.configcat.User.Builder.custom(Map<String, Object>)}.
     */
    public Builder custom(Map<String, Object> custom) {
      if (custom == null) {
        this.custom = Collections.emptyMap();
      } else {
        // Preserve insertion order for deterministic logging in tests.
        this.custom = Collections.unmodifiableMap(new LinkedHashMap<>(custom));
      }
      return this;
    }

    /** Builds the immutable {@link User}. */
    public User build() {
      return new User(identifier, email, country, custom);
    }
  }
}
