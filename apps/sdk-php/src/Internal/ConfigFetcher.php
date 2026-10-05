<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\Exception\TooManyRedirectsException;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * HTTP layer for fetching `config_v6.json` from a Confeature CDN.
 *
 * Wraps Guzzle with:
 *   - User-Agent: `confeature-php-sdk/{VERSION}` (FR-012).
 *   - If-None-Match support for 304 reuse (FR-011).
 *   - Configurable request timeout (default 30 s).
 *   - SDK key redaction in every log line (FR-013): the raw key is
 *     NEVER interpolated into messages; `SdkKey::redact` is the only
 *     path.
 *   - Key-free failures (#803 FR-002): the request URL carries the SDK
 *     key (ConfigCat's wire path), and a library exception message may
 *     quote that URL, so every transport / body error is reduced to a
 *     FIXED reason code (`classifyError`) before it reaches a log line or
 *     `FetchResult::$error`. An exception message is never passed on.
 *
 * `FetchResult::$status` is one of:
 *   - `FetchResult::STATUS_FETCHED`      — HTTP 200, fresh body + new ETag.
 *   - `FetchResult::STATUS_NOT_MODIFIED` — HTTP 304, caller keeps cached body.
 *   - `FetchResult::STATUS_FAILED`       — network error / non-2xx / timeout.
 */
final class ConfigFetcher
{
    public const DEFAULT_BASE_URL = 'https://cdn-global.confeature.io';

    /** Fixed, key-free failure reasons (#803 FR-002). */
    public const REASON_TIMEOUT = 'timeout';
    public const REASON_CONNECT_FAILED = 'connect_failed';
    public const REASON_TOO_MANY_REDIRECTS = 'too_many_redirects';
    public const REASON_REQUEST_FAILED = 'request_failed';
    public const REASON_BODY_READ_FAILED = 'body_read_failed';

    private readonly string $sdkKey;
    private readonly LoggerInterface $logger;
    private readonly string $userAgent;
    /** The config URL, or null when the key cannot be a path segment. */
    private readonly ?string $url;
    private readonly float $timeout;
    private readonly ClientInterface $http;

    public function __construct(
        string $sdkKey,
        string $version,
        ?LoggerInterface $logger = null,
        ?string $baseUrl = null,
        float $requestTimeoutSeconds = 30.0,
        ?ClientInterface $httpClient = null,
    ) {
        if ($requestTimeoutSeconds <= 0) {
            throw new \InvalidArgumentException(
                'requestTimeoutSeconds must be > 0; got ' . $requestTimeoutSeconds
            );
        }

        $this->sdkKey = $sdkKey;
        $this->logger = $logger ?? new NullLogger();
        $this->timeout = $requestTimeoutSeconds;
        $this->userAgent = 'confeature-php-sdk/' . $version;

        $this->url = self::buildConfigUrl(rtrim($baseUrl ?? self::DEFAULT_BASE_URL, '/'), $sdkKey);

        $this->http = $httpClient ?? new GuzzleClient([
            'timeout' => $this->timeout,
            'connect_timeout' => $this->timeout,
            'http_errors' => false,
        ]);
    }

    /**
     * The ONE place the config URL is built (#803 FR-001), so the version
     * carrier (#807) lands here only. It is ConfigCat's wire path,
     * `<base>/configuration-files/<sdkKey>/config_v6.json` — upstream
     * configcat/configcat-php-sdk `src/ConfigFetcher.php` builds
     * `sprintf('configuration-files/%s/' . self::CONFIG_JSON_NAME, $sdkKey)`
     * with the raw key.
     *
     *   - A well-shaped key (`SdkKey::isValidConfeatureKeyFormat`) travels
     *     RAW: its `/`-separated parts each path-segment-escaped (a no-op
     *     for a valid key). A ConfigCat-shaped key is three segments.
     *   - Any other key is escaped into ONE segment (the SDK is lenient at
     *     construction), so a `/`, `?` or `#` in it cannot leave it.
     *   - `""`, `.` and `..` cannot be one segment — no escaper keeps them
     *     in place — so the result is null and the fetcher requests nothing.
     *
     * Escaping is Go's `url.PathEscape` exactly (`pathEscape`), NOT
     * `rawurlencode` (which escapes `$ & + : = @`).
     *
     * No version prefix, no cache-key tail: the derived cache key stays a local
     * cache id only.
     */
    public static function buildConfigUrl(string $baseUrl, string $sdkKey): ?string
    {
        if (SdkKey::isValidConfeatureKeyFormat($sdkKey)) {
            $keyPath = implode('/', array_map(self::pathEscape(...), explode('/', $sdkKey)));
        } else {
            if ($sdkKey === '' || $sdkKey === '.' || $sdkKey === '..') {
                return null;
            }
            $keyPath = self::pathEscape($sdkKey);
        }

        return $baseUrl . '/configuration-files/' . $keyPath . '/config_v6.json';
    }

    /**
     * Go's `url.PathEscape` (#803 FR-001): keep `A-Z a-z 0-9 - _ . ~` and
     * `$ & + : = @`; every other BYTE (so each UTF-8 byte of a non-ASCII
     * character) becomes `%XX`, uppercase hex. Byte-oriented (no `/u`), so
     * an invalid UTF-8 key escapes too instead of failing.
     */
    private static function pathEscape(string $segment): string
    {
        return (string) preg_replace_callback(
            '/[^A-Za-z0-9\-_.~$&+:=@]/',
            static fn (array $m): string => sprintf('%%%02X', \ord($m[0])),
            $segment,
        );
    }

    /**
     * The full config URL, or null when the key cannot be a path segment
     * (the fetcher then refuses to fetch).
     */
    public function getUrl(): ?string
    {
        return $this->url;
    }

    public function getUserAgent(): string
    {
        return $this->userAgent;
    }

    /**
     * Fetch the config. Never raises — fail-closed.
     */
    public function fetch(?string $etag = null): FetchResult
    {
        if ($this->url === null) {
            $this->logger->error(sprintf(
                'ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path segment; not fetching (sdkKey=%s)',
                SdkKey::redact($this->sdkKey),
            ));

            return new FetchResult(FetchResult::STATUS_FAILED, error: 'INVALID_SDK_KEY');
        }

        $headers = [
            'User-Agent' => $this->userAgent,
            'Accept' => 'application/json',
        ];
        if ($etag !== null && $etag !== '') {
            $headers['If-None-Match'] = $etag;
        }

        try {
            $response = $this->http->request('GET', $this->url, [
                'headers' => $headers,
                'timeout' => $this->timeout,
                'connect_timeout' => $this->timeout,
                'http_errors' => false,
            ]);
        } catch (\Throwable $e) {
            // The exception message may quote the URL — which holds the
            // key — so only a fixed reason code goes on.
            return $this->fail('request failed', self::classifyError($e));
        }

        return $this->parse($response);
    }

    public function close(): void
    {
        // No persistent connection in v1 — Guzzle's underlying handler
        // closes per-request. Method retained for API symmetry with
        // the other SDKs.
    }

    /**
     * Log a failure with a fixed reason code and return the failed result.
     */
    private function fail(string $stage, string $reason): FetchResult
    {
        $this->logger->error(sprintf(
            'ConfigFetcher: %s for sdkKey=%s reason=%s',
            $stage,
            SdkKey::redact($this->sdkKey),
            $reason,
        ));

        return new FetchResult(FetchResult::STATUS_FAILED, error: $reason);
    }

    /**
     * Reduce a transport / body error to a FIXED, key-free reason code
     * (#803 FR-002; sdk-go's `classifyError`). The message is inspected
     * only to recognise a timeout — it is never returned or logged.
     *
     * Guzzle buffers the body inside the transport (no `stream` option),
     * so a connection dropped mid-body surfaces from `request()` as a
     * `RequestException` that already carries the response headers (cURL
     * errno 18 / 56). That is a body-read failure — sdk-go's
     * `io.ReadAll` error, `body_read_failed` — not a request failure.
     */
    private static function classifyError(\Throwable $e, string $fallback = self::REASON_REQUEST_FAILED): string
    {
        if ($e instanceof TooManyRedirectsException) {
            return self::REASON_TOO_MANY_REDIRECTS;
        }
        if ($e instanceof ConnectException || $e instanceof RequestException) {
            $errno = $e->getHandlerContext()['errno'] ?? null;
            if ($errno === 28 || preg_match('/timed out|timeout/i', $e->getMessage()) === 1) {
                return self::REASON_TIMEOUT;
            }
            if ($e instanceof ConnectException) {
                return self::REASON_CONNECT_FAILED;
            }
            if ($e->getResponse() !== null) {
                return self::REASON_BODY_READ_FAILED;
            }

            return $fallback;
        }

        return $fallback;
    }

    private function parse(ResponseInterface $response): FetchResult
    {
        $status = $response->getStatusCode();
        $etagHeader = $response->getHeaderLine('ETag');
        $etag = $etagHeader === '' ? null : $etagHeader;

        if ($status === 304) {
            return new FetchResult(FetchResult::STATUS_NOT_MODIFIED, etag: $etag);
        }

        if ($status < 200 || $status >= 300) {
            $reason = 'HTTP ' . $status;
            $this->logger->error(sprintf(
                'ConfigFetcher: fetch failed for sdkKey=%s reason=%s',
                SdkKey::redact($this->sdkKey),
                $reason,
            ));

            return new FetchResult(FetchResult::STATUS_FAILED, error: $reason);
        }

        // Read the body FIRST so a transport/body-read failure (e.g. a
        // connection reset mid-response) classifies as a fetch failure,
        // NOT a parse failure — a truncated body is a network error, not a
        // JSON-shape error. Mirrors the JS shared fetcher's read-then-parse
        // split and the sdk-go io.ReadAll-then-Unmarshal fix; the
        // wire-cases `network-reset` case (#490) pins this.
        try {
            $bodyString = $response->getBody()->getContents();
        } catch (\Throwable $e) {
            return $this->fail('body read failed', self::classifyError($e, self::REASON_BODY_READ_FAILED));
        }

        $decoded = json_decode($bodyString, true);
        if (!\is_array($decoded)) {
            $this->logger->error(sprintf(
                'ConfigFetcher: fetch returned non-object JSON for sdkKey=%s',
                SdkKey::redact($this->sdkKey),
            ));

            return new FetchResult(FetchResult::STATUS_FAILED, error: 'MALFORMED_JSON');
        }

        // Shape guard: a well-formed config_v6.json carries an `f` key
        // (the flag map). Without this check, 200 responses that parse
        // as JSON but don't match the {p, f, s} shape (e.g. `{"foo":
        // "bar"}`) would silently classify as `fetched` and break
        // Principle II parity with sdk-node / sdk-python / sdk-go /
        // sdk-rust / sdk-java. See spec 112 / corpus case
        // `wrong-shape-200`.
        if (!\array_key_exists('f', $decoded)) {
            $this->logger->error(sprintf(
                'ConfigFetcher: fetch returned JSON without `f` key for sdkKey=%s',
                SdkKey::redact($this->sdkKey),
            ));

            return new FetchResult(FetchResult::STATUS_FAILED, error: 'MALFORMED_JSON');
        }

        return new FetchResult(
            FetchResult::STATUS_FETCHED,
            body: $decoded,
            etag: $etag,
        );
    }
}
