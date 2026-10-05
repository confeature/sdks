// SPDX-License-Identifier: MIT
package io.confeature.client;

import org.slf4j.LoggerFactory;

/**
 * Minimal logging surface. Customers can swap in their own implementation via {@code
 * ConfeatureClient.Builder#logger(Logger)} — the default implementation delegates to SLF4J ({@link
 * #defaultLogger()}).
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.ConfeatureLogger}-style surface; names match {@code
 * error / warning / info / debug} exactly so a customer porting from ConfigCat can drop their
 * existing logger in unchanged.
 */
public interface Logger {

  /** Logs an error. {@code throwable} may be {@code null}. */
  void error(String message, Throwable throwable);

  /** Logs a warning. */
  void warning(String message);

  /** Logs an informational message. */
  void info(String message);

  /** Logs a debug message. */
  void debug(String message);

  /**
   * Returns the SDK's default SLF4J-backed logger. Levels are honoured per the SLF4J binding's
   * runtime configuration; the public {@link LogLevel} enum filter is applied at the call site by
   * the SDK internals.
   */
  static Logger defaultLogger() {
    final org.slf4j.Logger slf4j = LoggerFactory.getLogger("io.confeature.client");
    return new Slf4jLogger(slf4j);
  }

  /** SLF4J-backed default. Package-visible so tests can subclass / inspect. */
  final class Slf4jLogger implements Logger {

    private final org.slf4j.Logger slf4j;

    Slf4jLogger(org.slf4j.Logger slf4j) {
      this.slf4j = slf4j;
    }

    @Override
    public void error(String message, Throwable throwable) {
      if (throwable == null) {
        slf4j.error(message);
      } else {
        slf4j.error(message, throwable);
      }
    }

    @Override
    public void warning(String message) {
      slf4j.warn(message);
    }

    @Override
    public void info(String message) {
      slf4j.info(message);
    }

    @Override
    public void debug(String message) {
      slf4j.debug(message);
    }
  }
}
