// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Subscribe to client lifecycle events. Mirrors {@code com.configcat.ConfigCatHooks} 1:1 at the
 * public API surface (constitution Principle II, epic #268).
 *
 * <p>Four hook points map to the JS-family reference contract (clientReady, configChanged,
 * flagEvaluated, clientError). All {@code addOn*} methods are thread-safe; listeners fire on the
 * thread that produced the event (AutoPoll scheduler thread, evaluation caller thread, etc.).
 * Exceptions thrown by listeners are caught and logged — never escape to the emitter.
 *
 * <p>Obtain via {@link ConfeatureClient#getHooks()}.
 */
public final class ConfeatureHooks {

  private final Logger logger;
  private final List<Runnable> onClientReady = new CopyOnWriteArrayList<>();
  private final List<Consumer<Map<String, Object>>> onConfigChanged = new CopyOnWriteArrayList<>();
  private final List<Consumer<String>> onError = new CopyOnWriteArrayList<>();
  private final List<Consumer<EvaluationDetails<?>>> onFlagEvaluated = new CopyOnWriteArrayList<>();

  ConfeatureHooks(Logger logger) {
    this.logger = logger;
  }

  /** Subscribe to the first successful config load (cache hydration or HTTP fetch). */
  public void addOnClientReady(Runnable listener) {
    onClientReady.add(listener);
  }

  /** Subscribe to every new config (FETCHED status). Receives the settings map. */
  public void addOnConfigChanged(Consumer<Map<String, Object>> listener) {
    onConfigChanged.add(listener);
  }

  /** Subscribe to every {@link EvaluationDetails} produced by {@code getValueDetails}. */
  public void addOnFlagEvaluated(Consumer<EvaluationDetails<?>> listener) {
    onFlagEvaluated.add(listener);
  }

  /** Subscribe to non-fatal SDK errors (HTTP failures, cache I/O, parse failures). */
  public void addOnError(Consumer<String> listener) {
    onError.add(listener);
  }

  void invokeOnClientReady() {
    for (Runnable listener : onClientReady) {
      try {
        listener.run();
      } catch (RuntimeException ex) {
        logger.error("ConfeatureHooks: onClientReady listener raised.", ex);
      }
    }
  }

  void invokeOnConfigChanged(Map<String, Object> settings) {
    for (Consumer<Map<String, Object>> listener : onConfigChanged) {
      try {
        listener.accept(settings);
      } catch (RuntimeException ex) {
        logger.error("ConfeatureHooks: onConfigChanged listener raised.", ex);
      }
    }
  }

  void invokeOnFlagEvaluated(EvaluationDetails<?> details) {
    for (Consumer<EvaluationDetails<?>> listener : onFlagEvaluated) {
      try {
        listener.accept(details);
      } catch (RuntimeException ex) {
        logger.error("ConfeatureHooks: onFlagEvaluated listener raised.", ex);
      }
    }
  }

  void invokeOnError(String message) {
    for (Consumer<String> listener : onError) {
      try {
        listener.accept(message);
      } catch (RuntimeException ex) {
        logger.error("ConfeatureHooks: onError listener raised.", ex);
      }
    }
  }
}
