// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.internal.ConfigFetcher;
import java.nio.file.Files;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Wire-protocol fixture suite — Java consumer.
 *
 * <p>Drives sdk-java's {@link ConfigFetcher} against each case in {@code
 * packages/test-fixtures-sdk-parity/fixtures/wire-cases.json}. The corpus is the language-agnostic
 * contract; this file is the Java consumer that maps the fetcher's typed {@link
 * ConfigFetcher.Status} plus stringly-typed {@link ConfigFetcher.FetchResult#getError()} onto the
 * corpus's normalised {@code {fetched, notModified, failed}} x {@code {fetchFailed, timeout,
 * parseFailed, invalidSdkKey}} vocabulary — the same vocabulary the other six SDK families already
 * conform to (sdk-node / sdk-browser-js / sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-rust).
 *
 * <p>Layer choice: this drives the fetcher directly (NOT the public {@link ConfeatureClient}),
 * matching what the other SDK slices already do — the wire-cases corpus by name tests wire
 * behaviour, and the fetcher is sdk-java's wire layer. Driving the public client would add
 * poll-service indirection that the corpus does not assert.
 *
 * <p>Constitution invariant (Principle II NON-NEGOTIABLE): every corpus case MUST pass (incl. the
 * {@code timeout} + {@code network-reset} {@code server.behavior} cases added in #490 and the #803
 * {@code request-path-*} cases). If a case drifts, STOP and investigate the fetcher — never mutate
 * the corpus to make the test green.
 *
 * <p>The mock transport honours the corpus's {@code server.behavior} discriminator, mirroring the
 * sdk-go reference (apps/sdk-go/wire_cases_test.go): {@code respond} (default / absent) delivers
 * status+headers+body; {@code timeout} hangs past a short per-case client timeout so the fetcher's
 * timeout path fires; {@code close-mid-response} drops the connection mid-body so the fetcher's
 * body read fails (→ fetchFailed, NOT parseFailed); any unrecognised behaviour FAILS the case.
 *
 * <p>See spec 112 / epic #146 / issue #148 (slice 7 of 13) + issue #490 / #590 (behaviour adapter).
 */
final class WireCasesTest {

  /**
   * Loads + projects each corpus case into a JUnit {@link Arguments} row keyed by case id so test
   * output reports {@code WireCasesTest > wireCase("fresh-fetch-200")}.
   */
  static Stream<Arguments> wireCases() throws Exception {
    return WireCaseAssertions.casesById().entrySet().stream()
        .map(entry -> Arguments.of(entry.getKey(), entry.getValue()));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("wireCases")
  @SuppressWarnings("unchecked")
  void wireCase(String id, Map<String, Object> wireCase) throws Exception {
    final Map<String, Object> given = (Map<String, Object>) wireCase.get("given");
    final Map<String, Object> server = (Map<String, Object>) wireCase.get("server");
    final String sdkKey =
        WireCaseAssertions.sdkKeyFor(wireCase, WireCaseAssertions.DEFAULT_SDK_KEY);

    // The mock transport maps server.behavior (#490) onto a MockWebServer
    // SocketPolicy: "respond" (default / absent) delivers the nominal
    // response; "timeout" hangs past the client timeout; "close-mid-response"
    // drops the socket mid-body. An unrecognised value fails loudly inside
    // buildMockResponse (never falls through to respond).
    String behavior = (String) server.get("behavior");
    if (behavior == null || behavior.isEmpty()) {
      behavior = "respond";
    }

    // The timeout case needs a short deadline so the suite stays fast; every
    // other behaviour keeps a generous budget. Mirrors sdk-go's 100ms cut.
    final Duration requestTimeout =
        behavior.equals("timeout") ? Duration.ofMillis(300) : Duration.ofSeconds(5);

    final MockWebServer mockServer = new MockWebServer();
    try {
      mockServer.start();
      mockServer.enqueue(buildMockResponse(server, behavior));

      final ConfigFetcher.FetchResult result;
      try (ConfigFetcher fetcher =
          new ConfigFetcher(
              mockServer.url("/").toString(), sdkKey, requestTimeout, new TestLogger())) {
        final String prevETag = (String) given.get("previousEtag");
        result = fetcher.fetch(prevETag == null ? "" : prevETag);
      }

      // fetch() is synchronous, so every request it made has arrived; the
      // bounded wait only keeps a regression from hanging the suite.
      final RecordedRequest recorded = mockServer.takeRequest(5, TimeUnit.SECONDS);
      assertThat(recorded).as("fetcher MUST issue an HTTP request (case %s)", id).isNotNull();
      assertThat(mockServer.getRequestCount())
          .as("fetcher MUST issue exactly one HTTP request (case %s)", id)
          .isEqualTo(1);
      // The target of the raw request line, query excluded.
      final String path = ConfigFetcherTest.rawTarget(recorded).split("\\?", 2)[0];
      WireCaseAssertions.assertWireCase(
          id,
          wireCase,
          sdkKey,
          new WireCaseAssertions.SentRequest(path, recorded.getHeader("If-None-Match")),
          result);
    } finally {
      mockServer.shutdown();
    }
  }

  /**
   * Builds the {@link MockResponse} for one case, applying the {@code server.behavior} adapter
   * (#490, mirroring sdk-go's mock transport). {@code bodyRef} resolves to a sibling fixture under
   * {@code packages/test-fixtures-sdk-parity/fixtures/}; {@code body} is used verbatim (for
   * malformed-payload cases). Either may be absent — 304 has no body.
   *
   * <p>Behaviours:
   *
   * <ul>
   *   <li>{@code respond} (default / absent): deliver status + headers + body unchanged.
   *   <li>{@code timeout}: {@link SocketPolicy#NO_RESPONSE} — accept the request but never send a
   *       response, so the client's call/read timeout fires → the fetcher's transport-error path →
   *       {@code InterruptedIOException}/{@code SocketTimeoutException} → timeout class.
   *   <li>{@code close-mid-response}: {@link SocketPolicy#DISCONNECT_DURING_RESPONSE_BODY} — writes
   *       part of the body then slams the socket shut so the client's body read throws an {@code
   *       IOException} → {@code fetchFailed} (a truncated body is a transport failure, NOT a
   *       JSON-shape error → never {@code parseFailed}).
   *   <li>anything else: FAIL the case loudly — never fall through to respond (FR-008 guard).
   * </ul>
   */
  @SuppressWarnings("unchecked")
  private static MockResponse buildMockResponse(Map<String, Object> server, String behavior)
      throws Exception {
    final MockResponse response =
        new MockResponse().setResponseCode((Integer) server.get("status"));
    final Map<String, String> headers =
        (Map<String, String>) server.getOrDefault("headers", Collections.emptyMap());
    for (Map.Entry<String, String> header : headers.entrySet()) {
      response.setHeader(header.getKey(), header.getValue());
    }
    final String bodyRef = (String) server.get("bodyRef");
    if (bodyRef != null) {
      final byte[] raw = Files.readAllBytes(WorkspaceRoot.fixturesDir().resolve(bodyRef));
      response.setBody(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
    } else {
      final String body = (String) server.get("body");
      if (body != null) {
        response.setBody(body);
      }
    }

    switch (behavior) {
      case "respond":
        break;
      case "timeout":
        // Hang: never deliver the nominal status/headers/body. The client's
        // configured timeout cancels the in-flight request.
        response.setSocketPolicy(SocketPolicy.NO_RESPONSE);
        break;
      case "close-mid-response":
        // Begin delivering the 200 body, then drop the socket mid-stream.
        // throttleBody keeps the write slow enough that the disconnect lands
        // mid-body, so the client observes a truncated read (unexpected EOF).
        response
            .throttleBody(16, 100, TimeUnit.MILLISECONDS)
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY);
        break;
      default:
        Assertions.fail(
            "wire-cases: unsupported server.behavior \"" + behavior + "\" — no adapter");
    }
    return response;
  }
}
