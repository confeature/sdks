// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Spec 103 / #268 — slice 1/14 — sdk-java hooks/events bus.
 *
 * <p>Mirrors the upstream {@code com.configcat.ConfigCatHooks} surface — four hook points
 * (clientReady, configChanged, flagEvaluated, clientError). The reflective conformance check lives
 * in {@link ApiSurfaceConformanceTest}; this file exercises behaviour.
 */
final class HooksTest {

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

  // ── accessor surface ──────────────────────────────────────────────────────

  @Test
  void getHooksReturnsTheSameInstanceAcrossCalls() {
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.getHooks()).isNotNull();
      assertThat(client.getHooks()).isSameAs(client.getHooks());
    } finally {
      client.close();
    }
  }

  // ── clientReady ───────────────────────────────────────────────────────────

  @Test
  void clientReadyFiresOnceAfterFirstSuccessfulFetch() {
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    final AtomicInteger fires = new AtomicInteger(0);
    try {
      client.getHooks().addOnClientReady(fires::incrementAndGet);
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.forceRefresh()).isTrue();
      assertThat(fires.get()).as("clientReady fires exactly once").isEqualTo(1);
    } finally {
      client.close();
    }
  }

  // ── configChanged ─────────────────────────────────────────────────────────

  @Test
  void configChangedFiresOnEverySuccessfulFetchAndCarriesSettings() {
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    final AtomicInteger fires = new AtomicInteger(0);
    final AtomicReference<Map<String, Object>> lastSettings = new AtomicReference<>();
    try {
      client
          .getHooks()
          .addOnConfigChanged(
              settings -> {
                fires.incrementAndGet();
                lastSettings.set(settings);
              });
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.forceRefresh()).isTrue();
      assertThat(fires.get()).as("configChanged fires per successful fetch").isEqualTo(2);
      assertThat(lastSettings.get()).containsKey("feature.dark-mode");
    } finally {
      client.close();
    }
  }

  // ── flagEvaluated ─────────────────────────────────────────────────────────

  @Test
  void flagEvaluatedFiresOnEveryGetValueDetailsCall() {
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    final AtomicInteger fires = new AtomicInteger(0);
    final AtomicReference<String> lastKey = new AtomicReference<>();
    try {
      client.forceRefresh();
      client
          .getHooks()
          .addOnFlagEvaluated(
              details -> {
                fires.incrementAndGet();
                lastKey.set(details.getKey());
              });
      client.getValueDetails("feature.dark-mode", false, null, Boolean.class);
      client.getValueDetails("feature.unknown", false, null, Boolean.class);
      assertThat(fires.get()).as("flagEvaluated fires once per getValueDetails").isEqualTo(2);
      assertThat(lastKey.get()).isEqualTo("feature.unknown");
    } finally {
      client.close();
    }
  }

  // ── clientError ───────────────────────────────────────────────────────────

  @Test
  void clientErrorFiresOnFetchFailure() {
    server.enqueue(new MockResponse().setResponseCode(500));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    final AtomicReference<String> lastMessage = new AtomicReference<>();
    try {
      client.getHooks().addOnError(lastMessage::set);
      assertThat(client.forceRefresh()).isFalse();
      assertThat(lastMessage.get())
          .as("clientError carries a non-empty message on fetch failure")
          .isNotNull()
          .isNotEmpty();
    } finally {
      client.close();
    }
  }

  // ── listener isolation ────────────────────────────────────────────────────

  @Test
  void exceptionThrownByOneListenerDoesNotBreakOthers() {
    server.enqueue(new MockResponse().setResponseCode(200).setBody(CONFIG_BODY));

    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    final AtomicInteger downstreamFires = new AtomicInteger(0);
    try {
      client
          .getHooks()
          .addOnConfigChanged(
              s -> {
                throw new RuntimeException("boom");
              });
      client.getHooks().addOnConfigChanged(s -> downstreamFires.incrementAndGet());
      assertThat(client.forceRefresh()).isTrue();
      assertThat(downstreamFires.get())
          .as("a throwing listener does not prevent later listeners from firing")
          .isEqualTo(1);
    } finally {
      client.close();
    }
  }
}
