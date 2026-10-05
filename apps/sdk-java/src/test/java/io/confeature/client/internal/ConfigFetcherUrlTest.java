// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.Logger;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * #803 — the config URL carries the SDK key (ConfigCat's wire protocol), so it is built in the
 * package-private {@code ConfigFetcher#getUrl()} and NO public member of {@link ConfigFetcher} or
 * {@link ConfigFetcher.FetchResult} may hand it — or the key — out.
 */
final class ConfigFetcherUrlTest {

  private static final String PART_A = "FAKEfixtureKeyNotRea01";
  private static final String PART_B = "FAKEfixtureKeyNotRea02";
  private static final String KEY = "configcat-sdk-1/" + PART_A + "/" + PART_B;

  private static final Logger SILENT =
      new Logger() {
        @Override
        public void error(String message, Throwable throwable) {}

        @Override
        public void warning(String message) {}

        @Override
        public void info(String message) {}

        @Override
        public void debug(String message) {}
      };

  @ParameterizedTest
  @ValueSource(classes = {ConfigFetcher.class, ConfigFetcher.FetchResult.class})
  void noPublicMemberExposesTheKeyedUrl(Class<?> type) throws Exception {
    // A fetcher over a reachable-nowhere base: every public no-arg getter is called on it, and on
    // a result it produced, and none may return the URL or any part of the key.
    final Object target;
    try (ConfigFetcher fetcher =
        new ConfigFetcher("http://127.0.0.1:9", KEY, Duration.ofMillis(200), SILENT)) {
      assertThat(fetcher.getUrl()).as("precondition: the URL carries the key").contains(PART_A);
      target = type == ConfigFetcher.class ? fetcher : fetcher.fetch("");
      final List<String> leaks = new ArrayList<>();
      for (Method m : type.getMethods()) {
        if (Modifier.isStatic(m.getModifiers())
            || m.getParameterCount() != 0
            || m.getReturnType() == void.class) {
          continue;
        }
        final String returned = String.valueOf(m.invoke(target));
        if (leaks(returned)) {
          leaks.add(m.getName() + "() = " + returned);
        }
      }
      for (Field f : type.getFields()) {
        if (!Modifier.isStatic(f.getModifiers()) && leaks(String.valueOf(f.get(target)))) {
          leaks.add("field " + f.getName());
        }
      }
      assertThat(leaks).as("public members of %s exposing the keyed URL", type.getName()).isEmpty();
    }
  }

  @Test
  void getUrlIsNotPublic() throws Exception {
    assertThat(Modifier.isPublic(ConfigFetcher.class.getDeclaredMethod("getUrl").getModifiers()))
        .as("getUrl() MUST NOT be public")
        .isFalse();
  }

  private static boolean leaks(String value) {
    return value.contains(PART_A)
        || value.contains(PART_B)
        || value.contains("configuration-files");
  }

  @ParameterizedTest
  @ValueSource(strings = {"", ".", ".."})
  void keyThatCannotBeASegment_hasNoUrlAndRequestsNothing(String key) {
    try (ConfigFetcher fetcher =
        new ConfigFetcher("http://127.0.0.1:9", key, Duration.ofSeconds(1), SILENT)) {
      assertThat(fetcher.getUrl()).isNull();
    }
    assertThat(ConfigFetcherProbe.requestedUrl("http://127.0.0.1:9", key, SILENT)).isNull();
  }
}
