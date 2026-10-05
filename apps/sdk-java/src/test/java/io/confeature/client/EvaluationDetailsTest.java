// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Spec 080 / #266 slice 2 — unit tests for {@link ConfeatureClient#getValueDetails(String, Object,
 * User)} and {@link ConfeatureClient#getAllValues(User)}.
 *
 * <p>Mirrors the 8-test set landed for sdk-python (spec 079 / PR #284). Uses {@link
 * OverrideBehaviour#LOCAL_ONLY} with {@link MapOverrideDataSource} so the tests do not require
 * network access or a mocked CDN.
 */
final class EvaluationDetailsTest {

  private static final String VALID_SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  private static ConfeatureClient buildClient(Map<String, Object> overrides) {
    return ConfeatureClient.builder(VALID_SDK_KEY)
        .pollingMode(PollingMode.manualPoll())
        .cacheDirectory(":memory:")
        .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overrides)))
        .build();
  }

  @Test
  void getValueDetails_returnsEnvelopeWithValueFromOverrides() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client = buildClient(overrides);
    try {
      final EvaluationDetails<Object> details = client.getValueDetails("flag", false, null);
      assertThat(details.getKey()).isEqualTo("flag");
      assertThat(details.getValue()).isEqualTo(true);
      assertThat(details.getVariationId()).isNull();
      assertThat(details.isDefaultValue()).isFalse();
      assertThat(details.getError()).isNull();
      assertThat(details.getMatchedTargetingRule()).isNull();
      assertThat(details.getMatchedPercentageOption()).isNull();
    } finally {
      client.close();
    }
  }

  @Test
  void getValueDetails_returnsDefaultOnMissingKeyWithErrorCode() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("other.key", true);
    final ConfeatureClient client = buildClient(overrides);
    try {
      final EvaluationDetails<Object> details = client.getValueDetails("missing.key", false, null);
      assertThat(details.getKey()).isEqualTo("missing.key");
      assertThat(details.getValue()).isEqualTo(false);
      assertThat(details.isDefaultValue()).isTrue();
      // LocalOnly contract: missing key surfaces as KEY_NOT_FOUND. Without overrides, the
      // evaluator path would return NO_CONFIG. Either is acceptable per the spec.
      assertThat(details.getError())
          .satisfiesAnyOf(
              err -> assertThat(err).isEqualTo("KEY_NOT_FOUND"),
              err -> assertThat(err).isEqualTo("NO_CONFIG"));
    } finally {
      client.close();
    }
  }

  @Test
  void getValueDetails_onClosedClient_returnsClientClosedError() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client = buildClient(overrides);
    client.close();
    final EvaluationDetails<Object> details = client.getValueDetails("flag", false, null);
    assertThat(details.getKey()).isEqualTo("flag");
    assertThat(details.getValue()).isEqualTo(false);
    assertThat(details.isDefaultValue()).isTrue();
    assertThat(details.getError()).isEqualTo("CLIENT_CLOSED");
  }

  @Test
  void getValueDetails_onTypeMismatch_returnsDefault() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true); // boolean override
    final ConfeatureClient client = buildClient(overrides);
    try {
      // Ask for a String default — override is a boolean — TYPE_MISMATCH.
      final EvaluationDetails<Object> details =
          client.getValueDetails("flag", "default-string", null);
      assertThat(details.getValue()).isEqualTo("default-string");
      assertThat(details.isDefaultValue()).isTrue();
      assertThat(details.getError()).isEqualTo("TYPE_MISMATCH");
    } finally {
      client.close();
    }
  }

  @Test
  void getAllValues_returnsResolvedMapForAllOverrides() {
    final Map<String, Object> overrides = new LinkedHashMap<>();
    overrides.put("flag.a", true);
    overrides.put("flag.b", false);
    overrides.put("flag.s", "hello");
    final ConfeatureClient client = buildClient(overrides);
    try {
      final Map<String, Object> all = client.getAllValues(null);
      assertThat(all).hasSize(3);
      assertThat(all).containsEntry("flag.a", true);
      assertThat(all).containsEntry("flag.b", false);
      assertThat(all).containsEntry("flag.s", "hello");
    } finally {
      client.close();
    }
  }

  @Test
  void getAllValues_onClosedClient_returnsEmptyMap() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client = buildClient(overrides);
    client.close();
    assertThat(client.getAllValues(null)).isEmpty();
  }

  @Test
  void getAllValues_withNoConfig_returnsEmptyMap() {
    // No overrides; no cached config; manual-poll so no fetch happens.
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(new HashMap<>())))
            .build();
    try {
      assertThat(client.getAllValues(null)).isEmpty();
    } finally {
      client.close();
    }
  }

  @Test
  void getValueDetails_userPropagation() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client = buildClient(overrides);
    try {
      final User user = User.builder("targeting-id-123").email("test@example.com").build();
      final EvaluationDetails<Object> details = client.getValueDetails("flag", false, user);
      assertThat(details.getUser()).isSameAs(user);
    } finally {
      client.close();
    }
  }

  @Test
  void snapshot_getValueDetails_mirrorsClient() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final ConfeatureClient client = buildClient(overrides);
    try {
      final EvaluationDetails<Object> clientDetails = client.getValueDetails("flag", false, null);
      final Snapshot snap = client.snapshot();
      final EvaluationDetails<Object> snapDetails = snap.getValueDetails("flag", false, null);
      assertThat(snapDetails.getKey()).isEqualTo(clientDetails.getKey());
      assertThat(snapDetails.getValue()).isEqualTo(clientDetails.getValue());
      assertThat(snapDetails.isDefaultValue()).isEqualTo(clientDetails.isDefaultValue());
      assertThat(snapDetails.getError()).isEqualTo(clientDetails.getError());
      assertThat(snapDetails.getFetchTimeUnixMilliseconds())
          .isEqualTo(clientDetails.getFetchTimeUnixMilliseconds());
    } finally {
      client.close();
    }
  }
}
