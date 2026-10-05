// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Test double — captures everything a real logger would print, for assertion. Thread-safe.
 *
 * <p>{@link Logger.Slf4jLogger} prints a throwable passed to {@link #error(String, Throwable)} with
 * its whole cause chain (and suppressed exceptions), so this double records them too: each error
 * entry carries the message followed by every throwable's {@code toString()} (class + message) and
 * {@code getMessage()}. A key-free check over {@link #allMessages()} therefore also covers a
 * library exception whose message quotes the request URL (#803 FR-002).
 */
final class TestLogger implements Logger {

  private final List<String> messages = new CopyOnWriteArrayList<>();

  @Override
  public void error(String message, Throwable throwable) {
    final StringBuilder entry = new StringBuilder("ERROR ").append(message);
    appendThrowable(entry, throwable, Collections.newSetFromMap(new IdentityHashMap<>()));
    messages.add(entry.toString());
  }

  /** Appends {@code t}, its suppressed exceptions and its cause chain; cycle-safe. */
  private static void appendThrowable(StringBuilder entry, Throwable t, Set<Throwable> seen) {
    while (t != null && seen.add(t)) {
      entry.append(" | ").append(t).append(" | message=").append(t.getMessage());
      for (Throwable suppressed : t.getSuppressed()) {
        appendThrowable(entry, suppressed, seen);
      }
      t = t.getCause();
    }
  }

  @Override
  public void warning(String message) {
    messages.add("WARN " + message);
  }

  @Override
  public void info(String message) {
    messages.add("INFO " + message);
  }

  @Override
  public void debug(String message) {
    messages.add("DEBUG " + message);
  }

  /** Every entry, error entries including their throwable chain. */
  List<String> allMessages() {
    return Collections.unmodifiableList(messages);
  }
}
