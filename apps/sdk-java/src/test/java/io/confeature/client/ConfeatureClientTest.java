// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class ConfeatureClientTest {

  private static final String VALID_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  @Test
  void builder_rejectsEmptySdkKey() {
    assertThatThrownBy(() -> ConfeatureClient.builder("").build())
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void builder_rejectsNullSdkKey() {
    assertThatThrownBy(() -> ConfeatureClient.builder(null).build())
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void close_isIdempotent() {
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .build();
    client.close();
    client.close(); // second close MUST not throw.
    // Calling getValue after close returns the supplied default.
    assertThat(client.getValue("anything", true, null)).isEqualTo(true);
  }

  @Test
  void getValue_withLocalOverridesReturnsOverride() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .build();
    try {
      assertThat(client.getValue("flag", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void getValue_missingKeyReturnsDefault() {
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(new HashMap<>())))
            .build();
    try {
      assertThat(client.getValue("never.set", true, null)).isEqualTo(true);
      assertThat(client.getValue("never.set", false, null)).isEqualTo(false);
    } finally {
      client.close();
    }
  }

  @Test
  void forceRefresh_localOnlyIsNoOpSuccess() {
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(new HashMap<>())))
            .build();
    try {
      assertThat(client.forceRefresh()).isTrue();
    } finally {
      client.close();
    }
  }

  @Test
  void snapshot_withLocalOverridesReturnsOverride() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .build();
    try {
      final Snapshot snap = client.snapshot();
      assertThat(snap.getValue("flag", false, null)).isEqualTo(true);
    } finally {
      client.close();
    }
  }

  @Test
  void getValue_typedOverloadCoercesPrimitive() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
            .build();
    try {
      final Boolean result = client.getValue("flag", Boolean.FALSE, null, Boolean.class);
      assertThat(result).isTrue();
    } finally {
      client.close();
    }
  }
}
