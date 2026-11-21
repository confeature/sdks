// SPDX-License-Identifier: MIT
package io.confeature.openfeature;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.FlagEvaluationDetails;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.Reason;
import dev.openfeature.sdk.Value;
import dev.openfeature.sdk.exceptions.ProviderNotReadyError;
import io.confeature.client.ConfeatureClient;
import io.confeature.client.EvaluationDetails;
import io.confeature.client.PollingMode;
import io.confeature.client.User;
import io.confeature.client.internal.InMemoryCache;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

/** Runs in a dedicated fork through the seeded public Config V2 harness. */
public final class OpenFeatureSmoke {
  private static final String TARGET = "stringIsInDogDefaultCat";
  private static final String DEFAULT = "caller-default";
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final User NATIVE_DEFAULT =
      User.builder("configured-default").custom(Map.of("Custom1", "admin")).build();

  private OpenFeatureSmoke() {}

  public static void main(String[] args) throws Exception {
    final URI origin = LoopbackOnly.requireOrigin(System.getenv("LIVE_HARNESS_URL"));
    final String key = Objects.requireNonNull(System.getenv("OPENFEATURE_JAVA_FIXTURE_KEY"));
    checkContextMapping();
    try (var guard = new LoopbackOnly(origin)) {
      exerciseOfficialClient(origin, key);
      same(0, guard.deniedCount(), "the seeded consumer used only the allowed route");
    }
    TransportSmoke.check(key);
    System.out.println("Java OpenFeature consumer passed against the seeded Config V2 fixture");
  }

  private static void exerciseOfficialClient(URI origin, String key) throws Exception {
    final int before = requests(origin, key);
    final OpenFeatureAPI api = OpenFeatureAPI.getInstance();
    try (var sdk = nativeClient(origin.toString(), key, PollingMode.manualPoll())) {
      final List<EvaluationDetails<?>> events = new ArrayList<>();
      sdk.getHooks().addOnFlagEvaluated(events::add);
      final var provider = new ConfeatureProvider(sdk);
      api.setProviderAndWait(provider);
      final Client client = api.getClient();
      same(0, events.size(), "registration did not evaluate");
      same(before, requests(origin, key), "registration did not fetch");
      error(client.getStringDetails(TARGET, DEFAULT), DEFAULT, ErrorCode.PROVIDER_NOT_READY);
      same(1, events.size(), "cold evaluation did one native evaluation");
      same(before, requests(origin, key), "cold ManualPoll did not fetch");
      same(true, sdk.forceRefresh(), "manual refresh reached the seeded endpoint");
      same(before + 1, requests(origin, key), "one manual HTTP fetch");

      checkTargeting(client);
      same(5, events.size(), "four warm requests did four native evaluations");
      for (var event : events) {
        same(null, event.getUser(), "companion native hook did not expose user context");
      }
      same("Dog", sdk.getValueDetails(TARGET, DEFAULT, null).getValue(), "native default survived");
      same(NATIVE_DEFAULT, events.get(5).getUser(), "native caller still has its own hook payload");

      checkTypes(client);
      sdk.setOffline();
      same(
          "Cat", client.getStringValue(TARGET, DEFAULT), "offline evaluation retained cached data");
      verifyReplacement(api, sdk, provider);
      same("Dog", sdk.getValueDetails(TARGET, DEFAULT, null).getValue(), "SDK remains app-owned");
      same(before + 1, requests(origin, key), "cached, offline and replacement add no HTTP");
    } finally {
      api.shutdown();
    }

    try (var sdk = nativeClient(origin.toString(), key, PollingMode.lazyLoad())) {
      final var adapter = new ConfeatureProvider(sdk);
      same("Cat", adapter.getStringEvaluation(TARGET, DEFAULT, null).getValue(), "native LazyLoad");
      same(before + 2, requests(origin, key), "one LazyLoad HTTP fetch");
    }
  }

  private static void verifyReplacement(
      OpenFeatureAPI api, ConfeatureClient sdk, ConfeatureProvider retired)
      throws InterruptedException {
    api.setProviderAndWait(new ConfeatureProvider(sdk));
    final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    for (; ; ) {
      try {
        retired.initialize(null);
      } catch (ProviderNotReadyError disposed) {
        break;
      }
      if (System.nanoTime() >= deadline) {
        throw new AssertionError("OpenFeature did not dispose the replaced provider");
      }
      Thread.sleep(10);
    }
    error(
        retired.getStringEvaluation(TARGET, DEFAULT, null).getErrorCode(),
        ErrorCode.PROVIDER_NOT_READY);
    try {
      api.setProviderAndWait(retired);
      throw new AssertionError("OpenFeature registered an already-disposed adapter");
    } catch (ProviderNotReadyError expected) {
      // A fresh adapter can borrow the same client.
    }
  }

  private static int requests(URI origin, String key) throws Exception {
    final URI endpoint =
        origin.resolve("/admin/requests?sdkKey=" + URLEncoder.encode(key, StandardCharsets.UTF_8));
    final var connection = (HttpURLConnection) endpoint.toURL().openConnection(Proxy.NO_PROXY);
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(2000);
    connection.setReadTimeout(2000);
    try (var body = connection.getInputStream()) {
      final var result = JSON.readTree(body);
      same(true, result.path("ok").asBoolean(), "fixture request log is available");
      same(true, result.path("requests").isArray(), "fixture returned the request array");
      return result.get("requests").size();
    } finally {
      connection.disconnect();
    }
  }

  private static void checkTargeting(Client client) {
    final var admin = new ImmutableContext("0", Map.of("Custom1", new Value("admin")));
    final var other = new ImmutableContext("other", Map.of("Custom1", new Value("member")));
    final var dog = client.getStringDetails(TARGET, "Dog", admin);
    same("Dog", dog.getValue(), "value equal to caller default remains a success");
    same(null, dog.getErrorCode(), "matching result is successful");
    same("5b64d9b4", dog.getVariant(), "Dog variation id");
    same(Reason.TARGETING_MATCH.name(), dog.getReason(), "targeting reason");
    same("Cat", client.getStringValue(TARGET, DEFAULT, other), "second identity is independent");
    final var anonymous = client.getStringDetails(TARGET, DEFAULT);
    same("Cat", anonymous.getValue(), "anonymous OpenFeature ignores the SDK default user");
    same("83372510", anonymous.getVariant(), "Cat variation id");
    final var percent = client.getStringDetails("numberWithPercentage", DEFAULT, other);
    same(Reason.SPLIT.name(), percent.getReason(), "percentage reason");
    same(true, List.of("20pct0000", "80pct0000").contains(percent.getVariant()), "percentage id");
  }

  private static void checkContextMapping() {
    final Instant date = Instant.parse("2026-01-02T00:00:00Z");
    final var context =
        new ImmutableContext(
            "0",
            Map.of(
                "Identifier", new Value("spoof"),
                "Email", new Value("synthetic@example.invalid"),
                "Country", new Value("FR"),
                "Groups", new Value(List.of(new Value("a"), new Value("b"))),
                "Since", new Value(date),
                "Count", new Value(7L),
                "Infinity", new Value(Double.POSITIVE_INFINITY),
                "BadList", new Value(List.of(new Value(1)))));
    final User user = OpenFeatureUser.from(context);
    same("0", user.getIdentifier(), "reserved attributes cannot replace the targeting key");
    same("synthetic@example.invalid", user.getEmail(), "native email");
    same("FR", user.getCountry(), "native country");
    same(
        Map.of("Groups", List.of("a", "b"), "Since", date, "Count", 7L),
        user.getCustom(),
        "supported attributes retain their types and unsupported attributes are dropped");
    same(null, OpenFeatureUser.from(ImmutableContext.EMPTY), "empty context maps to null user");
  }

  private static void checkTypes(Client client) {
    same(false, client.getBooleanValue("booleanKey1", true), "Boolean flag");
    same(999999, client.getIntegerValue("whole", 0), "Integer flag");
    same(999999L, client.getLongValue("whole", 0L), "lossless long");
    same(0.0, client.getDoubleValue("decimal", 1.5), "Double flag");
    error(client.getLongDetails("decimal", 17L), 17L, ErrorCode.TYPE_MISMATCH);
    error(client.getDoubleDetails("whole", 1.5), 1.5, ErrorCode.TYPE_MISMATCH);
    error(client.getStringDetails("missing", DEFAULT), DEFAULT, ErrorCode.FLAG_NOT_FOUND);
    final var fallback = new Value("opaque");
    error(client.getObjectDetails("whole", fallback), fallback, ErrorCode.TYPE_MISMATCH);
  }

  static ConfeatureClient nativeClient(String origin, String key, PollingMode mode) {
    return ConfeatureClient.builder(key)
        .baseUrl(origin)
        .pollingMode(mode)
        .defaultUser(NATIVE_DEFAULT)
        .cache(new InMemoryCache())
        .build();
  }

  private static void error(ErrorCode actual, ErrorCode expected) {
    same(expected, actual, "error code");
  }

  private static void error(FlagEvaluationDetails<?> detail, Object fallback, ErrorCode expected) {
    error(detail.getErrorCode(), expected);
    same(fallback, detail.getValue(), "caller default");
    same(Reason.ERROR.name(), detail.getReason(), "error reason");
  }

  static void same(Object expected, Object actual, String description) {
    if (!Objects.equals(expected, actual)) {
      throw new AssertionError(description + ": expected " + expected + ", got " + actual);
    }
  }
}
