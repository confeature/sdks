// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.Logger;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Test-only window onto the URL a {@link ConfigFetcher} puts on the wire. {@code getUrl()} is
 * package-private (the URL carries the SDK key, so no public member hands it out); a test outside
 * this package reads the request URL here instead — the one OkHttp actually issues, captured by an
 * interceptor through the package-private seam and answered locally, so no network is touched.
 *
 * <p>Lives in the test source set only; it never ships in the jar.
 */
public final class ConfigFetcherProbe {

  private ConfigFetcherProbe() {}

  /**
   * The URL a fetcher built from {@code baseUrl} and {@code sdkKey} requests, or {@code null} when
   * it requests nothing.
   */
  public static String requestedUrl(String baseUrl, String sdkKey, Logger logger) {
    final AtomicReference<String> seen = new AtomicReference<>();
    try (ConfigFetcher fetcher =
        new ConfigFetcher(
            baseUrl,
            sdkKey,
            Duration.ofSeconds(5),
            logger,
            chain -> {
              seen.set(chain.request().url().toString());
              return new Response.Builder()
                  .request(chain.request())
                  .protocol(Protocol.HTTP_1_1)
                  .code(304)
                  .message("Not Modified")
                  .body(ResponseBody.create(new byte[0], null))
                  .build();
            })) {
      fetcher.fetch("");
    }
    return seen.get();
  }
}
