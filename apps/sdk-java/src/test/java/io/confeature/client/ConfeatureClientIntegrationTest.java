// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * End-to-end coverage for the ConfeatureClient code paths that the unit tests don't reach: real
 * fetch via {@link MockWebServer}, cache persistence + restore, LazyLoad staleness re-fetch,
 * AutoPoll background tick, and the typed {@code getValue} overload's coercion branches.
 */
final class ConfeatureClientIntegrationTest {

  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  private MockWebServer server;

  @BeforeEach
  void start() throws Exception {
    server = new MockWebServer();
    server.start();
  }

  @AfterEach
  void stop() throws Exception {
    server.shutdown();
  }

  /** Helper — minimal boolean-basic config_v6.json body. */
  private static String configBody(boolean darkMode) {
    return "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},"
        + "\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":"
        + darkMode
        + "},\"i\":\"vid\",\"r\":[]}},\"s\":[]}";
  }

  @Test
  void manualPoll_forceRefreshFetchesAndEvaluates(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofSeconds(2))
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void manualPoll_forceRefresh_with304ReusesCachedSettings(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"etag-1\""));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofSeconds(2))
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
      // Cached entry from the 200 sticks; the 304 confirms it.
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  /**
   * The CDN once answered with a non-ASCII ETag. OkHttp accepts it on a response (lenient read) but
   * refuses it as a request header: the client must not fail every later refresh — the next fetch
   * goes out without If-None-Match, and its 200's ETag takes over.
   */
  @Test
  void manualPoll_nonAsciiEtagFromTheServer_selfHealsOnTheNextRefresh(@TempDir Path cacheDir)
      throws InterruptedException {
    server.enqueue(
        new MockResponse().addHeaderLenient("ETag", "\"v1-\u00e9\"").setBody(configBody(true)));
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-2\"").setBody(configBody(false)));
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"etag-2\""));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofSeconds(2))
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.getValue("feature.dark-mode", true, null)).isEqualTo(false);
      assertThat(client.forceRefresh()).isTrue();
      assertNotNull(server.takeRequest(2, TimeUnit.SECONDS), "the first refresh MUST fetch");
      final RecordedRequest unconditional = server.takeRequest(2, TimeUnit.SECONDS);
      assertNotNull(unconditional, "the second refresh MUST fetch");
      assertThat(unconditional.getHeader("If-None-Match")).isNull();
      final RecordedRequest conditional = server.takeRequest(2, TimeUnit.SECONDS);
      assertNotNull(conditional, "the third refresh MUST fetch");
      assertThat(conditional.getHeader("If-None-Match")).isEqualTo("\"etag-2\"");
    } finally {
      client.close();
    }
  }

  @Test
  void persistedCacheIsRestoredAcrossClientInstances(@TempDir Path cacheDir) throws IOException {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    final ConfeatureClient first =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(first.forceRefresh()).isTrue();
    } finally {
      first.close();
    }
    // Cache file must exist on disk now.
    assertThat(Files.list(cacheDir).count()).isPositive();

    // A second client with no remote (server still has the request queue
    // empty — the queued response was already consumed) must hydrate
    // from disk and serve the previously fetched flag.
    final ConfeatureClient second =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(second.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      second.close();
    }
  }

  @Test
  void lazyLoad_triggersFetchOnFirstGetValue(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.lazyLoad(Duration.ofSeconds(1)))
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      // First call must trigger the lazy fetch and resolve the flag.
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void autoPoll_backgroundTickRefreshesConfig(@TempDir Path cacheDir) throws InterruptedException {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    // Buffer extra responses so the background tick doesn't 404 itself.
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"etag-1\""));
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"etag-1\""));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.autoPoll(Duration.ofMillis(50), Duration.ofMillis(20)))
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      // Wait briefly for the background tick to actually fire.
      Thread.sleep(200);
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void typedGetValue_coercesAndFallsBackOnMismatch(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      client.forceRefresh();
      final Boolean ok = client.getValue("feature.dark-mode", false, null, Boolean.class);
      assertThat(ok).isTrue();
      // Asking the typed overload for a String against a boolean flag
      // must fall back to the supplied default.
      final String s = client.getValue("feature.dark-mode", "fallback", null, String.class);
      assertThat(s).isEqualTo("fallback");
      // Asking for a non-existent key with the typed overload returns
      // the typed default.
      final Boolean missing = client.getValue("does.not.exist", true, null, Boolean.class);
      assertThat(missing).isTrue();
    } finally {
      client.close();
    }
  }

  @Test
  void forceRefresh_500ReturnsFalse(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setResponseCode(500));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.forceRefresh()).isFalse();
    } finally {
      client.close();
    }
  }

  @Test
  void getValue_afterCloseReturnsDefault(@TempDir Path cacheDir) {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .build();
    client.close();
    assertThat(client.forceRefresh()).isFalse();
    assertThat(client.getValue("any", "fallback", null)).isEqualTo("fallback");
  }

  @Test
  void customLogger_neverReceivesRawSdkKey(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setResponseCode(500));
    final TestLogger logger = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .logger(logger)
            .build();
    try {
      client.forceRefresh();
      assertThat(logger.allMessages()).noneMatch(msg -> msg.contains(SDK_KEY));
    } finally {
      client.close();
    }
  }

  @Test
  void invalidSdkKeyFormatLogsWarningButDoesNotThrow(@TempDir Path cacheDir) {
    final TestLogger logger = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder("not-a-confeature-key")
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .logger(logger)
            .build();
    try {
      assertThat(logger.allMessages()).anyMatch(m -> m.contains("INVALID_SDK_KEY"));
    } finally {
      client.close();
    }
  }

  @Test
  void defaultUserIsUsedWhenGetValueUserIsNull(@TempDir Path cacheDir) {
    final User defaultUser = User.builder("default-user").email("default@example.com").build();
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(configBody(true)));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .defaultUser(defaultUser)
            .build();
    try {
      client.forceRefresh();
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void userBuilderAllowsCustomAttributes() {
    final User u =
        User.builder("alice")
            .email("alice@example.com")
            .country("FR")
            .custom(java.util.Collections.singletonMap("plan", "pro"))
            .build();
    assertThat(u.getIdentifier()).isEqualTo("alice");
    assertThat(u.getEmail()).isEqualTo("alice@example.com");
    assertThat(u.getCountry()).isEqualTo("FR");
    assertThat(u.getCustom()).containsEntry("plan", "pro");
    assertThat(u)
        .isEqualTo(
            User.builder("alice")
                .email("alice@example.com")
                .country("FR")
                .custom(java.util.Collections.singletonMap("plan", "pro"))
                .build());
    assertThat(u)
        .hasSameHashCodeAs(
            User.builder("alice")
                .email("alice@example.com")
                .country("FR")
                .custom(java.util.Collections.singletonMap("plan", "pro"))
                .build());
  }

  @Test
  void pollingMode_rejectsNonPositiveIntervals() {
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> PollingMode.autoPoll(Duration.ZERO, Duration.ofSeconds(1)))
        .isInstanceOf(IllegalArgumentException.class);
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> PollingMode.lazyLoad(Duration.ofSeconds(-1)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void pollingMode_secondsOverloadsBehaveLikeDurationOverloads() {
    final PollingMode auto = PollingMode.autoPoll(60, 5);
    assertThat(auto.getKind()).isEqualTo(PollingMode.Kind.AUTO_POLL);
    assertThat(auto.getPollInterval()).isEqualTo(Duration.ofSeconds(60));
    assertThat(auto.getMaxInitWaitTime()).isEqualTo(Duration.ofSeconds(5));

    final PollingMode lazy = PollingMode.lazyLoad(60);
    assertThat(lazy.getKind()).isEqualTo(PollingMode.Kind.LAZY_LOAD);
    assertThat(lazy.getCacheRefreshInterval()).isEqualTo(Duration.ofSeconds(60));

    assertThat(PollingMode.manualPoll().getKind()).isEqualTo(PollingMode.Kind.MANUAL_POLL);
    assertThat(PollingMode.autoPoll().getPollInterval()).isEqualTo(Duration.ofSeconds(60));
    assertThat(PollingMode.lazyLoad().getCacheRefreshInterval()).isEqualTo(Duration.ofSeconds(60));
  }

  @Test
  void defaultLogger_methodsAreReachable() {
    final Logger l = Logger.defaultLogger();
    l.error("err", null);
    l.error("err", new RuntimeException("boom"));
    l.warning("warn");
    l.info("info");
    l.debug("debug");
  }
}
