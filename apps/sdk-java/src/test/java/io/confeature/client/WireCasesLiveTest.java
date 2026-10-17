// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.ConfigFetcher;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * sdk-java live wire-cases (#922, after sdk-go's #921).
 *
 * <p>sdk-java's own {@link ConfigFetcher} — its real OkHttp stack — against a RUNNING live-contract
 * harness serving the reference origin of the CDN read path. Every seeded wire-case is replayed and
 * judged by {@link WireCaseAssertions#assertWireCase}, the SAME rules the hermetic {@link
 * WireCasesTest} applies to a MockWebServer. Nothing is hand-built and no admin write is made:
 *
 * <ul>
 *   <li>the case set comes from the running harness ({@code GET /admin/state} → {@code keys}),
 *       never recomputed from the corpus — {@code http-403}, an unseeded key answered by the Worker
 *       itself, among them;
 *   <li>the request each case sent is read back from the harness ({@code GET
 *       /admin/requests?sdkKey=}), and each fetch must add exactly one entry;
 *   <li>a timeout case is ended by the fetcher's OWN deadline, a quarter of the harness's hold.
 * </ul>
 *
 * <p>Each case is its own dynamic test, so one failing case never hides another. Run it through the
 * manifest's {@code liveSuite.runner} (the harness's {@code --corpus-seed --exec --}).
 *
 * <p>GATING (fail closed): skipped only when {@code CONFEATURE_LIVE} is unset — the hermetic {@code
 * check}. When it is set without {@code LIVE_HARNESS_URL}, or the harness does not answer, the test
 * FAILS; it never skips.
 */
final class WireCasesLiveTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** The deadline of every case the harness does not hold. */
  private static final Duration DEFAULT_DEADLINE = Duration.ofSeconds(10);

  @TestFactory
  @SuppressWarnings("unchecked")
  Stream<DynamicTest> wireCasesLive() throws Exception {
    Assumptions.assumeTrue(
        "1".equals(System.getenv("CONFEATURE_LIVE")), "hermetic run: CONFEATURE_LIVE is not set");
    final String url = System.getenv("LIVE_HARNESS_URL");
    if (url == null || url.trim().isEmpty()) {
      Assertions.fail(
          "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through `live-contract-harness"
              + " --corpus-seed --exec -- …`; a live suite must never pass by skipping");
    }
    final Harness harness = new Harness(url.trim().replaceAll("/+$", ""));
    final Map<String, Object> state = harness.get("/admin/state", null);
    final List<String> keys = new ArrayList<>((List<String>) state.get("keys"));
    Collections.sort(keys);
    final Map<String, Object> faults =
        (Map<String, Object>) state.getOrDefault("faults", Collections.emptyMap());
    final Map<String, Map<String, Object>> corpus = WireCaseAssertions.casesById();

    final List<DynamicTest> tests = new ArrayList<>();
    tests.add(
        dynamicTest(
            "seeded-set",
            () -> {
              assertThat(keys)
                  .as("the harness reports no seeded case — an empty run checks nothing")
                  .isNotEmpty();
              assertThat(corpus.keySet()).as("every seeded key is a corpus case").containsAll(keys);
            }));
    for (String id : keys) {
      final Map<String, Object> wireCase = corpus.get(id);
      if (wireCase != null) { // a stray key is reported by seeded-set
        tests.add(dynamicTest(id, () -> liveCase(harness, id, wireCase, faults)));
      }
    }
    // US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
    // 403 since #785, classed like a 404 as invalidSdkKey.
    tests.add(
        dynamicTest(
            "unseeded-key",
            () -> {
              final ConfigFetcher.FetchResult result;
              try (ConfigFetcher fetcher =
                  new ConfigFetcher(
                      harness.base, "never-seeded-922", DEFAULT_DEADLINE, new TestLogger())) {
                result = fetcher.fetch("");
              }
              assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
              assertThat(WireCaseAssertions.javaErrorToClass(result.getError()))
                  .as("errorClass (raw=%s)", result.getError())
                  .isEqualTo("invalidSdkKey");
            }));
    return tests.stream();
  }

  /** One seeded case: one fetch, exactly one logged request, judged by the shared rules. */
  @SuppressWarnings("unchecked")
  private static void liveCase(
      Harness harness, String id, Map<String, Object> wireCase, Map<String, Object> faults)
      throws Exception {
    final long hold = holdMillis(id, wireCase, faults);
    final Duration deadline = hold > 0 ? Duration.ofMillis(hold / 4) : DEFAULT_DEADLINE;
    // The harness seeds each case under its id; a case that pins
    // given.sdkKey is configured with that key instead (#803 FR-003).
    final String sdkKey = WireCaseAssertions.sdkKeyFor(wireCase, id);
    final int loggedBefore = harness.requestsFor(sdkKey).size();
    final String prevETag =
        (String) ((Map<String, Object>) wireCase.get("given")).get("previousEtag");

    final long started = System.nanoTime();
    final ConfigFetcher.FetchResult result;
    try (ConfigFetcher fetcher =
        new ConfigFetcher(harness.base, sdkKey, deadline, new TestLogger())) {
      result = fetcher.fetch(prevETag == null ? "" : prevETag);
    }
    final long elapsedMs = (System.nanoTime() - started) / 1_000_000L;

    final List<Map<String, Object>> log = harness.requestsFor(sdkKey);
    // Exactly one request per fetch: a retrying SDK, or a request logged by
    // an earlier run, must not stand in for the one under test.
    assertThat(log.size() - loggedBefore).as("requests one fetch sent (case %s)", id).isEqualTo(1);
    if (hold > 0) {
      // The fetcher's own deadline ended the fetch, not the harness releasing it.
      assertThat(elapsedMs).as("fetch time vs the harness's %d ms hold", hold).isLessThan(hold);
    }
    final Map<String, Object> last = log.get(log.size() - 1);
    final String path = ((String) last.get("url")).split("\\?", 2)[0];
    WireCaseAssertions.assertWireCase(
        id,
        wireCase,
        sdkKey,
        new WireCaseAssertions.SentRequest(path, (String) last.get("ifNoneMatch")),
        result);
  }

  /**
   * The harness's hold for a timeout case — the fetcher's deadline is derived from it (#783 A8) —
   * or 0 for any other behaviour. A timeout case seeded without a hold fails.
   */
  @SuppressWarnings("unchecked")
  private static long holdMillis(
      String id, Map<String, Object> wireCase, Map<String, Object> faults) {
    if (!"timeout".equals(((Map<String, Object>) wireCase.get("server")).get("behavior"))) {
      return 0;
    }
    final Object fault = faults.get(id);
    final Object ms = fault instanceof Map ? ((Map<String, Object>) fault).get("ms") : null;
    assertThat(ms).as("%s is seeded without a timeout fault", id).isInstanceOf(Number.class);
    final long hold = ((Number) ms).longValue();
    assertThat(hold).as("%s timeout hold", id).isPositive();
    return hold;
  }

  /** The running harness the suite reads from: read-only admin routes only. */
  private static final class Harness {
    final String base;
    private final OkHttpClient client =
        new OkHttpClient.Builder().callTimeout(Duration.ofSeconds(10)).build();

    Harness(String base) {
      this.base = base;
    }

    /** The harness's JSON answer to {@code GET path[?sdkKey=]}; any other status fails. */
    @SuppressWarnings("unchecked")
    Map<String, Object> get(String path, String sdkKey) throws IOException {
      final HttpUrl.Builder target = HttpUrl.get(base + path).newBuilder();
      if (sdkKey != null) {
        target.addQueryParameter("sdkKey", sdkKey);
      }
      try (Response resp =
          client.newCall(new Request.Builder().url(target.build()).build()).execute()) {
        final String raw = resp.body() == null ? "" : resp.body().string();
        assertThat(resp.code()).as("harness %s answered %s", path, raw).isEqualTo(200);
        return MAPPER.readValue(raw, Map.class);
      }
    }

    /** The requests the harness logged for {@code sdkKey}, oldest first. */
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> requestsFor(String sdkKey) throws IOException {
      final Map<String, Object> body = get("/admin/requests", sdkKey);
      assertThat(body.get("ok")).as("harness refused /admin/requests: %s", body).isEqualTo(true);
      return (List<Map<String, Object>>) body.get("requests");
    }
  }
}
