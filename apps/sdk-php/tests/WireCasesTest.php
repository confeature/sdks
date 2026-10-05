<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\ConfigFetcher;
use Confeature\Internal\FetchResult;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\FnStream;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\Utils;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * Wire-protocol fixture suite (PHP consumer).
 *
 * Drives `Confeature\Internal\ConfigFetcher` against each case in
 * `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
 * corpus is the language-agnostic contract; this file is the PHP
 * consumer that maps PHP's `FetchResult` shape onto the corpus's
 * normalised `{fetched, notModified, failed}` x
 * `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.
 *
 * Mirrors the shipped consumers in apps/sdk-node, apps/sdk-python,
 * apps/sdk-go, apps/sdk-rust, apps/sdk-dotnet and apps/sdk-java —
 * Principle II (NON-NEGOTIABLE) requires byte-identical wire-vocabulary
 * classification across every SDK. The constitutional remedy for a
 * divergence is to fix the SDK, never the corpus.
 *
 * Each case may carry a `server.behavior` discriminator (#490):
 * "respond" (default/absent) delivers the canned status+headers+body;
 * "timeout" raises a Guzzle ConnectException (the SDK's request-timeout
 * path → timeout class); "close-mid-response" delivers a 200 whose body
 * stream drops mid-read (a transport failure → fetchFailed, NOT
 * parseFailed). An unrecognised behaviour FAILS the case loudly —
 * :func:`buildTransportItem` never falls through to the respond path.
 *
 * The PHP SDK encodes its failure reason as a string in
 * `FetchResult::$error` (no typed enum yet); :func:`mapErrorToClass`
 * maps that back onto the corpus's vocabulary. When a future revision
 * of `ConfigFetcher` switches to a typed enum, update the mapping
 * accordingly.
 *
 * See epic #146 (contract testing framework) + #148 slice 8 (this
 * suite) + spec 112.
 */
final class WireCasesTest extends TestCase
{
    /**
     * Every `given` / `expected` field this consumer reads (#803 FR-003).
     * A case carrying any other field FAILS — a new expectation can never
     * be skipped silently. Add a field here only together with the code
     * that asserts it.
     */
    private const KNOWN_GIVEN_FIELDS = ['previousEtag', 'baseUrl', 'sdkKey'];
    private const KNOWN_EXPECTED_FIELDS = [
        'requestHeaderIfNoneMatch',
        'requestUrlPrefix',
        'requestPath',
        'outcome',
        'resultingEtag',
        'hasConfig',
        'errorClass',
    ];

    private const DEFAULT_BASE_URL = 'https://cdn.example.test';

    /** @var list<array<string, mixed>> Mutated by Guzzle's history middleware. */
    private array $history = [];

    protected function setUp(): void
    {
        $this->history = [];
    }

    /**
     * @return iterable<string, array{0: array<string, mixed>}>
     */
    public static function wireCases(): iterable
    {
        $path = WorkspaceRoot::fixturePath('wire-cases.json');
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('Cannot read wire-cases.json at ' . $path);
        }
        $data = json_decode($raw, true);
        if (!\is_array($data) || !isset($data['cases']) || !\is_array($data['cases'])) {
            throw new \RuntimeException('wire-cases.json must be { cases: [...] }');
        }

        foreach ($data['cases'] as $case) {
            if (!\is_array($case) || !\is_string($case['id'] ?? null)) {
                throw new \RuntimeException('wire-cases.json carries a malformed case');
            }
            yield $case['id'] => [$case];
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    #[DataProvider('wireCases')]
    public function testWireCase(array $case): void
    {
        /** @var array<string, mixed> $given */
        $given = $case['given'];
        /** @var array<string, mixed> $server */
        $server = $case['server'];
        /** @var array<string, mixed> $expected */
        $expected = $case['expected'];

        // Build the queued transport item for this case. `server.behavior`
        // (#490) selects how the mock transport acts:
        //   - "respond" (default/absent) — deliver status + headers + body.
        //   - "timeout"                   — raise a Guzzle ConnectException
        //                                   carrying a cURL timeout message,
        //                                   exactly as Guzzle surfaces a
        //                                   request that exceeds the SDK's
        //                                   configured timeout → timeout class.
        //   - "close-mid-response"        — deliver a 200 whose body stream
        //                                   throws mid-read (a dropped socket /
        //                                   truncated body) → the fetcher's
        //                                   read-then-parse split classifies
        //                                   this as fetchFailed, NOT parseFailed.
        // An unrecognised value FAILS the case loudly — it MUST NEVER fall
        // through to the respond path.
        $unknownGiven = array_values(array_diff(array_keys($given), self::KNOWN_GIVEN_FIELDS));
        self::assertSame([], $unknownGiven, 'wire case carries given fields this consumer does not read');
        $unknownExpected = array_values(array_diff(array_keys($expected), self::KNOWN_EXPECTED_FIELDS));
        self::assertSame([], $unknownExpected, 'wire case carries expected fields this consumer does not read');

        $behavior = $server['behavior'] ?? 'respond';
        $queued = self::buildTransportItem((string) $behavior, $server);

        $baseUrl = $given['baseUrl'] ?? self::DEFAULT_BASE_URL;
        $sdkKey = $given['sdkKey'] ?? WorkspaceRoot::SAMPLE_SDK_KEY;
        self::assertIsString($baseUrl);
        self::assertIsString($sdkKey);
        $fetcher = $this->buildFetcher([$queued], $baseUrl, $sdkKey);

        /** @var string|null $prevEtag */
        $prevEtag = $given['previousEtag'] ?? null;
        $result = $fetcher->fetch($prevEtag);
        $fetcher->close();

        // ---- Request-side assertions ------------------------------------
        self::assertCount(
            1,
            $this->history,
            'Fetcher MUST issue exactly one HTTP request per fetch',
        );
        /** @var Request $request */
        $request = $this->history[0]['request'];

        // Request URL (#803 FR-001/FR-003): ConfigCat's path,
        // `<base>/configuration-files/<sdkKey>/config_v6.json`, the key in
        // RAW for a well-shaped key — as upstream configcat-php-sdk sends
        // it. `requestPath` is compared to the PARSED path (query
        // excluded, #807); `requestUrlPrefix` to the full URL.
        $uri = $request->getUri();
        self::assertStringStartsWith('/configuration-files/', $uri->getPath());
        self::assertStringEndsWith('/config_v6.json', $uri->getPath());
        self::assertStringNotContainsString('/v2/', $uri->getPath());
        if (\array_key_exists('requestPath', $expected)) {
            self::assertSame($expected['requestPath'], $uri->getPath(), 'request path');
        }
        if (\array_key_exists('requestUrlPrefix', $expected)) {
            self::assertIsString($expected['requestUrlPrefix']);
            self::assertStringStartsWith($expected['requestUrlPrefix'], (string) $uri, 'request URL prefix');
        }

        // If-None-Match header round-trip. Three-state semantics:
        // absent key  -> don't assert (no current corpus case omits it
        //                from the fetched/notModified branches), explicit
        // null        -> header MUST NOT be sent,
        // string      -> header MUST equal that string.
        if (\array_key_exists('requestHeaderIfNoneMatch', $expected)) {
            $ifNoneMatch = $expected['requestHeaderIfNoneMatch'];
            $actual = $request->getHeaderLine('If-None-Match');
            if ($ifNoneMatch === null) {
                self::assertSame(
                    '',
                    $actual,
                    'Case with previousEtag=null MUST NOT send an If-None-Match header',
                );
            } else {
                self::assertSame($ifNoneMatch, $actual);
            }
        }

        // ---- Outcome assertions -----------------------------------------
        // hasConfig: whether this fetch yielded a config body.
        if (\array_key_exists('hasConfig', $expected)) {
            self::assertSame($expected['hasConfig'], $result->body !== null, 'hasConfig');
        }
        $outcome = $expected['outcome'];
        if ($outcome === 'fetched') {
            self::assertSame(
                FetchResult::STATUS_FETCHED,
                $result->status,
                sprintf(
                    "Expected 'fetched', got status=%s error=%s",
                    var_export($result->status, true),
                    var_export($result->error, true),
                ),
            );
            self::assertNotNull($result->body, 'Body must be populated on fetched outcome');
            if (($expected['resultingEtag'] ?? null) !== null) {
                self::assertSame($expected['resultingEtag'], $result->etag);
            }
        } elseif ($outcome === 'notModified') {
            // PHP returns status='not_modified' (snake_case) where the
            // corpus uses 'notModified' (camelCase) as canonical — each
            // consumer maps to its own.
            self::assertSame(
                FetchResult::STATUS_NOT_MODIFIED,
                $result->status,
                sprintf(
                    "Expected 'not_modified', got status=%s error=%s",
                    var_export($result->status, true),
                    var_export($result->error, true),
                ),
            );
            self::assertNull($result->body, 'Body must be null on not_modified');
            if (($expected['resultingEtag'] ?? null) !== null) {
                self::assertSame($expected['resultingEtag'], $result->etag);
            }
        } elseif ($outcome === 'failed') {
            self::assertSame(
                FetchResult::STATUS_FAILED,
                $result->status,
                sprintf(
                    "Expected 'failed', got status=%s body=%s",
                    var_export($result->status, true),
                    var_export($result->body, true),
                ),
            );
            self::assertNull($result->body, 'Body must be null on failed');
            $mapped = self::mapErrorToClass($result->error);
            self::assertSame(
                $expected['errorClass'],
                $mapped,
                sprintf(
                    'Case %s: expected errorClass=%s, got mapped=%s from raw error=%s',
                    (string) $case['id'],
                    var_export($expected['errorClass'], true),
                    var_export($mapped, true),
                    var_export($result->error, true),
                ),
            );
        } else {
            self::fail('Unknown outcome value in corpus: ' . var_export($outcome, true));
        }
    }

    // ----- helpers --------------------------------------------------------

    /**
     * Resolve the server response body — `bodyRef` points to a sibling
     * fixture JSON; `body` is a raw string (used for malformed
     * payloads). Either may be absent (e.g. 304 has no body).
     *
     * @param array<string, mixed> $server
     */
    private static function resolveBody(array $server): ?string
    {
        if (isset($server['bodyRef']) && \is_string($server['bodyRef'])) {
            $path = WorkspaceRoot::fixturePath($server['bodyRef']);
            $raw = file_get_contents($path);
            if ($raw === false) {
                throw new \RuntimeException('Cannot read bodyRef fixture ' . $server['bodyRef']);
            }

            return $raw;
        }
        if (isset($server['body']) && \is_string($server['body'])) {
            return $server['body'];
        }

        return null;
    }

    /**
     * Map PHP's stringly-typed `FetchResult::$error` onto the corpus's
     * normalised error-class vocabulary. Mirrors `_python_error_to_class`
     * (sdk-python) and `goErrorToClass` (sdk-go).
     *
     * NOTE: HTTP 403 and 404 both map to `invalidSdkKey` to match the
     * corpus's intent — per ConfigCat only 403/404 are invalid-SDK-key
     * statuses (401 is a generic retryable failure). Tightening this into
     * a typed enum on the SDK itself is tracked as a follow-up to #146.
     */
    private static function mapErrorToClass(?string $error): string
    {
        if ($error === null) {
            return 'fetchFailed';
        }
        if ($error === 'MALFORMED_JSON') {
            return 'parseFailed';
        }
        if ($error === 'HTTP 403' || $error === 'HTTP 404') {
            return 'invalidSdkKey';
        }
        if (str_starts_with($error, 'HTTP ')) {
            return 'fetchFailed';
        }
        // The fetcher reduces a cURL "Operation timed out" transfer error
        // to the fixed key-free reason `timeout` (#803 FR-002), which
        // routes to the corpus `timeout` class — distinct from a generic
        // fetchFailed. The wire-cases `timeout` case (#490) pins this.
        // Keeps parity with sdk-python / sdk-go.
        if ($error === ConfigFetcher::REASON_TIMEOUT) {
            return 'timeout';
        }

        return 'fetchFailed';
    }

    /**
     * Translate a corpus `server.behavior` discriminator into the item
     * Guzzle's MockHandler should serve: a `Response` for the normal
     * respond path, or a `\Throwable` for the failure behaviours
     * (MockHandler throws any queued throwable). Mirrors the sdk-go
     * behaviour adapter (commit a804507) — an unknown behaviour FAILS
     * loudly and NEVER falls through to the respond path.
     *
     * @param array<string, mixed> $server
     */
    private static function buildTransportItem(string $behavior, array $server): Response|\Throwable
    {
        switch ($behavior) {
            case 'respond':
                /** @var array<string, string> $headers */
                $headers = $server['headers'] ?? [];

                return new Response(
                    (int) $server['status'],
                    $headers,
                    self::resolveBody($server),
                );

            case 'timeout':
                // Guzzle surfaces a request that exceeds the configured
                // timeout as a ConnectException carrying a cURL "Operation
                // timed out" message. The fetcher classifies it as the fixed
                // reason `timeout`; mapErrorToClass routes that to `timeout`.
                return new ConnectException(
                    'cURL error 28: Operation timed out after 1000 milliseconds',
                    new Request('GET', 'https://cdn.example.test'),
                );

            case 'close-mid-response':
                // A 200 whose body stream throws mid-read: the socket drops
                // after the headers + the first body bytes. The fetcher reads
                // the body BEFORE parsing, so getContents() throwing classes
                // this as fetchFailed, NOT parseFailed — a truncated body is a
                // transport failure, not a JSON-shape error.
                /** @var array<string, string> $closeHeaders */
                $closeHeaders = $server['headers'] ?? [];
                $stream = FnStream::decorate(
                    Utils::streamFor('{"p":{"s":"partial'),
                    [
                        'getContents' => static function (): string {
                            throw new \RuntimeException(
                                'connection reset mid-response (truncated body)',
                            );
                        },
                        'read' => static function (int $length): string {
                            throw new \RuntimeException(
                                'connection reset mid-response (truncated body)',
                            );
                        },
                    ],
                );

                return new Response((int) $server['status'], $closeHeaders, $stream);

            default:
                throw new \RuntimeException(sprintf(
                    'wire-cases: unsupported server.behavior %s — no adapter',
                    var_export($behavior, true),
                ));
        }
    }

    /**
     * @param list<Response|\Throwable> $responses
     */
    private function buildFetcher(array $responses, string $baseUrl, string $sdkKey): ConfigFetcher
    {
        $mock = new MockHandler($responses);
        $stack = HandlerStack::create($mock);
        $stack->push(Middleware::history($this->history));
        $client = new GuzzleClient(['handler' => $stack]);

        return new ConfigFetcher(
            sdkKey: $sdkKey,
            version: '0.0.0-wire-test',
            logger: new NullLogger(),
            baseUrl: $baseUrl,
            requestTimeoutSeconds: 1.0,
            httpClient: $client,
        );
    }
}
