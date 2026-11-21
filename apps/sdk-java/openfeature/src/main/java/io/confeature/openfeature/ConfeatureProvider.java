// SPDX-License-Identifier: MIT
package io.confeature.openfeature;

import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.FeatureProvider;
import dev.openfeature.sdk.Metadata;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.Reason;
import dev.openfeature.sdk.Value;
import dev.openfeature.sdk.exceptions.ProviderNotReadyError;
import io.confeature.client.ConfeatureClient;
import io.confeature.client.EvaluationDetails;
import io.confeature.client.User;
import io.confeature.client.internal.ProviderResult;
import java.util.Objects;

/** An OpenFeature provider backed by an application-owned Confeature Java SDK client. */
public final class ConfeatureProvider implements FeatureProvider {
  private static final Metadata METADATA = () -> "Confeature";

  private final ConfeatureClient client;
  private volatile boolean disposed;

  /** Uses the supplied client's configuration, cache and polling mode. */
  public ConfeatureProvider(ConfeatureClient client) {
    this.client = Objects.requireNonNull(client, "client");
  }

  @Override
  public Metadata getMetadata() {
    return METADATA;
  }

  /** Registers a fresh provider without initiating SDK work. */
  @Override
  public void initialize(EvaluationContext context) {
    if (disposed) {
      throw new ProviderNotReadyError("The Confeature provider has been disposed.");
    }
  }

  @Override
  public ProviderEvaluation<Boolean> getBooleanEvaluation(
      String key, Boolean fallback, EvaluationContext context) {
    return resolve(key, fallback, context, Boolean.class);
  }

  @Override
  public ProviderEvaluation<String> getStringEvaluation(
      String key, String fallback, EvaluationContext context) {
    return resolve(key, fallback, context, String.class);
  }

  @Override
  public ProviderEvaluation<Integer> getIntegerEvaluation(
      String key, Integer fallback, EvaluationContext context) {
    return resolve(key, fallback, context, Integer.class);
  }

  @Override
  public ProviderEvaluation<Long> getLongEvaluation(
      String key, Long fallback, EvaluationContext context) {
    return resolve(key, fallback, context, Long.class);
  }

  @Override
  public ProviderEvaluation<Double> getDoubleEvaluation(
      String key, Double fallback, EvaluationContext context) {
    if (fallback != null && !Double.isFinite(fallback)) {
      return failure(fallback, ErrorCode.TYPE_MISMATCH);
    }
    return resolve(key, fallback, context, Double.class);
  }

  @Override
  public ProviderEvaluation<Value> getObjectEvaluation(
      String key, Value fallback, EvaluationContext context) {
    return failure(fallback, ErrorCode.TYPE_MISMATCH);
  }

  /** Disposes this provider and leaves the application-owned client available. */
  @Override
  public void shutdown() {
    disposed = true;
  }

  private <T> ProviderEvaluation<T> resolve(
      String key, T fallback, EvaluationContext context, Class<T> type) {
    if (disposed) {
      return failure(fallback, ErrorCode.PROVIDER_NOT_READY);
    }
    final User user;
    try {
      user = OpenFeatureUser.from(context);
    } catch (RuntimeException invalid) {
      return failure(fallback, ErrorCode.INVALID_CONTEXT);
    }
    final ProviderResult result;
    try {
      result = client.getValueDetailsForProvider(key, fallback, user);
    } catch (RuntimeException unexpected) {
      return failure(fallback, ErrorCode.GENERAL);
    }
    final EvaluationDetails<Object> details = result.getDetails();
    if (details.isDefaultValue() || result.getStatus() != ProviderResult.Status.RESOLVED) {
      return failure(fallback, errorCode(result.getStatus()));
    }
    Object value = details.getValue();
    if (type == Long.class && value instanceof Integer) {
      value = ((Integer) value).longValue();
    }
    if (!type.isInstance(value)) {
      return failure(fallback, ErrorCode.TYPE_MISMATCH);
    }
    if (value instanceof Double && !Double.isFinite((Double) value)) {
      return failure(fallback, ErrorCode.PARSE_ERROR);
    }
    return ProviderEvaluation.<T>builder()
        .value(type.cast(value))
        .variant(details.getVariationId())
        .reason(matchReason(details).name())
        .build();
  }

  private static Reason matchReason(EvaluationDetails<?> details) {
    if (details.getMatchedPercentageOption() != null) {
      return Reason.SPLIT;
    }
    if (details.getMatchedTargetingRule() != null) {
      return Reason.TARGETING_MATCH;
    }
    return Reason.DEFAULT;
  }

  private static ErrorCode errorCode(ProviderResult.Status status) {
    switch (status) {
      case NOT_READY:
        return ErrorCode.PROVIDER_NOT_READY;
      case NOT_FOUND:
        return ErrorCode.FLAG_NOT_FOUND;
      case TYPE_MISMATCH:
        return ErrorCode.TYPE_MISMATCH;
      case PARSE_ERROR:
        return ErrorCode.PARSE_ERROR;
      default:
        return ErrorCode.GENERAL;
    }
  }

  private static <T> ProviderEvaluation<T> failure(T fallback, ErrorCode code) {
    return ProviderEvaluation.<T>builder()
        .value(fallback)
        .reason(Reason.ERROR.name())
        .errorCode(code)
        .errorMessage("Confeature flag evaluation failed.")
        .build();
  }
}
