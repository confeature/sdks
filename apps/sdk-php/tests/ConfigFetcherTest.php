<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\ConfigFetcher;
use Confeature\Internal\FetchResult;
use Confeature\Internal\SdkKey;
use Confeature\Version;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\RequestInterface;
use Psr\Log\AbstractLogger;
use Stringable;

/**
 * Wire-level tests for `ConfigFetcher`.
 *
 * Network is never hit — we feed a `GuzzleHttp\Handler\MockHandler`
 * into the fetcher's `httpClient` option and assert against the
 * request history captured by `Middleware::history`.
 *
 * Two load-bearing invariants are checked on every failure path:
 *   1. The raw SDK key MUST never appear in any log message OR
 *      in the returned `error` string.
 *   2. The fetcher MUST classify each HTTP outcome into exactly
 *      one of `FetchResult::STATUS_FETCHED`, `STATUS_NOT_MODIFIED`,
 *      or `STATUS_FAILED`.
 */
final class ConfigFetcherTest extends TestCase
{
    /** @var list<array<string, mixed>> Mutated by Guzzle's history middleware. */
    private array $history = [];

    protected function setUp(): void
    {
        $this->history = [];
    }

    public function testFetchSuccessReturnsBodyAndEtag(): void
    {
        $body = ['f' => ['feature.dark' => ['t' => 0, 'v' => ['b' => true]]]];
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, ['ETag' => '"v1"'], (string) json_encode($body))],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FETCHED, $result->status);
        self::assertSame($body, $result->body);
        self::assertSame('"v1"', $result->etag);
        self::assertCount(1, $this->history);
        self::assertNull($result->error);
        self::assertSdkKeyNeverLogged($logger);
    }

    public function testUserAgentHeaderIsConfeaturePhpSdk(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, [], '{"f":{}}')],
        );
        $fetcher->fetch();

        /** @var Request $request */
        $request = $this->history[0]['request'];
        self::assertSame(
            'confeature-php-sdk/' . Version::SDK,
            $request->getHeaderLine('User-Agent'),
        );
    }

    public function testIfNoneMatchHeaderIsForwardedWhenEtagSupplied(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(304, ['ETag' => '"prev"'])],
        );

        $result = $fetcher->fetch('"prev"');

        /** @var Request $request */
        $request = $this->history[0]['request'];
        self::assertSame('"prev"', $request->getHeaderLine('If-None-Match'));
        self::assertSame(FetchResult::STATUS_NOT_MODIFIED, $result->status);
        self::assertSame('"prev"', $result->etag);
    }

    public function testNon2xxReturnsFailedWithHttpReason(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(500, [], 'boom')],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame('HTTP 500', $result->error);
        self::assertNotEmpty($logger->records);
        self::assertSdkKeyNeverLogged($logger, $result->error);
    }

    public function testMalformedJsonBodyReturnsFailed(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, [], 'not-json{')],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame('MALFORMED_JSON', $result->error);
        self::assertSdkKeyNeverLogged($logger, $result->error);
    }

    public function testNonObjectJsonReturnsFailed(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, [], '"top-level-string"')],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame('MALFORMED_JSON', $result->error);
    }

    public function testConnectExceptionReturnsFailedAndLogsError(): void
    {
        $logger = self::capturingLogger();
        $request = new Request('GET', 'https://example.invalid');
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new ConnectException('dns failure', $request)],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame(ConfigFetcher::REASON_CONNECT_FAILED, $result->error);
        self::assertTrue(self::hasErrorLog($logger));
        self::assertSdkKeyNeverLogged($logger, $result->error);
    }

    public function testGenericThrowableReturnsFailedAndLogs(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new \RuntimeException('boom-from-handler')],
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame(ConfigFetcher::REASON_REQUEST_FAILED, $result->error);
        self::assertSdkKeyNeverLogged($logger, $result->error);
    }

    /**
     * #803 FR-001/FR-004: a well-shaped key travels RAW in ConfigCat's
     * path — upstream configcat/configcat-php-sdk `src/ConfigFetcher.php`
     * builds `configuration-files/<sdkKey>/config_v6.json` from the raw
     * key. Asserted on the PARSED path of the recorded request, so a
     * future query string (#807) does not break it.
     *
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function wellShapedKeys(): iterable
    {
        yield 'legacy key, one segment' => [
            WorkspaceRoot::SAMPLE_SDK_KEY,
            '/configuration-files/' . WorkspaceRoot::SAMPLE_SDK_KEY . '/config_v6.json',
        ];
        yield 'ConfigCat-shaped key, raw three segments' => [
            WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY,
            '/configuration-files/configcat-sdk-1/CCCCCCCCCCCCCCCCCCCCCC/DDDDDDDDDDDDDDDDDDDDDD/config_v6.json',
        ];
    }

    #[DataProvider('wellShapedKeys')]
    public function testWellShapedKeyTravelsRawInConfigCatPath(string $key, string $expectedPath): void
    {
        $fetcher = $this->buildFetcher(
            logger: self::capturingLogger(),
            responses: [new Response(200, [], '{"f":{}}')],
            sdkKey: $key,
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FETCHED, $result->status);
        self::assertCount(1, $this->history);
        $uri = self::recordedRequest($this->history[0])->getUri();
        self::assertSame('cdn.example.test', $uri->getHost());
        self::assertSame($expectedPath, $uri->getPath());
        self::assertStringNotContainsString('/v2/', $uri->getPath());
        self::assertStringNotContainsString('%2F', $uri->getPath());
    }

    /**
     * #803 FR-001: a malformed key is escaped into ONE segment with Go's
     * `url.PathEscape` — it keeps `A-Z a-z 0-9 - _ . ~` and `$ & + : = @`,
     * every other byte becomes `%XX` (uppercase). Each expected value is a
     * LITERAL copied from real `go run` output of `url.PathEscape` (Go
     * 1.x, net/url), never computed with the code under test.
     *
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function malformedKeys(): iterable
    {
        yield 'corpus key: space, every reserved char, /, ?, #, %, trailing ..' => [
            "bad key$&+:=@,;!'()*~/x?y#z%..",
            'bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..',
        ];
        yield 'sub-delims $ & + : = @ and unreserved - _ . ~ kept' => [
            'k$&+:=@-_.~k',
            'k$&+:=@-_.~k',
        ];
        yield 'slash, query and fragment stay inside the segment' => [
            'not a/valid?key#x',
            'not%20a%2Fvalid%3Fkey%23x',
        ];
        yield 'non-ASCII: each UTF-8 byte escaped' => [
            "\u{43A}\u{43B}\u{44E}\u{447}/\u{E9}",
            '%D0%BA%D0%BB%D1%8E%D1%87%2F%C3%A9',
        ];
        yield 'NUL and an invalid UTF-8 byte' => [
            "a\x00b\xFFc",
            'a%00b%FFc',
        ];
        yield 'brackets, braces, pipe, backslash, caret, backtick, quote, angles' => [
            '[k]{v}|\\^`"<>',
            '%5Bk%5D%7Bv%7D%7C%5C%5E%60%22%3C%3E',
        ];
    }

    #[DataProvider('malformedKeys')]
    public function testMalformedKeyIsEscapedIntoOneSegmentAsGoPathEscape(string $key, string $goEscaped): void
    {
        self::assertFalse(SdkKey::isValidConfeatureKeyFormat($key));
        $fetcher = $this->buildFetcher(
            logger: self::capturingLogger(),
            responses: [new Response(200, [], '{"f":{}}')],
            sdkKey: $key,
        );

        self::assertSame(
            'https://cdn.example.test/configuration-files/' . $goEscaped . '/config_v6.json',
            $fetcher->getUrl(),
        );
        $fetcher->fetch();

        self::assertCount(1, $this->history);
        $uri = self::recordedRequest($this->history[0])->getUri();
        self::assertSame('/configuration-files/' . $goEscaped . '/config_v6.json', $uri->getPath());
        self::assertSame('', $uri->getQuery());
        self::assertSame('', $uri->getFragment());
    }

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function unfetchableKeys(): iterable
    {
        yield 'empty' => [''];
        yield 'dot' => ['.'];
        yield 'dot-dot' => ['..'];
    }

    #[DataProvider('unfetchableKeys')]
    public function testKeyThatCannotBeASegmentIsNeverFetched(string $key): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, [], '{"f":{}}')],
            sdkKey: $key,
        );

        $result = $fetcher->fetch();

        self::assertNull($fetcher->getUrl());
        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame('INVALID_SDK_KEY', $result->error);
        self::assertCount(0, $this->history, 'no request may be issued');
        self::assertTrue(self::hasErrorLog($logger));
        foreach ($logger->records as [$_lvl, $msg]) {
            self::assertStringContainsString('INVALID_SDK_KEY', $msg);
        }
    }

    /**
     * #803 FR-002/FR-004: the key is in the URL now, and Guzzle's (and
     * cURL's) messages quote the URL. A forced timeout, mid-body reset
     * and redirect loop MUST leave the full key — and each of its
     * secret parts — out of every log line (message AND PSR-3 context,
     * exceptions with their whole `getPrevious()` chain rendered) and
     * `FetchResult::$error`.
     *
     * The mid-body reset goes through the REAL transport: the fetcher's
     * own default Guzzle client against a local socket that sends the
     * headers and part of the body, then closes. Guzzle buffers the body
     * inside the handler, so the drop surfaces from `request()` as a cURL
     * error quoting the full URL — the path production takes.
     *
     * @return iterable<string, array{0: string, 1: string, 2: string}>
     */
    public static function forcedFailures(): iterable
    {
        foreach ([
            'legacy' => WorkspaceRoot::SAMPLE_SDK_KEY,
            'configcat' => WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY,
        ] as $shape => $key) {
            yield $shape . ' timeout' => [$key, 'timeout', ConfigFetcher::REASON_TIMEOUT];
            yield $shape . ' mid-body reset' => [$key, 'reset', ConfigFetcher::REASON_BODY_READ_FAILED];
            yield $shape . ' redirect loop' => [$key, 'redirect-loop', ConfigFetcher::REASON_TOO_MANY_REDIRECTS];
        }
    }

    #[DataProvider('forcedFailures')]
    public function testForcedFailureNeverLeaksTheKeyOrItsParts(string $key, string $failure, string $reason): void
    {
        $logger = self::capturingLogger();
        if ($failure === 'reset') {
            $result = self::fetchAgainstTruncatingServer($key, $logger);
        } else {
            $url = (string) ConfigFetcher::buildConfigUrl('https://cdn.example.test', $key);
            $request = new Request('GET', $url);
            $responses = match ($failure) {
                'timeout' => [new ConnectException(
                    'cURL error 28: Operation timed out after 2001 milliseconds for ' . $url,
                    $request,
                    null,
                    ['errno' => 28, 'url' => $url],
                )],
                'redirect-loop' => array_fill(0, 10, new Response(302, ['Location' => $url])),
                default => throw new \LogicException('unknown failure ' . $failure),
            };
            $fetcher = $this->buildFetcher(logger: $logger, responses: $responses, sdkKey: $key);
            $result = $fetcher->fetch();
        }

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertSame($reason, $result->error);
        self::assertTrue(self::hasErrorLog($logger));
        $secrets = [$key];
        if (str_starts_with($key, 'configcat-sdk-1/')) {
            [, $partA, $partB] = explode('/', $key);
            self::assertSame(22, \strlen($partA));
            self::assertSame(22, \strlen($partB));
            $secrets[] = $partA;
            $secrets[] = $partB;
        } else {
            $secrets[] = substr($key, \strlen('confeature-sdk-1-'), 32);
            $secrets[] = substr($key, -32);
        }
        foreach ($secrets as $secret) {
            foreach ($logger->texts() as $text) {
                self::assertStringNotContainsString($secret, $text, 'the key leaked into a log record');
            }
            self::assertStringNotContainsString($secret, (string) $result->error, 'the key leaked into the error');
        }
    }

    public function testFailureWithConfigCatShapedKeyNeverLogsEitherSecretSegment(): void
    {
        $key = WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY;
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(500, [], 'boom')],
            sdkKey: $key,
        );

        $result = $fetcher->fetch();

        self::assertSame(FetchResult::STATUS_FAILED, $result->status);
        self::assertTrue(self::hasErrorLog($logger));
        [, $segA, $segB] = explode('/', $key);
        foreach ($logger->texts() as $text) {
            self::assertStringNotContainsString($segA, $text, 'first secret segment leaked into a log record');
            self::assertStringNotContainsString($segB, $text, 'second secret segment leaked into a log record');
        }
        foreach ([$segA, $segB] as $segment) {
            self::assertStringNotContainsString($segment, (string) $result->error);
        }
    }

    public function testCloseIsIdempotent(): void
    {
        $logger = self::capturingLogger();
        $fetcher = $this->buildFetcher(
            logger: $logger,
            responses: [new Response(200, [], '{"f":{}}')],
        );
        $fetcher->close();
        $fetcher->close();
        self::assertTrue(true); // no exception raised
    }

    public function testZeroTimeoutRaises(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new ConfigFetcher(
            sdkKey: WorkspaceRoot::SAMPLE_SDK_KEY,
            version: '0.0.0',
            logger: self::capturingLogger(),
            requestTimeoutSeconds: 0.0,
        );
    }

    public function testNegativeTimeoutRaises(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new ConfigFetcher(
            sdkKey: WorkspaceRoot::SAMPLE_SDK_KEY,
            version: '0.0.0',
            logger: self::capturingLogger(),
            requestTimeoutSeconds: -1.0,
        );
    }

    public function testGetUserAgentReportsConfiguredVersion(): void
    {
        $fetcher = new ConfigFetcher(
            sdkKey: WorkspaceRoot::SAMPLE_SDK_KEY,
            version: '9.9.9',
            logger: self::capturingLogger(),
        );
        self::assertSame('confeature-php-sdk/9.9.9', $fetcher->getUserAgent());
    }

    // ----- helpers ----------------------------------------------------

    /**
     * @param list<Response|\Throwable> $responses
     */
    private function buildFetcher(
        CapturingLogger $logger,
        array $responses,
        string $baseUrl = 'https://cdn.example.test',
        string $sdkKey = WorkspaceRoot::SAMPLE_SDK_KEY,
    ): ConfigFetcher {
        $mock = new MockHandler($responses);
        $stack = HandlerStack::create($mock);
        // Middleware::history mutates the supplied array by reference;
        // we pin the test's `$this->history` so individual cases can
        // inspect the captured requests.
        $stack->push(Middleware::history($this->history));
        $client = new GuzzleClient(['handler' => $stack]);

        return new ConfigFetcher(
            sdkKey: $sdkKey,
            version: Version::SDK,
            logger: $logger,
            baseUrl: $baseUrl,
            requestTimeoutSeconds: 2.0,
            httpClient: $client,
        );
    }

    /**
     * @param array<string, mixed> $entry
     */
    private static function recordedRequest(array $entry): RequestInterface
    {
        $request = $entry['request'] ?? null;
        self::assertInstanceOf(RequestInterface::class, $request);

        return $request;
    }

    /**
     * Fetch with the fetcher's OWN default Guzzle client (no injected
     * handler — production's transport) from a one-shot local HTTP server
     * that answers 200 with `Content-Length: 1000`, sends 18 body bytes and
     * closes the connection: a connection dropped mid-body.
     */
    private static function fetchAgainstTruncatingServer(string $key, CapturingLogger $logger): FetchResult
    {
        $server = <<<'PHP'
            $srv = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
            if ($srv === false) { fwrite(STDERR, $errstr); exit(1); }
            fwrite(STDOUT, stream_socket_get_name($srv, false) . "\n");
            fflush(STDOUT);
            $conn = stream_socket_accept($srv, 20);
            if ($conn === false) { exit(1); }
            while (($line = fgets($conn)) !== false && rtrim($line, "\r\n") !== '') {
            }
            fwrite($conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"v1\"\r\n"
                . "Content-Length: 1000\r\nConnection: close\r\n\r\n{\"p\":{\"s\":\"partial");
            fflush($conn);
            fclose($conn);
            PHP;
        $proc = proc_open(
            [\PHP_BINARY, '-n', '-r', $server],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($proc, 'cannot start the local truncating server');
        try {
            $address = trim((string) fgets($pipes[1]));
            self::assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $address, 'server did not report its address');
            $fetcher = new ConfigFetcher(
                sdkKey: $key,
                version: Version::SDK,
                logger: $logger,
                baseUrl: 'http://' . $address,
                requestTimeoutSeconds: 5.0,
            );

            return $fetcher->fetch();
        } finally {
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($proc);
        }
    }

    private static function capturingLogger(): CapturingLogger
    {
        return new CapturingLogger();
    }

    private static function hasErrorLog(CapturingLogger $logger): bool
    {
        foreach ($logger->records as [$level, $_msg]) {
            if ($level === 'error') {
                return true;
            }
        }

        return false;
    }

    private static function assertSdkKeyNeverLogged(CapturingLogger $logger, ?string ...$extras): void
    {
        $secret = WorkspaceRoot::SAMPLE_SDK_KEY;
        foreach ($logger->texts() as $text) {
            self::assertStringNotContainsString($secret, $text, 'SDK key leaked into a log record');
        }
        foreach ($extras as $extra) {
            if ($extra === null) {
                continue;
            }
            self::assertStringNotContainsString($secret, $extra, 'SDK key leaked into an error string');
        }
    }
}

/**
 * PSR-3 logger that records every log call — level, message AND the
 * PSR-3 `$context` — so the key-free assertions see everything a real
 * logger (e.g. Monolog rendering `['exception' => $e]`) would print.
 * Every context value is rendered; a `\Throwable` contributes its
 * message and `(string)` form for itself and each `getPrevious()` link.
 */
final class CapturingLogger extends AbstractLogger
{
    /** @var list<array{0: string, 1: string, 2: list<string>}> */
    public array $records = [];

    /**
     * @param mixed             $level
     * @param string|Stringable $message
     * @param array<mixed>      $context
     */
    public function log($level, string|Stringable $message, array $context = []): void
    {
        $rendered = [];
        foreach ($context as $name => $value) {
            $rendered[] = (string) $name;
            self::render($value, $rendered);
        }
        $this->records[] = [(string) $level, (string) $message, $rendered];
    }

    /**
     * Every recorded string: each message and each rendered context value.
     *
     * @return list<string>
     */
    public function texts(): array
    {
        $texts = [];
        foreach ($this->records as [$_level, $message, $context]) {
            $texts[] = $message;
            foreach ($context as $text) {
                $texts[] = $text;
            }
        }

        return $texts;
    }

    /**
     * @param list<string> $out
     */
    private static function render(mixed $value, array &$out, int $depth = 0): void
    {
        if ($depth > 8) {
            return;
        }
        if ($value instanceof \Throwable) {
            for ($e = $value; $e !== null; $e = $e->getPrevious()) {
                $out[] = $e::class;
                $out[] = $e->getMessage();
                $out[] = (string) $e;
            }

            return;
        }
        if (\is_array($value)) {
            foreach ($value as $k => $v) {
                $out[] = (string) $k;
                self::render($v, $out, $depth + 1);
            }

            return;
        }
        if ($value instanceof Stringable) {
            $out[] = (string) $value;

            return;
        }
        if (\is_object($value)) {
            $out[] = print_r($value, true);

            return;
        }
        $out[] = var_export($value, true);
    }
}
