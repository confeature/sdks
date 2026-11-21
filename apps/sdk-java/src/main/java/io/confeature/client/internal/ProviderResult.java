// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.EvaluationDetails;

/** Immutable details and typed status for the optional provider companion ({@code @internal}). */
public final class ProviderResult {

  /** Resolution status carried separately from the SDK's legacy error codes. */
  public enum Status {
    RESOLVED,
    NOT_READY,
    NOT_FOUND,
    TYPE_MISMATCH,
    PARSE_ERROR,
    GENERAL
  }

  private final EvaluationDetails<Object> details;
  private final Status status;

  /** Associates native evaluation details with their typed provider status. */
  public ProviderResult(EvaluationDetails<Object> details, Status status) {
    this.details = details;
    this.status = status;
  }

  /** Native evaluation details with the user omitted. */
  public EvaluationDetails<Object> getDetails() {
    return details;
  }

  /** Status for a companion to translate independently of the legacy error code. */
  public Status getStatus() {
    return status;
  }
}
