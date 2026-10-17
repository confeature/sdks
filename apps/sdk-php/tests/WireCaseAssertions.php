<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\ConfigFetcher;
use Confeature\Internal\FetchResult;

/**
 * What a `wire-cases.json` case means for sdk-php — ONE implementation,
 * used by the hermetic suite (`WireCasesTest`, a Guzzle MockHandler) AND
 * the live suite (`WireCasesLiveTest`, real HTTP against the harness, #920),
 * so both are judged by the same rules. The request is passed in
 * SDK-neutral form (path, URL, If-None-Match): the hermetic suite reads it
 * from Guzzle's history, the live suite from the harness's
 * `GET /admin/requests`.
 *
 * Mirrors sdk-python's `_wire_case_assertions.py` (#783, decision row 6).
 */
trait WireCaseAssertions
{
    /**
     * Every `given` / `expected` field this consumer reads (#803 FR-003).
     * A case carrying any other field FAILS — a new expectation can never
     * be skipped silently. Add a field here only together with the code
     * that asserts it.
     *
     * @var list<string>
     */
    private static array $knownGivenFields = ['previousEtag', 'baseUrl', 'sdkKey'];

    /** @var list<string> */
    private static array $knownExpectedFields = [
        'requestHeaderIfNoneMatch',
        'requestUrlPrefix',
        'requestPath',
        'outcome',
        'resultingEtag',
        'hasConfig',
        'errorClass',
    ];

    /**
     * The corpus cases, keyed by id.
     *
     * @return array<string, array<string, mixed>>
     */
    private static function loadWireCases(): array
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

        $cases = [];
        foreach ($data['cases'] as $case) {
            if (!\is_array($case) || !\is_string($case['id'] ?? null)) {
                throw new \RuntimeException('wire-cases.json carries a malformed case');
            }
            $cases[$case['id']] = $case;
        }

        return $cases;
    }

    /**
     * The key a suite configures its fetcher with: the corpus's
     * `given.sdkKey` when the case pins one, else the suite's own default
     * (the live suite's default is the case id, the key the harness seeds).
     *
     * @param array<string, mixed> $case
     */
    private static function wireSdkKey(array $case, string $default): string
    {
        $key = $case['given']['sdkKey'] ?? $default;
        self::assertIsString($key);

        return $key;
    }

    /**
     * Fail closed on a `given` / `expected` field this reader does not know.
     *
     * @param array<string, mixed> $case
     */
    private static function assertKnownWireFields(array $case): void
    {
        $unknownGiven = array_values(array_diff(array_keys($case['given']), self::$knownGivenFields));
        self::assertSame([], $unknownGiven, 'wire case carries given fields this consumer does not read');
        $unknownExpected = array_values(array_diff(array_keys($case['expected']), self::$knownExpectedFields));
        self::assertSame([], $unknownExpected, 'wire case carries expected fields this consumer does not read');
    }

    /**
     * The request side of a case (#803 FR-001/FR-003). The path is compared
     * EXACTLY: the corpus's `requestPath` when the case pins one, else
     * ConfigCat's `/configuration-files/<sdkKey>/config_v6.json` with the
     * key in RAW — which is how a suite proves the SDK sent the key it was
     * configured with. `requestUrlPrefix` is compared to the full URL.
     * If-None-Match is three-state: absent key = don't assert, explicit
     * null = MUST NOT be sent (`$ifNoneMatch` null), string = MUST equal.
     *
     * @param array<string, mixed> $case
     */
    private static function assertWireRequest(
        array $case,
        string $path,
        string $url,
        ?string $ifNoneMatch,
        string $sdkKey,
    ): void {
        /** @var array<string, mixed> $expected */
        $expected = $case['expected'];
        $wantPath = $expected['requestPath'] ?? '/configuration-files/' . $sdkKey . '/config_v6.json';
        self::assertSame($wantPath, $path, 'request path');
        self::assertStringNotContainsString('/v2/', $path);
        if (\array_key_exists('requestUrlPrefix', $expected)) {
            self::assertIsString($expected['requestUrlPrefix']);
            self::assertStringStartsWith($expected['requestUrlPrefix'], $url, 'request URL prefix');
        }
        if (\array_key_exists('requestHeaderIfNoneMatch', $expected)) {
            self::assertSame($expected['requestHeaderIfNoneMatch'], $ifNoneMatch, 'If-None-Match');
        }
    }

    /**
     * The outcome side of a case: PHP's `FetchResult` against the corpus's
     * `{fetched, notModified, failed}` x `errorClass` vocabulary.
     *
     * @param array<string, mixed> $case
     */
    private static function assertWireOutcome(array $case, FetchResult $result): void
    {
        /** @var array<string, mixed> $expected */
        $expected = $case['expected'];
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
     * normalised error-class vocabulary. Mirrors `python_error_to_class`
     * (sdk-python) and `goErrorToClass` (sdk-go).
     *
     * HTTP 403 and 404 both map to `invalidSdkKey` — per ConfigCat only
     * 403/404 are invalid-SDK-key statuses (401 is a generic retryable
     * failure). The fetcher reduces a cURL "Operation timed out" error to
     * the fixed reason `timeout` (#803 FR-002) → the `timeout` class.
     *
     * Fails closed: an error this function does not know maps to
     * `unmapped:<error>`, which matches no corpus class. Folding the
     * unknown into `fetchFailed` would let any unexpected failure pass
     * every fetchFailed case.
     */
    private static function mapErrorToClass(?string $error): string
    {
        if ($error === 'MALFORMED_JSON') {
            return 'parseFailed';
        }
        if ($error === 'HTTP 403' || $error === 'HTTP 404' || $error === 'INVALID_SDK_KEY') {
            return 'invalidSdkKey';
        }
        if ($error !== null && str_starts_with($error, 'HTTP ')) {
            return 'fetchFailed';
        }
        if ($error === ConfigFetcher::REASON_TIMEOUT) {
            return 'timeout';
        }
        $transport = [
            ConfigFetcher::REASON_CONNECT_FAILED,
            ConfigFetcher::REASON_TOO_MANY_REDIRECTS,
            ConfigFetcher::REASON_REQUEST_FAILED,
            ConfigFetcher::REASON_BODY_READ_FAILED,
        ];
        if (\in_array($error, $transport, true)) {
            return 'fetchFailed';
        }

        return 'unmapped:' . var_export($error, true);
    }
}
