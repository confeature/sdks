// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.SdkKey;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Cross-language cache-key parity gate.
 *
 * <p>Loads every row of {@code cache-key-fixtures.json} (≥ 5 entries; no row count is hard-coded)
 * and asserts that the Java SDK's {@link SdkKey#deriveCacheKey(String)} produces the byte-identical
 * envelope every other SDK (TS / Python / Go / .NET / Rust / Ruby) produces. That includes the
 * ConfigCat-shaped {@code configcat-sdk-1/<22>/<22>} row (#802), whose {@code /} is hashed as a
 * plain byte.
 *
 * <p>Constitution Principle II NON-NEGOTIABLE: every entry MUST match. A single drift implies the
 * Java derivation has gone out of phase with the canonical TS implementation.
 */
final class CacheKeyFixturesTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  static Stream<Map<String, String>> entries() throws Exception {
    final byte[] raw = Files.readAllBytes(WorkspaceRoot.cacheKeyFixturesPath());
    @SuppressWarnings("unchecked")
    final List<Map<String, String>> list = MAPPER.readValue(raw, List.class);
    return list.stream();
  }

  @ParameterizedTest(name = "[{index}] sdkKey={0}")
  @MethodSource("entries")
  void deriveMatchesFixture(Map<String, String> entry) {
    final String sdkKey = entry.get("sdkKey");
    final String expected = entry.get("expectedCacheKey");
    final String actual = SdkKey.deriveCacheKey(sdkKey);
    assertThat(actual)
        .as(
            "Cache-key parity drift for sdkKey=%s — investigate SdkKey.deriveCacheKey, "
                + "do NOT mutate the fixture (Constitution Principle II is NON-NEGOTIABLE).",
            sdkKey)
        .isEqualTo(expected);
  }
}
