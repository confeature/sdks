// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import io.confeature.client.internal.ConfigFetcher;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

final class ConfigFetcherTest {

  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  private static final String PART_A = "FAKEfixtureKeyNotRea01";
  private static final String PART_B = "FAKEfixtureKeyNotRea02";
  private static final String CONFIGCAT_KEY = "configcat-sdk-1/" + PART_A + "/" + PART_B;

  private static final String CONFIG =
      "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},\"f\":{},\"s\":[]}";

  private MockWebServer server;
  private TestLogger logger;

  @BeforeEach
  void start() throws Exception {
    server = new MockWebServer();
    server.start();
    logger = new TestLogger();
  }

  @AfterEach
  void stop() throws Exception {
    server.shutdown();
  }

  @Test
  void fetch_200_parsesBodyAndCapturesEtag() throws Exception {
    server.enqueue(
        new MockResponse()
            .setHeader("ETag", "\"abc123\"")
            .setBody(
                "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},\"f\":{},\"s\":[]}"));
    try (ConfigFetcher fetcher =
        new ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger)) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FETCHED);
      assertThat(result.getEtag()).isEqualTo("\"abc123\"");
      assertThat(result.getBody()).containsKey("f");
      assertThat(result.getRawBody()).contains("\"f\"");
    }
  }

  @Test
  void fetch_304_returnsNotModified() throws Exception {
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"abc123\""));
    try (ConfigFetcher fetcher =
        new ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger)) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("\"abc123\"");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.NOT_MODIFIED);
      assertThat(result.getEtag()).isEqualTo("\"abc123\"");
      final RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
      assertNotNull(req, "the fetcher MUST issue a request");
      assertThat(req.getHeader("If-None-Match")).isEqualTo("\"abc123\"");
    }
  }

  @Test
  void fetch_500_reportsFailureWithRedactedSdkKey() throws Exception {
    server.enqueue(new MockResponse().setResponseCode(500));
    try (ConfigFetcher fetcher =
        new ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger)) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
      assertThat(result.getError()).contains("HTTP 500");
      // SDK key NEVER appears in any log line.
      assertThat(logger.allMessages()).noneMatch(msg -> msg.contains(SDK_KEY));
    }
  }

  @Test
  void fetch_emitsExpectedUserAgent() throws Exception {
    server.enqueue(new MockResponse().setBody("{}"));
    try (ConfigFetcher fetcher =
        new ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger)) {
      fetcher.fetch("");
      final RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
      assertNotNull(req, "the fetcher MUST issue a request");
      assertThat(req.getHeader("User-Agent"))
          .isEqualTo("confeature-java-sdk/" + Version.SDK_VERSION);
    }
  }

  /**
   * The request target of the one recorded request, as the bytes arrived on the wire: read from the
   * raw request line ({@code GET <target> HTTP/1.1}), never from a re-parsed URL, so a client that
   * re-encodes the path or a mock that decodes it cannot hide a difference (#803).
   */
  private String recordedPath() throws Exception {
    final RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
    assertNotNull(req, "the fetcher MUST issue a request");
    assertThat(server.getRequestCount()).as("exactly one request").isEqualTo(1);
    return rawTarget(req);
  }

  /** The target of {@code req}'s raw request line. */
  static String rawTarget(RecordedRequest req) {
    final String line = req.getRequestLine();
    final int start = line.indexOf(' ');
    final int end = line.lastIndexOf(' ');
    assertThat(start).as("request line %s", line).isPositive().isLessThan(end);
    return line.substring(start + 1, end);
  }

  private ConfigFetcher fetcherFor(String key, Duration timeout) {
    return new ConfigFetcher(server.url("/").toString(), key, timeout, logger);
  }

  @Test
  void fetch_legacyKey_travelsRawAsOneSegment() throws Exception {
    // #803 FR-001 — com.configcat.ConfigFetcher#getRequest (configcat-java-client 10.0.0) builds
    // url + "/configuration-files/" + sdkKey + "/config_v6.json": the key raw, no /v2/, no hash.
    server.enqueue(new MockResponse().setBody(CONFIG));
    try (ConfigFetcher fetcher = fetcherFor(SDK_KEY, Duration.ofSeconds(5))) {
      assertThat(fetcher.fetch("").getStatus()).isEqualTo(ConfigFetcher.Status.FETCHED);
      assertThat(recordedPath()).isEqualTo("/configuration-files/" + SDK_KEY + "/config_v6.json");
    }
  }

  @Test
  void fetch_configCatShapedKey_travelsRawAsThreeSegments() throws Exception {
    server.enqueue(new MockResponse().setBody(CONFIG));
    try (ConfigFetcher fetcher = fetcherFor(CONFIGCAT_KEY, Duration.ofSeconds(5))) {
      assertThat(fetcher.fetch("").getStatus()).isEqualTo(ConfigFetcher.Status.FETCHED);
      assertThat(recordedPath())
          .isEqualTo(
              "/configuration-files/configcat-sdk-1/" + PART_A + "/" + PART_B + "/config_v6.json");
    }
  }

  static Stream<Arguments> goPathEscapeCases() {
    // {key, Go url.PathEscape(key)} — the right-hand side is Go's printed output, verbatim.
    return Stream.of(
        Arguments.of(
            "bad key$&+:=@,;!'()*~/x?y#z%..",
            "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25.."),
        // The corpus key (#803 pass 2): one code point of each UTF-8 length — é (2 bytes),
        // € (3), 😀 (4, a UTF-16 surrogate pair in Java) — escaped by UTF-8 byte.
        Arguments.of(
            "bad key$&+:=@,;!'()*~/x?y#z%\u00e9\u20ac\uD83D\uDE00..",
            "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80.."),
        Arguments.of("bad key/x?y#z", "bad%20key%2Fx%3Fy%23z"),
        Arguments.of("cl\u00e9[\\]^`{|}", "cl%C3%A9%5B%5C%5D%5E%60%7B%7C%7D"));
  }

  /**
   * #803 FR-001 — a malformed key is escaped into ONE segment exactly as Go's {@code
   * url.PathEscape}: {@code $ & + : = @} and the unreserved set stay, everything else is {@code
   * %XX} — a space is {@code %20} (never form escaping's {@code +}); {@code /}, {@code ?}, {@code
   * #} stay in the segment. Each expected value is Go's real output, copied as a literal.
   */
  @ParameterizedTest
  @MethodSource("goPathEscapeCases")
  void fetch_malformedKey_isEscapedIntoOneSegment(String key, String goPathEscape)
      throws Exception {
    server.enqueue(new MockResponse().setBody(CONFIG));
    try (ConfigFetcher fetcher = fetcherFor(key, Duration.ofSeconds(5))) {
      assertThat(fetcher.fetch("").getStatus()).isEqualTo(ConfigFetcher.Status.FETCHED);
      assertThat(recordedPath())
          .isEqualTo("/configuration-files/" + goPathEscape + "/config_v6.json");
    }
  }

  /**
   * A stored ETag OkHttp refuses as a header value — non-ASCII (OkHttp reads a response header
   * leniently, so one can reach the cache) or a CR/LF — must neither make fetch() throw nor fail
   * every fetch: it is dropped, the fetch goes out unconditional, and the 200's ETag is the one the
   * next fetch sends.
   */
  @ParameterizedTest
  @ValueSource(strings = {"\"v1-\u00e9\"", "\"v1-\uD83D\uDE00\"", "\"v1\r\nX-Injected: 1\""})
  void fetch_etagOkHttpRefuses_isDroppedAndTheNextFetchHeals(String badEtag) throws Exception {
    server.enqueue(new MockResponse().setHeader("ETag", "\"v2\"").setBody(CONFIG));
    server.enqueue(new MockResponse().setResponseCode(304).setHeader("ETag", "\"v2\""));
    try (ConfigFetcher fetcher = fetcherFor(CONFIGCAT_KEY, Duration.ofSeconds(5))) {
      final ConfigFetcher.FetchResult first = fetcher.fetch(badEtag);
      assertThat(first.getStatus()).isEqualTo(ConfigFetcher.Status.FETCHED);
      assertThat(first.getEtag()).isEqualTo("\"v2\"");
      final RecordedRequest unconditional = server.takeRequest(5, TimeUnit.SECONDS);
      assertNotNull(unconditional, "the first fetch MUST issue a request");
      assertThat(unconditional.getHeader("If-None-Match")).isNull();
      assertThat(unconditional.getHeader("X-Injected")).isNull();

      final ConfigFetcher.FetchResult second = fetcher.fetch(first.getEtag());
      assertThat(second.getStatus()).isEqualTo(ConfigFetcher.Status.NOT_MODIFIED);
      final RecordedRequest conditional = server.takeRequest(5, TimeUnit.SECONDS);
      assertNotNull(conditional, "the second fetch MUST issue a request");
      assertThat(conditional.getHeader("If-None-Match")).isEqualTo("\"v2\"");

      assertThat(logger.allMessages())
          .anyMatch(m -> m.startsWith("WARN ") && m.contains("dropped a stored ETag"))
          .noneMatch(m -> m.contains("v1"));
      assertKeyFree(first, CONFIGCAT_KEY);
    }
  }

  @Test
  void fetch_200WithJsonNullBody_failsWithAFixedCode() {
    // `null` parses to a null map: a shape failure, never an NPE out of fetch().
    server.enqueue(new MockResponse().setBody("null"));
    try (ConfigFetcher fetcher = fetcherFor(CONFIGCAT_KEY, Duration.ofSeconds(5))) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
      assertThat(result.getError()).isEqualTo("MALFORMED_JSON");
      assertKeyFree(result, CONFIGCAT_KEY);
    }
  }

  @Test
  void testLogger_recordsTheThrowableAndItsWholeCauseChain() {
    // The key-free checks below are only as good as this double: a real logger prints the
    // throwable, its suppressed exceptions and every cause, so the double must record them all.
    final IllegalArgumentException root =
        new IllegalArgumentException("Invalid URL: http://h/configuration-files/" + PART_A);
    final java.io.IOException outer = new java.io.IOException("outer", root);
    outer.addSuppressed(new IllegalStateException(PART_B));
    logger.error("failed", outer);
    assertThat(logger.allMessages())
        .singleElement()
        .asString()
        .contains("failed", "java.io.IOException: outer", PART_A, PART_B);
  }

  @ParameterizedTest
  @ValueSource(strings = {"", ".", ".."})
  void fetch_keyThatCannotBeASegment_requestsNothing(String key) throws Exception {
    // ConfigFetcherUrlTest asserts the package-private getUrl() is null for these keys.
    try (ConfigFetcher fetcher = fetcherFor(key, Duration.ofSeconds(5))) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
      assertThat(result.getError()).isEqualTo("INVALID_SDK_KEY");
      assertThat(server.getRequestCount()).isZero();
      assertThat(logger.allMessages()).anyMatch(m -> m.contains("INVALID_SDK_KEY"));
    }
  }

  @Test
  void fetch_malformedBaseUrl_failsWithAFixedCode() {
    try (ConfigFetcher fetcher =
        new ConfigFetcher("not a url", CONFIGCAT_KEY, Duration.ofSeconds(5), logger)) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getError()).isEqualTo("invalid_request");
      assertKeyFree(result, CONFIGCAT_KEY);
    }
  }

  /**
   * #803 FR-002/FR-004 — the URL now carries the key, so a forced timeout, a mid-body reset and a
   * redirect loop must each fail with a fixed code, and neither the full key nor any 22-char part
   * may reach a log line or the fetch result's error.
   */
  @ParameterizedTest
  @ValueSource(strings = {"timeout", "mid-body reset", "redirect loop", "garbled status line"})
  void fetch_forcedTransportFailure_isKeyFree(String failure) throws Exception {
    final String expectedCode;
    switch (failure) {
      case "timeout":
        server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE));
        expectedCode = "timeout";
        break;
      case "mid-body reset":
        server.enqueue(
            new MockResponse()
                .setBody(CONFIG + CONFIG + CONFIG)
                .throttleBody(16, 100, TimeUnit.MILLISECONDS)
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY));
        expectedCode = "body_read_failed";
        break;
      case "garbled status line":
        // A broken intermediary echoing the request target as its status line: OkHttp's
        // ProtocolException("Unexpected status line: ...") then quotes the key verbatim — the
        // exception a fetcher must never hand to a logger.
        server.setDispatcher(
            new Dispatcher() {
              @Override
              public MockResponse dispatch(RecordedRequest request) {
                return new MockResponse().setStatus("HTTP/1.1 " + rawTarget(request));
              }
            });
        expectedCode = "network_error";
        break;
      default:
        server.setDispatcher(
            new Dispatcher() {
              @Override
              public MockResponse dispatch(RecordedRequest request) {
                return new MockResponse()
                    .setResponseCode(302)
                    .setHeader("Location", request.getRequestUrl().toString());
              }
            });
        expectedCode = "too_many_redirects";
        break;
    }
    final Duration timeout =
        failure.equals("timeout") ? Duration.ofMillis(300) : Duration.ofSeconds(5);
    try (ConfigFetcher fetcher = fetcherFor(CONFIGCAT_KEY, timeout)) {
      final ConfigFetcher.FetchResult result = fetcher.fetch("");
      assertThat(result.getStatus()).isEqualTo(ConfigFetcher.Status.FAILED);
      assertThat(result.getError()).isEqualTo(expectedCode);
      // The one fail() line, sdk-android's shape: a checked error names no exception type.
      assertThat(logger.allMessages())
          .anyMatch(
              m ->
                  m.startsWith("ERROR ConfigFetcher: fetch raised. sdkKey=")
                      && m.endsWith(" reason=" + expectedCode));
      assertKeyFree(result, CONFIGCAT_KEY);
    }
  }

  private void assertKeyFree(ConfigFetcher.FetchResult result, String key) {
    for (String secret : new String[] {key, PART_A, PART_B}) {
      assertThat(result.getError()).doesNotContain(secret);
      assertThat(logger.allMessages()).noneMatch(m -> m.contains(secret));
    }
  }
}
