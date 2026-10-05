// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Spec 091 / #267 — slice 2/14 — sdk-java online/offline triplet.
 *
 * <p>Mirrors the upstream {@code com.configcat.ConfigCatClient.setOnline / setOffline / isOffline}
 * surface, including the LocalOnly + closed-client edge cases. The reflective conformance check
 * lives in {@link ApiSurfaceConformanceTest}; this file exercises behaviour.
 */
final class OnlineOfflineTest {

  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  private static final String CONFIG_BODY =
      "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},"
          + "\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"vid\",\"r\":[]}},"
          + "\"s\":[]}";

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

  // ── default state ─────────────────────────────────────────────────────────

  @Test
  void freshlyConstructedClientIsOnline() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.isOffline()).isFalse();
    } finally {
      client.close();
    }
  }

  // ── basic state transitions ───────────────────────────────────────────────

  @Test
  void setOfflineFlipsTheFlag() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      client.setOffline();
      assertThat(client.isOffline()).isTrue();
    } finally {
      client.close();
    }
  }

  @Test
  void setOnlineResetsTheFlag() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      client.setOffline();
      assertThat(client.isOffline()).isTrue();
      client.setOnline();
      assertThat(client.isOffline()).isFalse();
    } finally {
      client.close();
    }
  }

  @Test
  void settersAreIdempotent() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      client.setOffline();
      client.setOffline();
      client.setOffline();
      assertThat(client.isOffline()).isTrue();
      client.setOnline();
      client.setOnline();
      client.setOnline();
      assertThat(client.isOffline()).isFalse();
    } finally {
      client.close();
    }
  }

  // ── forceRefresh interaction ──────────────────────────────────────────────

  @Test
  void forceRefreshReturnsFalseWhileOffline() {
    // No response is enqueued — if forceRefresh DID issue HTTP it would fail
    // (no response available). Asserting it returns false without any
    // outbound request is the strongest behavioural guard.
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build();
    try {
      client.setOffline();
      assertThat(client.forceRefresh()).isFalse();
      assertThat(server.getRequestCount()).isZero();
    } finally {
      client.close();
    }
  }

  @Test
  void forceRefreshRoundtripsAfterToggling() {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      client.setOffline();
      assertThat(client.forceRefresh()).isFalse();
      assertThat(server.getRequestCount()).isZero();
      client.setOnline();
      assertThat(client.forceRefresh()).isTrue();
      assertThat(server.getRequestCount()).isEqualTo(1);
    } finally {
      client.close();
    }
  }

  // ── AutoPoll scheduler honours the offline flag ───────────────────────────

  @Test
  void autoPollSchedulerSuppressesFetchWhileOffline() throws Exception {
    // Short interval + tight init wait so the offline-windowed assertion is
    // reachable in a fast unit test. We toggle offline IMMEDIATELY after
    // construction, before the scheduler's first tick (200ms init wait).
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.autoPoll(Duration.ofMillis(100), Duration.ofMillis(200)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build();
    try {
      client.setOffline();
      // Wait through ~5 polling intervals; no HTTP traffic should reach the server.
      Thread.sleep(700);
      assertThat(server.getRequestCount()).as("offline scheduler must not fetch").isZero();
    } finally {
      client.close();
    }
  }

  @Test
  void autoPollSchedulerResumesAfterSetOnline() throws Exception {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.autoPoll(Duration.ofMillis(100), Duration.ofMillis(200)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build();
    try {
      client.setOffline();
      Thread.sleep(400);
      assertThat(server.getRequestCount()).isZero();
      client.setOnline();
      // Allow up to ~5 poll intervals for the next scheduled tick to fire.
      Thread.sleep(600);
      assertThat(server.getRequestCount())
          .as("scheduler must resume after setOnline")
          .isGreaterThanOrEqualTo(1);
    } finally {
      client.close();
    }
  }

  // ── LocalOnly client semantics ────────────────────────────────────────────

  @Test
  void localOnlyClientIsOfflineByDefinition() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("feature.dark-mode", true);
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.isOffline()).isTrue();
    } finally {
      client.close();
    }
  }

  @Test
  void localOnlySetOnlineLogsWarningAndIsNoOp() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("feature.dark-mode", true);
    final TestLogger log = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build();
    try {
      client.setOnline();
      assertThat(client.isOffline()).as("LocalOnly still reports offline=true").isTrue();
      assertThat(log.allMessages())
          .as("setOnline on LocalOnly emits a warning")
          .anyMatch(m -> m.startsWith("WARN") && m.contains("LOCAL_ONLY"));
    } finally {
      client.close();
    }
  }

  @Test
  void localOnlySetOfflineIsSilentNoOp() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("feature.dark-mode", true);
    final TestLogger log = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build();
    try {
      client.setOffline();
      assertThat(client.isOffline()).isTrue();
      assertThat(log.allMessages())
          .as("setOffline on LocalOnly is silent — no WARN")
          .noneMatch(m -> m.startsWith("WARN"));
    } finally {
      client.close();
    }
  }

  // ── Closed-client semantics ───────────────────────────────────────────────

  @Test
  void closedClientReportsOffline() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    client.close();
    assertThat(client.isOffline()).isTrue();
  }

  @Test
  void closedClientSetOnlineLogsWarningAndIsNoOp() {
    final TestLogger log = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build();
    client.close();
    client.setOnline();
    assertThat(log.allMessages())
        .anyMatch(m -> m.startsWith("WARN") && m.contains("setOnline called after close"));
  }

  @Test
  void closedClientSetOfflineLogsWarningAndIsNoOp() {
    final TestLogger log = new TestLogger();
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build();
    client.close();
    client.setOffline();
    assertThat(log.allMessages())
        .anyMatch(m -> m.startsWith("WARN") && m.contains("setOffline called after close"));
  }

  // ── getValue still serves the cached config while offline ─────────────────

  @Test
  void getValueServesCachedConfigWhileOffline() {
    server.enqueue(new MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
      client.setOffline();
      assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }
}
