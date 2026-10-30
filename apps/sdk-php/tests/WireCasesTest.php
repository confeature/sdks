<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\ConfigFetcher;
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
 * `FetchResult::$error` (no typed enum yet). What a case's `expected`
 * block means — the request side, the outcome side and the error-class
 * mapping — lives in `WireCaseAssertions`, shared with the live suite
 * (`WireCasesLiveTest`, #920) so both are judged by the same rules.
 *
 * See epic #146 (contract testing framework) + #148 slice 8 (this
 * suite) + spec 112.
 */
final class WireCasesTest extends TestCase
{
    use WireCaseAssertions;

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
        foreach (self::loadWireCases() as $id => $case) {
            yield $id => [$case];
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    /**
     * A pending case is reported by name, never dropped (1.4, #994); its
     * proof (this reader still cannot read it) runs in loadWireCases.
     */
    public function testPendingWireCasesAreNamed(): void
    {
        $pending = self::pendingWireCases();
        self::loadWireCases();
        if ($pending === []) {
            self::assertSame([], $pending);

            return;
        }
        self::markTestSkipped('pending: ' . implode(', ', array_map(
            static fn (string $id, string $ticket): string => "{$id} ({$ticket})",
            array_keys($pending),
            $pending,
        )));
    }

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
        self::assertKnownWireFields($case);

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

        // The request side (#803 FR-001/FR-003): `requestPath` against the
        // PARSED path (query excluded, #807), `requestUrlPrefix` against the
        // full URL, If-None-Match three-state — see WireCaseAssertions.
        $uri = $request->getUri();
        self::assertWireRequest(
            $case,
            $uri->getPath(),
            (string) $uri,
            $request->hasHeader('If-None-Match') ? $request->getHeaderLine('If-None-Match') : null,
            $sdkKey,
        );

        self::assertWireOutcome($case, $result);
    }

    // ----- helpers --------------------------------------------------------

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
