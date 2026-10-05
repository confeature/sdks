// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.ConfigFetcher;
import io.confeature.client.internal.ConfigFetcherProbe;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /**
   * Default key for cases that do not pin {@code given.sdkKey}: a well-shaped legacy key, so its
   * #803 FR-001 path is the key verbatim.
   */
  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /**
   * Maps the fetcher's stringly-typed {@link ConfigFetcher.FetchResult#getError()} onto the
   * corpus's normalised error-class vocabulary. The fetcher emits:
   *
   * <ul>
   *   <li>{@code "MALFORMED_JSON"} (JSON parse failure OR wrong-shape body) → {@code parseFailed}
   *   <li>{@code "EMPTY_BODY"} (200 with empty payload) → {@code parseFailed}
   *   <li>{@code "HTTP 403"} / {@code "HTTP 404"} → {@code invalidSdkKey} (per ConfigCat only
   *       403/404 are invalid-SDK-key statuses; 401 is a generic retryable failure)
   *   <li>{@code "HTTP <other-non-2xx>"} → {@code fetchFailed}
   *   <li>{@code "timeout"} (call / connect / read timeout) → {@code timeout}
   *   <li>any other fixed transport code ({@code network_error}, {@code body_read_failed}, {@code
   *       too_many_redirects}, {@code invalid_request}) → {@code fetchFailed}
   *   <li>{@code "INVALID_SDK_KEY"} (the key cannot be a path segment; nothing fetched) → {@code
   *       invalidSdkKey}
   * </ul>
   *
   * <p>Mirrors sdk-go's {@code goErrorToClass} and sdk-python's {@code _python_error_to_class}.
   * When the fetcher upgrades to a typed enum (FR-018), this mapping moves to a switch on that
   * enum.
   */
  private static String javaErrorToClass(String reason) {
    if (reason == null) {
      return "fetchFailed";
    }
    if (reason.equals("MALFORMED_JSON") || reason.equals("EMPTY_BODY")) {
      return "parseFailed";
    }
    if (reason.equals("HTTP 403") || reason.equals("HTTP 404")) {
      return "invalidSdkKey";
    }
    if (reason.startsWith("HTTP ")) {
      return "fetchFailed";
    }
    if (reason.equals("timeout")) {
      return "timeout";
    }
    if (reason.equals("INVALID_SDK_KEY")) {
      return "invalidSdkKey";
    }
    return "fetchFailed";
  }

  /** Every {@code given} field this consumer reads; any other FAILS the case (#803 FR-003). */
  private static final Set<String> KNOWN_GIVEN =
      new HashSet<>(Arrays.asList("previousEtag", "sdkKey", "baseUrl"));

  /** Every {@code expected} field this consumer reads; any other FAILS the case. */
  private static final Set<String> KNOWN_EXPECTED =
      new HashSet<>(
          Arrays.asList(
              "requestHeaderIfNoneMatch",
              "outcome",
              "resultingEtag",
              "hasConfig",
              "errorClass",
              "requestUrlPrefix",
              "requestPath"));

  /**
   * Loads + projects each corpus case into a JUnit {@link Arguments} row keyed by case id so test
   * output reports {@code WireCasesTest > wireCase("fresh-fetch-200")}.
   */
  static Stream<Arguments> wireCases() throws Exception {
    final byte[] raw = Files.readAllBytes(WorkspaceRoot.wireCasesPath());
    @SuppressWarnings("unchecked")
    final Map<String, Object> corpus = MAPPER.readValue(raw, Map.class);
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> cases = (List<Map<String, Object>>) corpus.get("cases");
    if (cases == null || cases.isEmpty()) {
      throw new IllegalStateException("wire-cases.json carries no cases.");
    }
    final List<Arguments> rows = new ArrayList<>(cases.size());
    for (Map<String, Object> wireCase : cases) {
      rows.add(Arguments.of((String) wireCase.get("id"), wireCase));
    }
    return rows.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("wireCases")
  @SuppressWarnings("unchecked")
  void wireCase(String id, Map<String, Object> wireCase) throws Exception {
    final Map<String, Object> given = (Map<String, Object>) wireCase.get("given");
    final Map<String, Object> server = (Map<String, Object>) wireCase.get("server");
    final Map<String, Object> expected = (Map<String, Object>) wireCase.get("expected");
    assertThat(KNOWN_GIVEN)
        .as("case %s carries a given field this consumer does not read", id)
        .containsAll(given.keySet());
    assertThat(KNOWN_EXPECTED)
        .as("case %s carries an expected field this consumer does not read", id)
        .containsAll(expected.keySet());
    final String sdkKey = given.get("sdkKey") != null ? (String) given.get("sdkKey") : SDK_KEY;

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

      // ---- Request-side assertions ------------------------------------
      // fetch() is synchronous, so every request it made has arrived; the
      // bounded wait only keeps a regression from hanging the suite.
      final RecordedRequest recorded = mockServer.takeRequest(5, TimeUnit.SECONDS);
      assertThat(recorded).as("fetcher MUST issue an HTTP request (case %s)", id).isNotNull();
      assertThat(mockServer.getRequestCount())
          .as("fetcher MUST issue exactly one HTTP request (case %s)", id)
          .isEqualTo(1);
      // The request target AS IT ARRIVED ON THE WIRE — the raw request line,
      // never a re-parsed URL, so neither OkHttp re-encoding the path nor a
      // decoding mock can hide a difference — compared byte for byte with the
      // corpus's requestPath when the case pins one, else ConfigCat's
      // /configuration-files/<sdkKey>/config_v6.json for the default legacy
      // key, which FR-001 sends verbatim.
      final String wantPath =
          expected.containsKey("requestPath")
              ? (String) expected.get("requestPath")
              : "/configuration-files/" + sdkKey + "/config_v6.json";
      assertThat(ConfigFetcherTest.rawTarget(recorded))
          .as("request target on the wire (case %s)", id)
          .isEqualTo(wantPath);
      assertRequestUrlPrefix(id, given, expected, sdkKey);
      assertIfNoneMatch(recorded, expected);

      // ---- Outcome assertions -----------------------------------------
      final String outcome = (String) expected.get("outcome");
      switch (outcome) {
        case "fetched":
          assertThat(result.getStatus())
              .as("outcome=fetched (case %s, error=%s)", id, result.getError())
              .isEqualTo(ConfigFetcher.Status.FETCHED);
          final Object resultingEtagFetched = expected.get("resultingEtag");
          if (resultingEtagFetched != null) {
            assertThat(result.getEtag()).isEqualTo(resultingEtagFetched);
          }
          assertThat(result.getBody()).as("fetched outcome must populate body").isNotNull();
          assertThat(result.getRawBody()).as("fetched outcome must populate raw body").isNotNull();
          if (expected.containsKey("hasConfig")) {
            assertThat(result.getBody() != null)
                .as("hasConfig (case %s)", id)
                .isEqualTo(expected.get("hasConfig"));
          }
          break;
        case "notModified":
          assertThat(result.getStatus())
              .as("outcome=notModified (case %s, error=%s)", id, result.getError())
              .isEqualTo(ConfigFetcher.Status.NOT_MODIFIED);
          final Object resultingEtagNotMod = expected.get("resultingEtag");
          if (resultingEtagNotMod != null) {
            assertThat(result.getEtag()).isEqualTo(resultingEtagNotMod);
          }
          assertThat(result.getBody()).as("notModified outcome must NOT carry a body").isNull();
          break;
        case "failed":
          assertThat(result.getStatus())
              .as("outcome=failed (case %s, error=%s)", id, result.getError())
              .isEqualTo(ConfigFetcher.Status.FAILED);
          final String expectedClass = (String) expected.get("errorClass");
          final String actualClass = javaErrorToClass(result.getError());
          assertThat(actualClass)
              .as(
                  "errorClass mapping for case %s (raw error=%s) MUST be %s",
                  id, result.getError(), expectedClass)
              .isEqualTo(expectedClass);
          assertThat(result.getBody()).as("failed outcome must NOT carry a body").isNull();
          break;
        default:
          throw new IllegalStateException("unknown outcome: " + outcome);
      }
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

  /**
   * A custom base must lead the request URL (custom-base-url): {@code given.baseUrl} and {@code
   * expected.requestUrlPrefix} come together, and a fetcher configured with that base requests a
   * URL starting with the prefix — the URL OkHttp issues, captured before it leaves the process.
   */
  private static void assertRequestUrlPrefix(
      String id, Map<String, Object> given, Map<String, Object> expected, String sdkKey) {
    final String base = (String) given.get("baseUrl");
    final String prefix = (String) expected.get("requestUrlPrefix");
    assertThat(base == null)
        .as("case %s: given.baseUrl and expected.requestUrlPrefix come together", id)
        .isEqualTo(prefix == null);
    if (base == null) {
      return;
    }
    assertThat(ConfigFetcherProbe.requestedUrl(base, sdkKey, new TestLogger()))
        .as("request URL prefix (case %s)", id)
        .startsWith(prefix);
  }

  /**
   * Asserts the request's {@code If-None-Match} header against the corpus's three-state semantics:
   * absent (don't assert), explicit {@code null} (header MUST NOT be sent), explicit string (header
   * MUST equal). The Jackson decode collapses absent + explicit-null into the same {@code null}
   * value, so we additionally check the key's presence.
   */
  private static void assertIfNoneMatch(RecordedRequest recorded, Map<String, Object> expected) {
    if (!expected.containsKey("requestHeaderIfNoneMatch")) {
      return;
    }
    final Object value = expected.get("requestHeaderIfNoneMatch");
    final String actual = recorded.getHeader("If-None-Match");
    if (value == null) {
      assertThat(actual).as("If-None-Match MUST NOT be sent").isNull();
    } else {
      assertThat(actual).as("If-None-Match round-trip").isEqualTo(value);
    }
  }
}
