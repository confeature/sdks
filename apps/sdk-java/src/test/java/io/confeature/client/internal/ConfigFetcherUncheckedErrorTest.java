// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import io.confeature.client.Logger;
import java.io.IOException;
import java.time.Duration;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import okhttp3.Interceptor;
import org.junit.jupiter.api.Test;

/**
 * Reaches {@link ConfigFetcher#fetch(String)}'s last-resort {@code RuntimeException} catch through
 * the package-private interceptor seam: the transport raises an unchecked exception whose message
 * quotes the request URL — key included — and the fetch must end as the fixed {@code
 * network_error}, logging the exception's simple class name and never its message — in
 * sdk-android's line shape, {@code reason=network_error exception=<SimpleName>}.
 */
final class ConfigFetcherUncheckedErrorTest {

  private static final String PART_A = "FAKEfixtureKeyNotRea01";
  private static final String PART_B = "FAKEfixtureKeyNotRea02";
  private static final String KEY = "configcat-sdk-1/" + PART_A + "/" + PART_B;

  /**
   * Records every line plus the whole throwable graph — each throwable's {@code toString()}, its
   * suppressed exceptions and its cause chain — as a real logger (SLF4J/Logback) prints it.
   * Cycle-safe: a cause or suppressed cycle is walked once.
   */
  private static final class RecordingLogger implements Logger {
    final List<String> lines = new CopyOnWriteArrayList<>();

    @Override
    public void error(String message, Throwable throwable) {
      final StringBuilder entry = new StringBuilder("ERROR ").append(message);
      appendThrowable(entry, throwable, Collections.newSetFromMap(new IdentityHashMap<>()));
      lines.add(entry.toString());
    }

    private static void appendThrowable(StringBuilder entry, Throwable t, Set<Throwable> seen) {
      while (t != null && seen.add(t)) {
        entry.append(" | ").append(t);
        for (Throwable suppressed : t.getSuppressed()) {
          appendThrowable(entry, suppressed, seen);
        }
        t = t.getCause();
      }
    }

    @Override
    public void warning(String message) {
      lines.add("WARN " + message);
    }

    @Override
    public void info(String message) {
      lines.add("INFO " + message);
    }

    @Override
    public void debug(String message) {
      lines.add("DEBUG " + message);
    }
  }

  private static ConfigFetcher.FetchResult fetchThrough(
      Interceptor interceptor, RecordingLogger logger) {
    try (ConfigFetcher fetcher =
        new ConfigFetcher("http://127.0.0.1:9", KEY, Duration.ofSeconds(2), logger, interceptor)) {
      return assertDoesNotThrow(() -> fetcher.fetch(""));
    }
  }

  private static void assertKeyFree(ConfigFetcher.FetchResult result, RecordingLogger logger) {
    for (String secret : new String[] {KEY, PART_A, PART_B, "boom"}) {
      assertThat(result.getError()).doesNotContain(secret);
      assertThat(logger.lines).noneMatch(line -> line.contains(secret));
    }
  }

  @Test
  void recordingLogger_recordsSuppressedAndCausesAndSurvivesCycles() {
    // The key-free checks below are only as good as this double: a key hidden in a suppressed
    // exception, or in a cause of one, must reach the recorded line — and a cause or suppressed
    // cycle must not hang the walk.
    final IOException outer = new IOException("outer");
    final IllegalStateException hidden = new IllegalStateException("suppressed " + PART_A);
    final IllegalArgumentException deep = new IllegalArgumentException("cause " + PART_B);
    hidden.initCause(deep);
    outer.addSuppressed(hidden);
    deep.addSuppressed(outer); // suppressed cycle: outer -> hidden -> deep -> outer
    final RuntimeException a = new RuntimeException("a");
    final RuntimeException b = new RuntimeException("b", a);
    a.initCause(b); // cause cycle: a -> b -> a
    outer.initCause(a);
    final RecordingLogger logger = new RecordingLogger();
    assertTimeoutPreemptively(Duration.ofSeconds(2), () -> logger.error("failed", outer));
    assertThat(logger.lines)
        .singleElement()
        .asString()
        .contains("java.io.IOException: outer", PART_A, PART_B, "RuntimeException: a")
        .contains("RuntimeException: b");
  }

  @Test
  void fetch_uncheckedErrorHidingTheKeyInASuppressedException_isKeyFree() {
    // The thrown exception's own message is clean; the URL sits only in a suppressed exception —
    // so a fetcher that logged the exception is caught only by a double walking suppressed ones.
    final RecordingLogger logger = new RecordingLogger();
    final ConfigFetcher.FetchResult result =
        fetchThrough(
            chain -> {
              final IllegalStateException clean = new IllegalStateException("transport failed");
              clean.addSuppressed(new IllegalArgumentException("boom " + chain.request().url()));
              throw clean;
            },
            logger);
    assertThat(result.getError()).isEqualTo("network_error");
    // Key-freeness alone decides this case (the line count is the other tests' concern): it fails
    // only if the logged throwable graph — its suppressed exceptions included — carries the key.
    assertKeyFree(result, logger);
    assertThat(logger.lines)
        .anyMatch(line -> line.endsWith(" reason=network_error exception=IllegalStateException"));
  }

  @Test
  void fetch_uncheckedTransportError_endsAsNetworkErrorNamingOnlyTheType() {
    final RecordingLogger logger = new RecordingLogger();
    final ConfigFetcher.FetchResult result =
        fetchThrough(
            chain -> {
              throw new IllegalStateException("boom " + chain.request().url());
            },
            logger);
    assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
    assertThat(result.getError()).isEqualTo("network_error");
    assertThat(logger.lines)
        .singleElement()
        .asString()
        .startsWith("ERROR ConfigFetcher: fetch raised. sdkKey=")
        .endsWith(" reason=network_error exception=IllegalStateException");
    assertKeyFree(result, logger);
  }

  @Test
  void fetch_uncheckedErrorOfAnAnonymousClass_isNamedRuntimeException() {
    // An anonymous class has no simple name; sdk-android logs "RuntimeException", and so does
    // sdk-java, so the two JVM SDKs emit the same line.
    final RecordingLogger logger = new RecordingLogger();
    final ConfigFetcher.FetchResult result =
        fetchThrough(
            chain -> {
              throw new RuntimeException("boom " + chain.request().url()) {
                private static final long serialVersionUID = 1L;
              };
            },
            logger);
    assertThat(result.getError()).isEqualTo("network_error");
    assertThat(logger.lines)
        .singleElement()
        .asString()
        .endsWith(" reason=network_error exception=RuntimeException");
    assertKeyFree(result, logger);
  }
}
