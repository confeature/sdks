// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.ConfigFetcher;
import io.confeature.client.internal.ConfigFetcherProbe;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What a {@code wire-cases.json} case means for sdk-java — ONE implementation, shared by the
 * hermetic suite ({@link WireCasesTest}, a MockWebServer) AND the live suite ({@link
 * WireCasesLiveTest}, real HTTP against the live-contract harness, #922), so both are judged by the
 * same rules. The request is passed in transport-neutral form ({@link SentRequest}): the hermetic
 * suite reads it from the recorded request line, the live suite from the harness's {@code GET
 * /admin/requests}.
 *
 * <p>Mirrors sdk-go's {@code wire_case_assertions_test.go} and sdk-ruby's {@code
 * wire_case_assertions.rb} (#920, #921).
 */
final class WireCaseAssertions {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /**
   * Default key for cases that do not pin {@code given.sdkKey} in the hermetic suite: a well-shaped
   * legacy key, so its #803 FR-001 path is the key verbatim.
   */
  static final String DEFAULT_SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

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

  private WireCaseAssertions() {}

  /** The one request a fetch sent, as it arrived: its path (query excluded) and If-None-Match. */
  static final class SentRequest {
    final String path;
    final String ifNoneMatch;

    SentRequest(String path, String ifNoneMatch) {
      this.path = path;
      this.ifNoneMatch = ifNoneMatch;
    }
  }

  /** The corpus's cases by id, in corpus order; an empty corpus fails rather than passing. */
  @SuppressWarnings("unchecked")
  static Map<String, Map<String, Object>> casesById() throws Exception {
    final Map<String, Object> corpus =
        MAPPER.readValue(Files.readAllBytes(WorkspaceRoot.wireCasesPath()), Map.class);
    final List<Map<String, Object>> cases = (List<Map<String, Object>>) corpus.get("cases");
    if (cases == null || cases.isEmpty()) {
      throw new IllegalStateException("wire-cases.json carries no cases.");
    }
    final Map<String, String> pending = pendingCases();
    final Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
    for (Map<String, Object> wireCase : cases) {
      final String id = (String) wireCase.get("id");
      final String ticket = pending.remove(id);
      if (ticket != null) {
        // Left out BY NAME (wire-cases-pending.json, 1.4, #994), under a proof that the entry is
        // still true: this reader still cannot read the case. The day it can, the entry must go.
        final Set<String> unread =
            new HashSet<>(((Map<String, Object>) wireCase.get("given")).keySet());
        unread.removeAll(KNOWN_GIVEN);
        final Set<String> unreadExpected =
            new HashSet<>(((Map<String, Object>) wireCase.get("expected")).keySet());
        unreadExpected.removeAll(KNOWN_EXPECTED);
        unread.addAll(unreadExpected);
        if (unread.isEmpty()) {
          throw new IllegalStateException(
              id
                  + " is pending for sdk-java ("
                  + ticket
                  + ") but this reader reads every field of it — remove it from"
                  + " wire-cases-pending.json and run it");
        }
        System.err.println(
            "pending (" + ticket + "): " + id + " — this reader cannot read " + unread);
        continue;
      }
      byId.put(id, wireCase);
    }
    if (!pending.isEmpty()) {
      throw new IllegalStateException(
          "wire-cases-pending.json lists " + pending.keySet() + " for sdk-java, not in the corpus");
    }
    return byId;
  }

  /** sdk-java's entry of {@code wire-cases-pending.json}: case id to ticket. */
  @SuppressWarnings("unchecked")
  static Map<String, String> pendingCases() throws Exception {
    final Map<String, Object> manifest =
        MAPPER.readValue(
            Files.readAllBytes(
                WorkspaceRoot.wireCasesPath().resolveSibling("wire-cases-pending.json")),
            Map.class);
    final Map<String, Object> entry =
        (Map<String, Object>) ((Map<String, Object>) manifest.get("pending")).get("sdk-java");
    final Map<String, String> out = new LinkedHashMap<>();
    if (entry != null) {
      for (Object id : (List<Object>) entry.get("cases")) {
        out.put((String) id, (String) entry.get("ticket"));
      }
    }
    return out;
  }

  /**
   * The key a case's fetcher is configured with: its pinned {@code given.sdkKey}, else {@code
   * defaultKey}.
   */
  @SuppressWarnings("unchecked")
  static String sdkKeyFor(Map<String, Object> wireCase, String defaultKey) {
    final Object pinned = ((Map<String, Object>) wireCase.get("given")).get("sdkKey");
    return pinned != null ? (String) pinned : defaultKey;
  }

  /**
   * The exact path the request must carry: the case's {@code requestPath} when it pins one, else
   * ConfigCat's {@code /configuration-files/<sdkKey>/config_v6.json}, which FR-001 sends verbatim
   * for a key that needs no escaping (the default key, a harness case id).
   */
  @SuppressWarnings("unchecked")
  static String requestPathFor(Map<String, Object> wireCase, String sdkKey) {
    final Map<String, Object> expected = (Map<String, Object>) wireCase.get("expected");
    return expected.containsKey("requestPath")
        ? (String) expected.get("requestPath")
        : "/configuration-files/" + sdkKey + "/config_v6.json";
  }

  /**
   * Judges one fetch against its case: the fields read, the request sent and the outcome. {@code
   * sent} is the one request the fetch made; the caller has already checked there was exactly one.
   */
  @SuppressWarnings("unchecked")
  static void assertWireCase(
      String id,
      Map<String, Object> wireCase,
      String sdkKey,
      SentRequest sent,
      ConfigFetcher.FetchResult result) {
    final Map<String, Object> given = (Map<String, Object>) wireCase.get("given");
    final Map<String, Object> expected = (Map<String, Object>) wireCase.get("expected");
    assertThat(KNOWN_GIVEN)
        .as("case %s carries a given field this consumer does not read", id)
        .containsAll(given.keySet());
    assertThat(KNOWN_EXPECTED)
        .as("case %s carries an expected field this consumer does not read", id)
        .containsAll(expected.keySet());

    // ---- Request-side assertions --------------------------------------
    // The path AS IT ARRIVED, byte for byte (#803): never a re-parsed URL,
    // so neither OkHttp re-encoding nor a decoding peer can hide a difference.
    assertThat(sent.path)
        .as("request path on the wire (case %s)", id)
        .isEqualTo(requestPathFor(wireCase, sdkKey));
    assertRequestUrlPrefix(id, given, expected, sdkKey);
    assertIfNoneMatch(id, sent.ifNoneMatch, expected);

    // ---- Outcome assertions -------------------------------------------
    if (expected.containsKey("hasConfig")) {
      assertThat(result.getBody() != null)
          .as("hasConfig (case %s)", id)
          .isEqualTo(expected.get("hasConfig"));
    }
    final String outcome = (String) expected.get("outcome");
    switch (outcome) {
      case "fetched":
        assertThat(result.getStatus())
            .as("outcome=fetched (case %s, error=%s)", id, result.getError())
            .isEqualTo(ConfigFetcher.Status.FETCHED);
        assertResultingEtag(id, expected, result);
        assertThat(result.getBody()).as("fetched outcome must populate body").isNotNull();
        assertThat(result.getRawBody()).as("fetched outcome must populate raw body").isNotNull();
        break;
      case "notModified":
        assertThat(result.getStatus())
            .as("outcome=notModified (case %s, error=%s)", id, result.getError())
            .isEqualTo(ConfigFetcher.Status.NOT_MODIFIED);
        assertResultingEtag(id, expected, result);
        assertThat(result.getBody()).as("notModified outcome must NOT carry a body").isNull();
        break;
      case "failed":
        assertThat(result.getStatus())
            .as("outcome=failed (case %s, error=%s)", id, result.getError())
            .isEqualTo(ConfigFetcher.Status.FAILED);
        final String expectedClass = (String) expected.get("errorClass");
        assertThat(javaErrorToClass(result.getError()))
            .as(
                "errorClass mapping for case %s (raw error=%s) MUST be %s",
                id, result.getError(), expectedClass)
            .isEqualTo(expectedClass);
        assertThat(result.getBody()).as("failed outcome must NOT carry a body").isNull();
        break;
      default:
        throw new IllegalStateException("unknown outcome: " + outcome);
    }
  }

  /**
   * Maps the fetcher's fixed reason codes onto the corpus's error-class vocabulary. FAILS CLOSED: a
   * code not listed here maps to {@code unmapped:<code>}, which no case expects — so a new or
   * renamed reason fails the suite instead of passing as {@code fetchFailed}.
   *
   * <ul>
   *   <li>{@code MALFORMED_JSON} / {@code EMPTY_BODY} → {@code parseFailed}
   *   <li>{@code HTTP 403} / {@code HTTP 404} / {@code INVALID_SDK_KEY} → {@code invalidSdkKey}
   *       (per ConfigCat only 403/404 are invalid-SDK-key statuses; 401 is retryable)
   *   <li>{@code timeout} → {@code timeout}
   *   <li>any other {@code HTTP <status>}, {@code network_error}, {@code body_read_failed}, {@code
   *       too_many_redirects}, {@code invalid_request} → {@code fetchFailed}
   * </ul>
   *
   * <p>Mirrors sdk-go's {@code goErrorToClass}.
   */
  static String javaErrorToClass(String reason) {
    if (reason == null) {
      return "unmapped:null";
    }
    switch (reason) {
      case "MALFORMED_JSON":
      case "EMPTY_BODY":
        return "parseFailed";
      case "HTTP 403":
      case "HTTP 404":
      case "INVALID_SDK_KEY":
        return "invalidSdkKey";
      case "timeout":
        return "timeout";
      case "network_error":
      case "body_read_failed":
      case "too_many_redirects":
      case "invalid_request":
        return "fetchFailed";
      default:
        return reason.startsWith("HTTP ") ? "fetchFailed" : "unmapped:" + reason;
    }
  }

  private static void assertResultingEtag(
      String id, Map<String, Object> expected, ConfigFetcher.FetchResult result) {
    final Object resultingEtag = expected.get("resultingEtag");
    if (resultingEtag != null) {
      assertThat(result.getEtag()).as("resultingEtag (case %s)", id).isEqualTo(resultingEtag);
    }
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
   * The corpus's three-state If-None-Match: absent (not asserted), explicit {@code null} (MUST NOT
   * be sent), a string (MUST equal). Jackson decodes absent and explicit-null alike, so the key's
   * presence is checked separately.
   */
  private static void assertIfNoneMatch(String id, String actual, Map<String, Object> expected) {
    if (!expected.containsKey("requestHeaderIfNoneMatch")) {
      return;
    }
    final Object value = expected.get("requestHeaderIfNoneMatch");
    if (value == null) {
      assertThat(actual).as("If-None-Match MUST NOT be sent (case %s)", id).isNull();
    } else {
      assertThat(actual).as("If-None-Match round-trip (case %s)", id).isEqualTo(value);
    }
  }
}
