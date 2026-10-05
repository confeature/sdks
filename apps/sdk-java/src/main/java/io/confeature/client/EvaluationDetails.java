// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * Typed result envelope returned by {@link ConfeatureClient#getValueDetails(String, Object, User)}
 * and {@link Snapshot#getValueDetails(String, Object, User)}.
 *
 * <p>Mirrors upstream {@code com.configcat.EvaluationDetails} 1:1 field-for-field (spec 080 /
 * #266). Customers migrating from {@code configcat-java-client} keep their accessor call sites
 * unchanged.
 *
 * <p>v1 wires {@link #getVariationId()}, {@link #getMatchedTargetingRule()}, and {@link
 * #getMatchedPercentageOption()} as always-{@code null} placeholders — the v1 evaluator produces no
 * variations / targeting-rule matches. A future spec lands the targeting roll-out.
 *
 * @param <T> the type of the resolved {@link #getValue()}; type-erased helpers use {@code
 *     EvaluationDetails<Object>}.
 */
public final class EvaluationDetails<T> {

  private final String key;
  private final T value;
  private final String variationId;
  private final long fetchTimeUnixMilliseconds;
  private final User user;
  private final boolean isDefaultValue;
  private final String error;
  private final TargetingRule matchedTargetingRule;
  private final PercentageOption matchedPercentageOption;

  /**
   * Constructs an {@link EvaluationDetails}. All nine upstream-aligned fields are positional;
   * helpers in the SDK never use a builder — the constructor is small, immutable, and stable.
   */
  public EvaluationDetails(
      String key,
      T value,
      String variationId,
      long fetchTimeUnixMilliseconds,
      User user,
      boolean isDefaultValue,
      String error,
      TargetingRule matchedTargetingRule,
      PercentageOption matchedPercentageOption) {
    this.key = key;
    this.value = value;
    this.variationId = variationId;
    this.fetchTimeUnixMilliseconds = fetchTimeUnixMilliseconds;
    this.user = user;
    this.isDefaultValue = isDefaultValue;
    this.error = error;
    this.matchedTargetingRule = matchedTargetingRule;
    this.matchedPercentageOption = matchedPercentageOption;
  }

  /** Flag key the consumer asked for; echoed verbatim even on {@code KEY_NOT_FOUND}. */
  public String getKey() {
    return key;
  }

  /**
   * Evaluated value of the flag. On any failure path this is the {@code defaultValue} passed by the
   * caller, and {@link #isDefaultValue()} is then {@code true}.
   */
  public T getValue() {
    return value;
  }

  /**
   * Variation ID from the matched targeting rule / percentage option / setting {@code i} slot.
   * {@code null} when the resolution path produced no variation id (e.g. an error fallback).
   */
  public String getVariationId() {
    return variationId;
  }

  /**
   * Wall-clock epoch-millis at which the active config was last fetched from the CDN (or restored
   * from cache). {@code 0L} until a config has loaded.
   */
  public long getFetchTimeUnixMilliseconds() {
    return fetchTimeUnixMilliseconds;
  }

  /** The {@link User} passed to {@code getValueDetails} (or {@code defaultUser} when none). */
  public User getUser() {
    return user;
  }

  /**
   * {@code true} when the typed accessor returned the supplied {@code defaultValue} for any reason
   * (missing key, type mismatch, closed client, malformed config, malformed value, unsupported
   * type).
   */
  public boolean isDefaultValue() {
    return isDefaultValue;
  }

  /**
   * Stable evaluator error code on every fail branch; {@code null} on the happy path. Codes match
   * the parity corpus' tier-0 set: {@code KEY_NOT_FOUND} / {@code TYPE_MISMATCH} / {@code
   * MALFORMED_VALUE} / {@code UNSUPPORTED_TYPE} / {@code NO_CONFIG} / {@code MALFORMED_CONFIG} /
   * {@code VALUE_NOT_BOOL} / {@code CLIENT_CLOSED}.
   */
  public String getError() {
    return error;
  }

  /** v1 placeholder — always {@code null} until targeting rules land. */
  public TargetingRule getMatchedTargetingRule() {
    return matchedTargetingRule;
  }

  /** v1 placeholder — always {@code null} until percentage options land. */
  public PercentageOption getMatchedPercentageOption() {
    return matchedPercentageOption;
  }
}
