<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

/**
 * Test-side helper: locate the monorepo root and load the shared
 * parity fixtures from `packages/test-fixtures-sdk-parity/fixtures/`.
 *
 * Walks up from this file until it finds a directory containing
 * `pnpm-workspace.yaml`. Cached on first call.
 */
final class WorkspaceRoot
{
    private static ?string $root = null;

    /**
     * Sample SDK key in the legacy `confeature-sdk-1-<32>-<32>` format
     * (still valid after #802). Useful as the default key for tests that
     * exercise paths whose output does not depend on the key's value.
     */
    public const SAMPLE_SDK_KEY =
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    /**
     * Sample SDK key in the ConfigCat shape Confeature mints since #802,
     * `configcat-sdk-1/<22>/<22>` — it contains `/`.
     */
    public const SAMPLE_CONFIGCAT_SHAPED_SDK_KEY =
        'configcat-sdk-1/CCCCCCCCCCCCCCCCCCCCCC/DDDDDDDDDDDDDDDDDDDDDD';

    private function __construct()
    {
    }

    public static function path(): string
    {
        if (self::$root !== null) {
            return self::$root;
        }
        $dir = \dirname(__DIR__);
        while (true) {
            if (is_file($dir . \DIRECTORY_SEPARATOR . 'pnpm-workspace.yaml')) {
                self::$root = $dir;

                return $dir;
            }
            $parent = \dirname($dir);
            if ($parent === $dir) {
                throw new \RuntimeException(
                    'Could not locate the workspace root above ' . __DIR__
                );
            }
            $dir = $parent;
        }
    }

    public static function fixturePath(string $name): string
    {
        return self::path() . '/packages/test-fixtures-sdk-parity/fixtures/' . $name;
    }

    /**
     * Absolute path into the vendored upstream ConfigCat conformance
     * corpus (`packages/test-fixtures-sdk-parity/fixtures/upstream/`),
     * shared read-only with spec 117/118/119/120. The corpus test
     * (`EvaluatorUpstreamCorpusTest`) reads the testmatrix CSVs +
     * `evaluationlog/` + `comparison_*.json` through this accessor.
     */
    public static function upstreamPath(string $name = ''): string
    {
        $base = self::path() . '/packages/test-fixtures-sdk-parity/fixtures/upstream';

        return $name === '' ? $base : $base . '/' . $name;
    }

    /**
     * Read + JSON-decode a file under the upstream corpus directory.
     *
     * @return array<string, mixed>
     */
    public static function upstreamJson(string $relativePath): array
    {
        $raw = file_get_contents(self::upstreamPath($relativePath));
        if ($raw === false) {
            throw new \RuntimeException('Cannot read upstream fixture ' . $relativePath);
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('Upstream fixture is not a JSON object: ' . $relativePath);
        }

        /** @var array<string, mixed> $data */
        return $data;
    }

    /**
     * Read a UTF-8 text file under the upstream corpus directory (the
     * testmatrix CSVs).
     */
    public static function upstreamText(string $relativePath): string
    {
        $raw = file_get_contents(self::upstreamPath($relativePath));
        if ($raw === false) {
            throw new \RuntimeException('Cannot read upstream fixture ' . $relativePath);
        }

        return $raw;
    }

    public static function parityCorpusPath(): string
    {
        return self::fixturePath('parity-corpus.json');
    }

    public static function parityConfigsPath(): string
    {
        return self::fixturePath('parity-configs.json');
    }

    public static function parityCorpusTypedPath(): string
    {
        return self::fixturePath('parity-corpus-typed.json');
    }

    public static function parityConfigsTypedPath(): string
    {
        return self::fixturePath('parity-configs-typed.json');
    }

    public static function parityCorpusRulesPath(): string
    {
        return self::fixturePath('parity-corpus-rules.json');
    }

    public static function parityConfigsRulesPath(): string
    {
        return self::fixturePath('parity-configs-rules.json');
    }

    public static function cacheKeyFixturesPath(): string
    {
        return self::fixturePath('cache-key-fixtures.json');
    }

    public static function parityEvaluationLogPath(): string
    {
        return self::fixturePath('parity-evaluationlog.json');
    }

    /**
     * The evaluation-log trace corpus (ADR 0003 / epic #494) — a flat array of
     * tuples each carrying an `expectedTrace` byte-string the federated
     * evaluator must reproduce verbatim.
     *
     * @return list<array<string, mixed>>
     */
    public static function parityEvaluationLog(): array
    {
        $raw = file_get_contents(self::parityEvaluationLogPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-evaluationlog.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-evaluationlog.json is not a JSON array');
        }

        /** @var list<array<string, mixed>> $data */
        return $data;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public static function parityCorpus(): array
    {
        $raw = file_get_contents(self::parityCorpusPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-corpus.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-corpus.json is not a JSON array');
        }

        /** @var list<array<string, mixed>> $data */
        return $data;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function parityConfigs(): array
    {
        $raw = file_get_contents(self::parityConfigsPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-configs.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-configs.json is not a JSON array');
        }
        $out = [];
        foreach ($data as $cfg) {
            if (\is_array($cfg) && \is_string($cfg['id'] ?? null)) {
                $out[$cfg['id']] = $cfg;
            }
        }

        return $out;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public static function parityCorpusTyped(): array
    {
        $raw = file_get_contents(self::parityCorpusTypedPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-corpus-typed.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-corpus-typed.json is not a JSON array');
        }

        /** @var list<array<string, mixed>> $data */
        return $data;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function parityConfigsTyped(): array
    {
        $raw = file_get_contents(self::parityConfigsTypedPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-configs-typed.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-configs-typed.json is not a JSON array');
        }
        $out = [];
        foreach ($data as $cfg) {
            if (\is_array($cfg) && \is_string($cfg['id'] ?? null)) {
                $out[$cfg['id']] = $cfg;
            }
        }

        return $out;
    }

    /**
     * The targeting-rule parity corpus (spec 135 / #432) — full-config
     * tuples injected through the in-memory full-config offline override.
     *
     * @return list<array<string, mixed>>
     */
    public static function parityCorpusRules(): array
    {
        $raw = file_get_contents(self::parityCorpusRulesPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-corpus-rules.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-corpus-rules.json is not a JSON array');
        }

        /** @var list<array<string, mixed>> $data */
        return $data;
    }

    /**
     * The rule corpus configs, keyed by `id`. Each carries the full
     * `{p, f, s}` config under `config` + an `injectionMode` discriminator.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function parityConfigsRules(): array
    {
        $raw = file_get_contents(self::parityConfigsRulesPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read parity-configs-rules.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('parity-configs-rules.json is not a JSON array');
        }
        $out = [];
        foreach ($data as $cfg) {
            if (\is_array($cfg) && \is_string($cfg['id'] ?? null)) {
                $out[$cfg['id']] = $cfg;
            }
        }

        return $out;
    }

    public static function sdkKeyShapesPath(): string
    {
        return self::fixturePath('sdk-key-shapes.json');
    }

    /**
     * The ONE accept/reject list of SDK key shapes every Confeature SDK
     * validator is tested against (#802, FR-006b).
     *
     * @return array{valid: list<array{name: string, key: string}>, invalid: list<array{name: string, key: string}>}
     */
    public static function sdkKeyShapes(): array
    {
        $raw = file_get_contents(self::sdkKeyShapesPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read sdk-key-shapes.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('sdk-key-shapes.json is not a JSON object');
        }
        $out = ['valid' => [], 'invalid' => []];
        foreach (['valid', 'invalid'] as $bucket) {
            $entries = $data[$bucket] ?? null;
            if (!\is_array($entries)) {
                throw new \RuntimeException("sdk-key-shapes.json has no `{$bucket}` list");
            }
            foreach ($entries as $entry) {
                if (
                    !\is_array($entry)
                    || !\is_string($entry['name'] ?? null)
                    || !\is_string($entry['key'] ?? null)
                ) {
                    throw new \RuntimeException("sdk-key-shapes.json has a malformed `{$bucket}` entry");
                }
                $out[$bucket][] = ['name' => $entry['name'], 'key' => $entry['key']];
            }
        }

        return $out;
    }

    /**
     * @return list<array{sdkKey: string, expectedCacheKey: string}>
     */
    public static function cacheKeyFixtures(): array
    {
        $raw = file_get_contents(self::cacheKeyFixturesPath());
        if ($raw === false) {
            throw new \RuntimeException('Cannot read cache-key-fixtures.json');
        }
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            throw new \RuntimeException('cache-key-fixtures.json is not a JSON array');
        }
        $out = [];
        foreach ($data as $entry) {
            if (
                \is_array($entry)
                && \is_string($entry['sdkKey'] ?? null)
                && \is_string($entry['expectedCacheKey'] ?? null)
            ) {
                $out[] = [
                    'sdkKey' => $entry['sdkKey'],
                    'expectedCacheKey' => $entry['expectedCacheKey'],
                ];
            }
        }

        return $out;
    }
}
