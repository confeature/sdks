// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * #826 — ConfigCat reserves no setting key, so the api serves {@code __proto__} as an ordinary key
 * of config_v6 {@code f}. A JS SDK once dropped it by copying settings into a plain object; this
 * holds the Java SDK to keeping it from the served bytes and from a local override.
 */
final class ProtoKeyTest {

  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  private static final String SERVED =
      "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"},"
          + "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},"
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

  @Test
  void servedProtoFlagReturnsItsServedValue(@TempDir Path cacheDir) {
    server.enqueue(new MockResponse().setBody(SERVED));
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(cacheDir.toString())
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofSeconds(2))
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
      assertThat(client.getValue("__proto__", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void localOnlyOverrideKeyedProtoReturnsTheOverride() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("__proto__", true);
    final ConfeatureClient client =
        ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build();
    try {
      assertThat(client.getValue("__proto__", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }
}
