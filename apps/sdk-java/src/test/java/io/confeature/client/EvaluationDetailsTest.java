// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.internal.ProviderResult;
import io.confeature.client.internal.ProviderResult.Status;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
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

  @Test
  void providerDetails_readFlatOverridesOnceAndKeepNativeReads() {
    final AtomicInteger reads = new AtomicInteger();
    final OverrideDataSource source =
        () -> {
          reads.incrementAndGet();
          return Map.of("int", 42, "double", 42.0);
        };
    try (ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(source))
            .build()) {
      final ProviderResult equalToDefault = client.getValueDetailsForProvider("int", 42L, null);
      assertThat(equalToDefault.getStatus()).isEqualTo(Status.RESOLVED);
      assertThat(equalToDefault.getDetails().getValue()).isEqualTo(42);
      assertThat(equalToDefault.getDetails().isDefaultValue()).isFalse();
      assertThat(reads.get()).isEqualTo(1);

      final ProviderResult wrongType = client.getValueDetailsForProvider("double", 42L, null);
      assertThat(wrongType.getStatus()).isEqualTo(Status.TYPE_MISMATCH);
      assertThat(wrongType.getDetails().getValue()).isEqualTo(42L);
      assertThat(reads.get()).isEqualTo(2);

      final EvaluationDetails<Object> nativeDetails = client.getValueDetails("int", 42L, null);
      assertThat(nativeDetails.getError()).isEqualTo("TYPE_MISMATCH");
      assertThat(reads.get()).isEqualTo(4);
    }
  }

  @Test
  void providerDetails_distinguishAbsentAndMalformedFlatValues() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("malformed", null);
    try (ConfeatureClient client = buildClient(overrides)) {
      assertThat(client.getValueDetailsForProvider("absent", false, null).getStatus())
          .isEqualTo(Status.NOT_FOUND);
      assertThat(client.getValueDetailsForProvider("malformed", false, null).getStatus())
          .isEqualTo(Status.PARSE_ERROR);
    }
    try (ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(() -> null))
            .build()) {
      assertThat(client.getValueDetailsForProvider("absent", false, null).getStatus())
          .isEqualTo(Status.NOT_READY);
      assertThat(client.getValueDetails("absent", false, null).getError())
          .isEqualTo("KEY_NOT_FOUND");
    }
  }

  @Test
  void providerDetails_useExplicitIdentityAndFireTheSameOutcomeWithoutUser() {
    final User defaultUser = User.builder("default-identity").build();
    final User explicitUser = User.builder("targeting-sentinel").build();
    final Map<String, Object> condition =
        Map.of(
            "u",
            Map.of(
                "a", "Identifier", "c", 0, "l", List.of("default-identity", "targeting-sentinel")));
    final Map<String, Object> rule =
        Map.of("c", List.of(condition), "s", Map.of("v", Map.of("b", true), "i", "targeted"));
    final Map<String, Object> setting =
        Map.of("t", 0, "v", Map.of("b", false), "i", "anonymous", "r", List.of(rule));
    final Map<String, Object> config = Map.of("f", Map.of("flag", setting));
    try (ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .defaultUser(defaultUser)
            .flagOverrides(FlagOverrides.localConfig(config, OverrideBehaviour.LOCAL_ONLY))
            .build()) {
      final List<EvaluationDetails<?>> events = new ArrayList<>();
      client.getHooks().addOnFlagEvaluated(events::add);

      final ProviderResult explicit =
          client.getValueDetailsForProvider("flag", false, explicitUser);
      assertThat(explicit.getStatus()).isEqualTo(Status.RESOLVED);
      assertThat(explicit.getDetails().getValue()).isEqualTo(true);
      assertThat(explicit.getDetails().getVariationId()).isEqualTo("targeted");
      assertThat(explicit.getDetails().getMatchedTargetingRule()).isNotNull();
      assertThat(explicit.getDetails().getUser()).isNull();

      final ProviderResult anonymous = client.getValueDetailsForProvider("flag", false, null);
      assertThat(anonymous.getStatus()).isEqualTo(Status.RESOLVED);
      assertThat(anonymous.getDetails().getValue()).isEqualTo(false);
      assertThat(anonymous.getDetails().getVariationId()).isEqualTo("anonymous");
      assertThat(anonymous.getDetails().getUser()).isNull();

      final EvaluationDetails<Object> nativeDetails = client.getValueDetails("flag", false, null);
      assertThat(nativeDetails.getValue()).isEqualTo(true);
      assertThat(nativeDetails.getUser()).isSameAs(defaultUser);
      assertThat(events)
          .containsExactly(explicit.getDetails(), anonymous.getDetails(), nativeDetails);
    }
  }

  @Test
  void providerDetails_classifyEvaluatorFailuresWithoutReplacingNativeErrors() {
    final Map<String, Object> settings =
        Map.of(
            "integer", Map.of("t", 2, "v", Map.of("i", Integer.MIN_VALUE)),
            "malformed", Map.of("t", 0, "v", Map.of("s", "not-a-boolean")),
            "opaque", Map.of("v", Map.of("b", true)),
            "unsupported", Map.of("t", 4));
    try (ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(
                FlagOverrides.localConfig(Map.of("f", settings), OverrideBehaviour.LOCAL_ONLY))
            .build()) {
      final ProviderResult integer = client.getValueDetailsForProvider("integer", 0L, null);
      assertThat(integer.getStatus()).isEqualTo(Status.RESOLVED);
      assertThat(integer.getDetails().getValue()).isEqualTo(Integer.MIN_VALUE);
      assertThat(client.getValueDetailsForProvider("malformed", false, null).getStatus())
          .isEqualTo(Status.PARSE_ERROR);
      assertThat(client.getValueDetailsForProvider("opaque", false, null).getStatus())
          .isEqualTo(Status.GENERAL);
      assertThat(client.getValueDetailsForProvider("unsupported", false, null).getStatus())
          .isEqualTo(Status.TYPE_MISMATCH);
      assertThat(client.getValueDetails("opaque", false, null).getError())
          .isEqualTo("MALFORMED_CONFIG");
    }
  }

  @Test
  void providerDetails_reportColdAndClosedClientsAsUnavailable() {
    final User defaultUser = User.builder("native-default").build();
    final ConfeatureClient client =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .defaultUser(defaultUser)
            .build();
    final List<EvaluationDetails<?>> events = new ArrayList<>();
    try {
      client.getHooks().addOnFlagEvaluated(events::add);
      final ProviderResult cold = client.getValueDetailsForProvider("flag", false, null);
      assertThat(cold.getStatus()).isEqualTo(Status.NOT_READY);
      assertThat(cold.getDetails().getError()).isEqualTo("NO_CONFIG");
      assertThat(events).containsExactly(cold.getDetails());
    } finally {
      client.close();
    }
    final ProviderResult closed = client.getValueDetailsForProvider("flag", false, defaultUser);
    assertThat(closed.getStatus()).isEqualTo(Status.NOT_READY);
    assertThat(closed.getDetails().getUser()).isNull();
    assertThat(client.getValueDetails("flag", false, null).getUser()).isSameAs(defaultUser);
    assertThat(events).hasSize(1);
  }
}
