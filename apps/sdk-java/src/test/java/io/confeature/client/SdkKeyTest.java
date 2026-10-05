// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.SdkKey;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

final class SdkKeyTest {

  private static final String VALID_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /** A ConfigCat-shaped key (#802) — an obvious fake (#858), belongs to no environment. */
  private static final String NEW_SHAPE_KEY =
      "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";

  private static final ObjectMapper MAPPER = new ObjectMapper();

  @SuppressWarnings("unchecked")
  private static Stream<Map<String, String>> shapes(String bucket) throws Exception {
    final Map<String, Object> doc =
        MAPPER.readValue(Files.readAllBytes(WorkspaceRoot.sdkKeyShapesPath()), Map.class);
    final List<Map<String, String>> list = (List<Map<String, String>>) doc.get(bucket);
    assertThat(list).as("sdk-key-shapes.json '%s' list", bucket).isNotEmpty();
    return list.stream();
  }

  static Stream<Map<String, String>> validShapes() throws Exception {
    return shapes("valid");
  }

  static Stream<Map<String, String>> invalidShapes() throws Exception {
    return shapes("invalid");
  }

  @ParameterizedTest(name = "[{index}] valid: {0}")
  @MethodSource("validShapes")
  void isValidConfeatureKeyFormat_acceptsEverySharedValidShape(Map<String, String> entry) {
    assertThat(SdkKey.isValidConfeatureKeyFormat(entry.get("key")))
        .as("sdk-key-shapes.json valid case '%s'", entry.get("name"))
        .isTrue();
  }

  @ParameterizedTest(name = "[{index}] invalid: {0}")
  @MethodSource("invalidShapes")
  void isValidConfeatureKeyFormat_rejectsEverySharedInvalidShape(Map<String, String> entry) {
    assertThat(SdkKey.isValidConfeatureKeyFormat(entry.get("key")))
        .as("sdk-key-shapes.json invalid case '%s'", entry.get("name"))
        .isFalse();
  }

  @Test
  void isValidConfeatureKeyFormat_rejectsTrailingNewline() {
    // Java's Pattern `$` can match before a final line terminator; matches() must still reject it.
    assertThat(SdkKey.isValidConfeatureKeyFormat(NEW_SHAPE_KEY + "\n")).isFalse();
    assertThat(SdkKey.isValidConfeatureKeyFormat(VALID_KEY + "\n")).isFalse();
  }

  @Test
  void isValidConfeatureKeyFormat_matchesCanonical() {
    assertThat(SdkKey.isValidConfeatureKeyFormat(VALID_KEY)).isTrue();
  }

  @Test
  void isValidConfeatureKeyFormat_rejectsNull() {
    assertThat(SdkKey.isValidConfeatureKeyFormat(null)).isFalse();
  }

  @Test
  void isValidConfeatureKeyFormat_rejectsEmpty() {
    assertThat(SdkKey.isValidConfeatureKeyFormat("")).isFalse();
  }

  @Test
  void isValidConfeatureKeyFormat_rejectsTruncated() {
    assertThat(SdkKey.isValidConfeatureKeyFormat("confeature-sdk-1-AAA")).isFalse();
  }

  @Test
  void redact_emptyReturnsRedactedSentinel() {
    assertThat(SdkKey.redact("")).isEqualTo("[redacted]");
  }

  @Test
  void redact_nullReturnsRedactedSentinel() {
    assertThat(SdkKey.redact(null)).isEqualTo("[redacted]");
  }

  @Test
  void redact_shortKeyReturnsSentinel() {
    assertThat(SdkKey.redact("short")).isEqualTo("[redacted]");
  }

  @Test
  void redact_neverContainsRawKey() {
    final String redacted = SdkKey.redact(VALID_KEY);
    assertThat(redacted).contains("[redacted]");
    // Middle of the key MUST be masked.
    final String middle = VALID_KEY.substring(20, VALID_KEY.length() - 20);
    assertThat(redacted).doesNotContain(middle);
  }

  @Test
  void redact_keepsHeadAndTailVisible() {
    final String redacted = SdkKey.redact(VALID_KEY);
    final int visible = Math.max(4, VALID_KEY.length() / 10);
    assertThat(redacted).startsWith(VALID_KEY.substring(0, visible));
    assertThat(redacted).endsWith(VALID_KEY.substring(VALID_KEY.length() - visible));
  }

  @Test
  void redact_newShapeShowsNoMoreSecretThanLegacy() {
    final String redacted = SdkKey.redact(NEW_SHAPE_KEY);
    final String[] segments = NEW_SHAPE_KEY.split("/");
    assertThat(segments).hasSize(3);
    assertThat(redacted).contains("[redacted]");
    // Neither secret segment appears whole; the head carries no secret characters.
    assertThat(redacted).doesNotContain(segments[1]).doesNotContain(segments[2]);
    assertThat(redacted).startsWith("config…[redacted]…");
    // Tail: 6 secret characters (a legacy 82-char key shows 8).
    assertThat(redacted).endsWith(segments[2].substring(segments[2].length() - 6));
    assertThat(redacted)
        .isEqualTo("config…[redacted]…" + NEW_SHAPE_KEY.substring(NEW_SHAPE_KEY.length() - 6));
  }

  @Test
  void deriveCacheKey_newShapeHashesSlashAsPlainByte() {
    // Cross-language value pinned by cache-key-fixtures.json; the `/` is never escaped/stripped.
    assertThat(
            SdkKey.deriveCacheKey("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"))
        .isEqualTo("confeature:cache:v1:SqU9woq8Xp72crnJnqAuccVvuDENt176");
  }

  @Test
  void deriveCacheKey_envelopeFormat() {
    final String cacheKey = SdkKey.deriveCacheKey(VALID_KEY);
    assertThat(cacheKey).startsWith("confeature:cache:v1:");
    assertThat(cacheKey).hasSize("confeature:cache:v1:".length() + 32);
  }

  @Test
  void deriveCacheKey_isDeterministic() {
    assertThat(SdkKey.deriveCacheKey(VALID_KEY)).isEqualTo(SdkKey.deriveCacheKey(VALID_KEY));
  }

  @Test
  void deriveCacheKey_throwsOnNull() {
    assertThatThrownBy(() -> SdkKey.deriveCacheKey(null)).isInstanceOf(NullPointerException.class);
  }

  @Test
  void cacheKeyTail_stripsEnvelopePrefix() {
    final String cacheKey = SdkKey.deriveCacheKey(VALID_KEY);
    final String tail = SdkKey.cacheKeyTail(cacheKey);
    assertThat(tail).hasSize(32).doesNotContain(":");
  }
}
