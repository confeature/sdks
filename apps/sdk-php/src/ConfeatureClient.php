<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

use Confeature\Internal\ConfigFetcher;
use Confeature\Internal\Evaluator;
use Confeature\Internal\FetchResult;
use Confeature\Internal\FilesystemCache;
use Confeature\Internal\OverrideEval;
use Confeature\Internal\SdkKey;
use Psr\Log\LoggerInterface;
use Psr\SimpleCache\CacheInterface;

/**
 * Top-level Confeature SDK client.
 *
 * Drop-in equivalent of upstream `Confeature\ConfeatureClient` from
 * `configcat/configcat-php-sdk`. The constructor is private — callers
 * use the `create($sdkKey, $options)` factory, mirroring the upstream
 * idiom exactly (Constitution Principle II).
 *
 * Recognised options (any subset of):
 *   - `pollingMode`  : Confeature\PollingMode      (default: autoPoll)
 *   - `cache`        : PSR-16 CacheInterface | null (default: FilesystemCache)
 *   - `logger`       : PSR-3 LoggerInterface       (default: stderr WARNING)
 *   - `flagOverrides`: Confeature\FlagOverrides    (default: null)
 *   - `baseUrl`      : string                      (default: cdn-global)
 *   - `requestTimeoutSeconds`: float               (default: 30.0)
 *   - `defaultUser`  : Confeature\User             (default: null)
 *   - `httpClient`   : GuzzleHttp\ClientInterface  (test hook only)
 *
 * `getValue` resolves the four `SettingType` discriminators (spec 072,
 * issue #259):
 *   - `t=0` (boolean) → expects a `bool` `$default`;
 *   - `t=1` (string)  → expects a `string` `$default`;
 *   - `t=2` (int)     → expects an `int` `$default`;
 *   - `t=3` (double)  → expects a `float` `$default` — strict, PHP's
 *     `is_float(5)` is false so an `int` default refuses with
 *     `TYPE_MISMATCH` (deliberate, matches ConfigCat-PHP behaviour).
 * Type-mismatched defaults round-trip as-is. Genuinely unknown `t`
 * discriminators (e.g. `99`) still resolve as `UNSUPPORTED_TYPE`.
 *
 * PHP's synchronous CLI execution model has no daemon threads — so
 * AutoPoll is implemented as a staleness-driven lazy-load (refresh
 * when older than `$pollIntervalSeconds`), which matches the upstream
 * ConfigCat PHP SDK behaviour exactly.
 */
final class ConfeatureClient
{
    private readonly string $sdkKey;
    private readonly PollingMode $pollingMode;
    private readonly LoggerInterface $logger;
    private readonly ?FlagOverrides $flagOverrides;
    private readonly ?User $defaultUser;
    private readonly ?CacheInterface $cache;
    private readonly string $cacheKey;
    private readonly ?ConfigFetcher $fetcher;
    private readonly bool $localOnly;

    /** @var array<string, mixed>|null */
    private ?array $config = null;
    private ?string $etag = null;
    private ?float $lastFetchedAt = null;
    private bool $closed = false;

    /**
     * Spec 098 / #267 slice 9/14 — mirrors ConfigCat\ConfigCatClient::isOffline()
     * / ::setOnline() / ::setOffline(). PHP runs single-threaded per request, so a
     * plain `bool` matches the `closed` discipline.
     */
    private bool $offline = false;
    private bool $initialFetched = false;

    /**
     * Spec 109 / #268 slice 7/14 — mirrors ConfigCat\ConfigCatClient::hooks(). Three hook
     * points (configChanged, flagEvaluated, error) — matches upstream PHP exactly (upstream
     * does not expose clientReady on PHP).
     */
    private Hooks $hooks;

    /**
     * @param array<string, mixed> $options
     */
    private function __construct(string $sdkKey, array $options)
    {
        if ($sdkKey === '') {
            throw new \InvalidArgumentException('sdkKey is required and must be a non-empty string');
        }
        $this->sdkKey = $sdkKey;

        $this->pollingMode = $this->extractPollingMode($options);
        $this->logger = $this->extractLogger($options);
        $this->hooks = new Hooks(logger: $this->logger instanceof Logger ? $this->logger : null);
        $this->flagOverrides = $this->extractFlagOverrides($options);
        $this->defaultUser = $this->extractDefaultUser($options);
        $timeout = (float) ($options['requestTimeoutSeconds'] ?? 30.0);
        if ($timeout <= 0) {
            throw new \InvalidArgumentException(
                'requestTimeoutSeconds must be > 0; got ' . $timeout
            );
        }

        if (!SdkKey::isValidConfeatureKeyFormat($sdkKey)) {
            $this->logger->warning(sprintf(
                'INVALID_SDK_KEY format for sdkKey=%s. Continuing — the SDK '
                . 'is lenient about key format at runtime.',
                SdkKey::redact($sdkKey),
            ));
        }

        $this->cacheKey = SdkKey::deriveCacheKey($sdkKey);
        $this->cache = $this->extractCache($options);
        $this->localOnly = $this->flagOverrides !== null
            && $this->flagOverrides->behaviour === OverrideBehaviour::LOCAL_ONLY;

        // LocalOnly customers never fetch — every getValue is served
        // by the override-eval path. Skip allocating the fetcher.
        if ($this->localOnly) {
            $this->fetcher = null;

            return;
        }

        $this->fetcher = new ConfigFetcher(
            sdkKey: $sdkKey,
            version: Version::SDK,
            logger: $this->logger,
            baseUrl: \is_string($options['baseUrl'] ?? null) ? $options['baseUrl'] : null,
            requestTimeoutSeconds: $timeout,
            httpClient: $options['httpClient'] ?? null,
        );

        // Seed from the customer-provided / default cache so the first
        // getValue does not pay a round-trip if a fresh entry exists.
        $this->loadFromCache();
    }

    /**
     * Construct a client.
     *
     * @param array<string, mixed>|null $options
     */
    public static function create(string $sdkKey, ?array $options = null): self
    {
        return new self($sdkKey, $options ?? []);
    }

    public function getValue(string $key, mixed $default, ?User $user = null): mixed
    {
        if ($this->closed) {
            return $default;
        }

        $effectiveUser = $user ?? $this->defaultUser;

        // Override path FIRST — spec 036 correctness. Route through the
        // full-config-aware router (spec 135 / #432) so a rule-bearing override
        // source resolves targeting rules through the real evaluator; the
        // flat-map source keeps the byte-identical value-only path.
        [$found, $value] = OverrideEval::evaluate($this->flagOverrides, $key, $default, $effectiveUser);
        if ($found) {
            return $value;
        }

        $this->maybeFetch();

        return Evaluator::evaluate($this->config, $key, $default, $effectiveUser)->value;
    }

    /**
     * Spec 087 / #266 — typed-envelope mirror of `getValue`.
     *
     * Drop-in equivalent of upstream
     * `ConfigCat\ConfigCatClient::getValueDetails`: identical
     * (string, mixed, ?User) signature and identical `EvaluationDetails`
     * return shape.
     *
     * Closed clients return an envelope built via
     * `EvaluationDetails::fromError($key, $default, $user, 'CLIENT_CLOSED')`
     * to match the closed-client semantics of `getValue`.
     *
     * For LocalOnly consumers, the override map is the only source of
     * truth: a key present in the map yields the typed value with
     * `errorMessage = null`; a missing key yields the default with
     * `errorMessage = 'KEY_NOT_FOUND'`. The override-eval helper
     * returns the default on both KEY_NOT_FOUND and TYPE_MISMATCH
     * branches, so we re-query the map to disambiguate.
     *
     * Non-LocalOnly clients route through the evaluator; the
     * `EvaluationResult.error` string propagates verbatim into the
     * envelope's `errorMessage` field.
     */
    public function getValueDetails(string $key, mixed $default, ?User $user = null): EvaluationDetails
    {
        if ($this->closed) {
            $details = EvaluationDetails::fromError($key, $default, $user, 'CLIENT_CLOSED');
            $this->hooks->fireOnFlagEvaluated($details);

            return $details;
        }

        $effectiveUser = $user ?? $this->defaultUser;

        // Full-config override path (spec 135 / #432; variationId propagation
        // spec 152 / #475, the #395 gap class): a LOCAL_ONLY full-config source
        // resolves targeting rules / segments / % options through the real
        // evaluator, so the details envelope MUST carry the evaluator's
        // variationId / matched-rule / matched-option — not the value-only
        // flat-map branch (which always yields variationId=null). Mirrors how
        // `getValue` routes full-config overrides via `OverrideEval::evaluate`.
        if (
            $this->localOnly
            && $this->flagOverrides !== null
            && $this->flagOverrides->dataSource instanceof ConfigOverrideDataSource
        ) {
            $result = Evaluator::evaluate(
                $this->flagOverrides->dataSource->config(),
                $key,
                $default,
                $effectiveUser,
            );
            $details = new EvaluationDetails(
                $key,
                $result->variationId,
                $result->value,
                $effectiveUser,
                $result->error !== null,
                $result->error,
                null,
                $this->fetchTimeUnixMilliseconds(),
                $result->matchedTargetingRule,
                $result->matchedPercentageOption,
            );
            $this->hooks->fireOnFlagEvaluated($details);

            return $details;
        }

        if ($this->localOnly) {
            $details = $this->localOnlyDetails($key, $default, $effectiveUser);
            $this->hooks->fireOnFlagEvaluated($details);

            return $details;
        }

        $this->maybeFetch();

        $result = Evaluator::evaluate($this->config, $key, $default, $effectiveUser);

        $details = new EvaluationDetails(
            $key,
            $result->variationId,
            $result->value,
            $effectiveUser,
            $result->error !== null,
            $result->error,
            null,
            $this->fetchTimeUnixMilliseconds(),
            $result->matchedTargetingRule,
            $result->matchedPercentageOption,
        );
        $this->hooks->fireOnFlagEvaluated($details);

        return $details;
    }

    /**
     * Spec 087 / #266 — evaluates every known flag for `$user` and
     * returns a `array<string, mixed>`.
     *
     * Drop-in equivalent of upstream
     * `ConfigCat\ConfigCatClient::getAllValues`: identical (?User)
     * signature and identical return shape.
     *
     * Iterates the union of cached-config flag keys + override keys
     * (the same set `Snapshot::getAllKeys` returns). Per-key value is
     * resolved via `getValue($key, null, $user)`; keys whose resolved
     * value is `null` are omitted, mirroring upstream's exclusion
     * semantics. Closed clients return an empty array.
     *
     * @return array<string, mixed>
     */
    public function getAllValues(?User $user = null): array
    {
        if ($this->closed) {
            return [];
        }

        $this->maybeFetch();

        $out = [];
        foreach ($this->collectAllKeys() as $key) {
            // Read the setting's native value directly — we cannot route
            // through `getValue($key, null, $user)` because `null` as a
            // default would TYPE_MISMATCH against any concrete setting
            // type. Upstream `ConfigCatClient::getAllValues` reads each
            // setting's raw value without applying a type check.
            $value = $this->readNativeValue($key);
            if ($value !== null) {
                $out[$key] = $value;
            }
        }

        return $out;
    }

    /**
     * Reads the per-setting native value from overrides first, then the
     * cached config — without the type-check that `getValue` performs
     * against a default. Used by `getAllValues` to mirror upstream
     * `ConfigCatClient::getAllValues` semantics (no default → no type
     * check; setting's native type wins).
     */
    private function readNativeValue(string $key): mixed
    {
        if ($this->flagOverrides !== null) {
            try {
                $overrideMap = $this->flagOverrides->dataSource->getOverridesSync();
            } catch (\Throwable) {
                $overrideMap = null;
            }
            if (\is_array($overrideMap) && \array_key_exists($key, $overrideMap)) {
                $entry = $overrideMap[$key];

                return $entry instanceof SettingValue ? $entry->picked() : $entry;
            }
        }
        if (\is_array($this->config) && isset($this->config['f'][$key]['v']) && \is_array($this->config['f'][$key]['v'])) {
            $variant = $this->config['f'][$key]['v'];
            if (\array_key_exists('b', $variant)) {
                return $variant['b'];
            }
            if (\array_key_exists('s', $variant)) {
                return $variant['s'];
            }
            if (\array_key_exists('i', $variant)) {
                return $variant['i'];
            }
            if (\array_key_exists('d', $variant)) {
                return $variant['d'];
            }
        }

        return null;
    }

    public function forceRefresh(): bool
    {
        if ($this->closed) {
            return false;
        }
        if ($this->localOnly || $this->fetcher === null) {
            return true;
        }
        if ($this->offline) {
            // Spec 098 / #267 — no HTTP while offline; mirrors upstream OFFLINE_MODE.
            return false;
        }

        return $this->fetchAndApply()->status !== FetchResult::STATUS_FAILED;
    }

    /**
     * Re-enables HTTP polling. Idempotent.
     *
     * Mirrors ConfigCat\ConfigCatClient::setOnline() (spec 098 / #267 slice 9/14). Closed clients
     * log warning + no-op. LocalOnly clients log warning + no-op (LocalOnly never polls — the
     * flag has no effect).
     */
    public function setOnline(): void
    {
        if ($this->closed) {
            $this->logger->warning(sprintf(
                'ConfeatureClient::setOnline: called after close (sdkKey=%s)',
                SdkKey::redact($this->sdkKey),
            ));

            return;
        }
        if ($this->localOnly) {
            $this->logger->warning(sprintf(
                'ConfeatureClient::setOnline: client is configured to use the LOCAL_ONLY override '
                . 'behaviour, thus setOnline has no effect (sdkKey=%s)',
                SdkKey::redact($this->sdkKey),
            ));

            return;
        }

        $this->offline = false;
    }

    /**
     * Suspends HTTP polling; serves the cached config. Idempotent.
     *
     * Mirrors ConfigCat\ConfigCatClient::setOffline() (spec 098 / #267 slice 9/14). Closed
     * clients log warning + no-op. LocalOnly clients are a silent no-op (LocalOnly never polls).
     */
    public function setOffline(): void
    {
        if ($this->closed) {
            $this->logger->warning(sprintf(
                'ConfeatureClient::setOffline: called after close (sdkKey=%s)',
                SdkKey::redact($this->sdkKey),
            ));

            return;
        }
        if ($this->localOnly) {
            return;
        }

        $this->offline = true;
    }

    /**
     * Returns `true` when HTTP polling is suspended.
     *
     * Mirrors ConfigCat\ConfigCatClient::isOffline() (spec 098 / #267 slice 9/14). Closed
     * clients return `true`. LocalOnly clients return `true` (LocalOnly never polls — always
     * "offline" with respect to remote config).
     */
    public function isOffline(): bool
    {
        if ($this->closed) {
            return true;
        }
        if ($this->localOnly) {
            return true;
        }

        return $this->offline;
    }

    /**
     * Spec 109 / #268 — returns the Hooks bus for subscribing lifecycle events.
     * Mirrors ConfigCat's `ConfigCatClient::hooks()`.
     */
    public function hooks(): Hooks
    {
        return $this->hooks;
    }

    public function getSnapshot(): Snapshot
    {
        $this->maybeFetch();

        return new Snapshot(
            config: $this->config,
            flagOverrides: $this->flagOverrides,
            defaultUser: $this->defaultUser,
        );
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        if ($this->fetcher !== null) {
            try {
                $this->fetcher->close();
            } catch (\Throwable $e) {
                $this->logger->warning(sprintf(
                    'ConfeatureClient::close: fetcher close raised '
                    . '(sdkKey=%s): %s',
                    SdkKey::redact($this->sdkKey),
                    $e::class,
                ));
            }
        }
    }

    /**
     * @param array<string, mixed> $options
     */
    private function extractPollingMode(array $options): PollingMode
    {
        $raw = $options['pollingMode'] ?? null;
        if ($raw === null) {
            return PollingMode::autoPoll();
        }
        if (!$raw instanceof PollingMode) {
            throw new \InvalidArgumentException('pollingMode must be a Confeature\\PollingMode');
        }

        return $raw;
    }

    /**
     * @param array<string, mixed> $options
     */
    private function extractLogger(array $options): LoggerInterface
    {
        $raw = $options['logger'] ?? null;
        if ($raw === null) {
            return Logger::default();
        }
        if (!$raw instanceof LoggerInterface) {
            throw new \InvalidArgumentException('logger must implement Psr\\Log\\LoggerInterface');
        }

        return $raw;
    }

    /**
     * @param array<string, mixed> $options
     */
    private function extractFlagOverrides(array $options): ?FlagOverrides
    {
        $raw = $options['flagOverrides'] ?? null;
        if ($raw === null) {
            return null;
        }
        if (!$raw instanceof FlagOverrides) {
            throw new \InvalidArgumentException('flagOverrides must be a Confeature\\FlagOverrides');
        }

        return $raw;
    }

    /**
     * @param array<string, mixed> $options
     */
    private function extractDefaultUser(array $options): ?User
    {
        $raw = $options['defaultUser'] ?? null;
        if ($raw === null) {
            return null;
        }
        if (!$raw instanceof User) {
            throw new \InvalidArgumentException('defaultUser must be a Confeature\\User');
        }

        return $raw;
    }

    /**
     * @param array<string, mixed> $options
     */
    private function extractCache(array $options): ?CacheInterface
    {
        if (!\array_key_exists('cache', $options)) {
            return new FilesystemCache();
        }
        $raw = $options['cache'];
        if ($raw === null) {
            return null;
        }
        if (!$raw instanceof CacheInterface) {
            throw new \InvalidArgumentException('cache must implement Psr\\SimpleCache\\CacheInterface');
        }

        return $raw;
    }

    private function loadFromCache(): void
    {
        if ($this->cache === null) {
            return;
        }
        try {
            $raw = $this->cache->get($this->cacheKey);
        } catch (\Throwable $e) {
            $this->logger->warning(sprintf(
                'ConfeatureClient: cache read raised (sdkKey=%s): %s',
                SdkKey::redact($this->sdkKey),
                $e::class,
            ));

            return;
        }
        if (!\is_string($raw) || $raw === '') {
            return;
        }
        $decoded = json_decode($raw, true);
        if (!\is_array($decoded)) {
            return;
        }
        $body = $decoded['body'] ?? null;
        if (\is_array($body)) {
            $this->config = $body;
            $etag = $decoded['etag'] ?? null;
            $this->etag = \is_string($etag) ? $etag : null;
            $fetchedAt = $decoded['fetched_at'] ?? null;
            $this->lastFetchedAt = \is_numeric($fetchedAt) ? (float) $fetchedAt : null;
        }
    }

    private function persistCache(): void
    {
        if ($this->cache === null) {
            return;
        }
        try {
            $payload = json_encode([
                'body' => $this->config,
                'etag' => $this->etag,
                'fetched_at' => $this->lastFetchedAt,
            ], \JSON_UNESCAPED_SLASHES);
            if ($payload === false) {
                return;
            }
            $this->cache->set($this->cacheKey, $payload);
        } catch (\Throwable $e) {
            $this->logger->warning(sprintf(
                'ConfeatureClient: cache write raised (sdkKey=%s): %s',
                SdkKey::redact($this->sdkKey),
                $e::class,
            ));
        }
    }

    private function maybeFetch(): void
    {
        if ($this->localOnly || $this->fetcher === null) {
            return;
        }

        if (!$this->initialFetched) {
            // AutoPoll and LazyLoad both want an eager first hit so that
            // the very first getValue is served by fresh config.
            // ManualPoll waits for an explicit forceRefresh.
            if ($this->pollingMode->kind !== PollingMode::KIND_MANUAL_POLL) {
                $this->fetchAndApply();
            }
            $this->initialFetched = true;

            return;
        }

        $now = microtime(true);
        $stale = match ($this->pollingMode->kind) {
            PollingMode::KIND_AUTO_POLL => $this->lastFetchedAt === null
                || ($now - $this->lastFetchedAt) >= $this->pollingMode->pollIntervalSeconds,
            PollingMode::KIND_LAZY_LOAD => $this->lastFetchedAt === null
                || ($now - $this->lastFetchedAt) >= $this->pollingMode->cacheRefreshIntervalSeconds,
            default => false,
        };
        if ($stale) {
            $this->fetchAndApply();
        }
    }

    /**
     * Spec 087 — millis-since-epoch of the active config's last
     * successful fetch / cache restore. Matches upstream PHP's
     * `EvaluationDetails::fetchTimeUnixMilliseconds` (float).
     *
     * Returns `0.0` until any config has loaded.
     */
    private function fetchTimeUnixMilliseconds(): float
    {
        return $this->lastFetchedAt === null
            ? 0.0
            : $this->lastFetchedAt * 1000.0;
    }

    /**
     * Spec 087 — LocalOnly branch of `getValueDetails`. The
     * override-eval helper alone cannot tell us whether the key
     * exists in the override map (it returns the default on missing
     * keys and on type-mismatch). Re-query the map to disambiguate.
     */
    private function localOnlyDetails(string $key, mixed $default, ?User $effectiveUser): EvaluationDetails
    {
        [$found, $value] = OverrideEval::evaluateSync($this->flagOverrides, $key, $default);
        $present = false;
        if ($this->flagOverrides !== null) {
            try {
                $map = $this->flagOverrides->dataSource->getOverridesSync();
                $present = \is_array($map) && \array_key_exists($key, $map);
            } catch (\Throwable) {
                $present = false;
            }
        }

        if ($found && $present) {
            return new EvaluationDetails(
                $key,
                null,
                $value,
                $effectiveUser,
                false,
                null,
                null,
                $this->fetchTimeUnixMilliseconds(),
                null,
                null,
            );
        }

        return new EvaluationDetails(
            $key,
            null,
            $default,
            $effectiveUser,
            true,
            'KEY_NOT_FOUND',
            null,
            $this->fetchTimeUnixMilliseconds(),
            null,
            null,
        );
    }

    /**
     * Spec 087 — union of cached-config flag keys + override keys.
     * Mirrors `Snapshot::getAllKeys` but inlined to avoid building a
     * fresh Snapshot for every `getAllValues` call.
     *
     * @return list<string>
     */
    private function collectAllKeys(): array
    {
        $keys = [];
        if (\is_array($this->config) && isset($this->config['f']) && \is_array($this->config['f'])) {
            foreach (array_keys($this->config['f']) as $k) {
                if (\is_string($k)) {
                    $keys[] = $k;
                }
            }
        }
        if ($this->flagOverrides !== null) {
            try {
                $overrideMap = $this->flagOverrides->dataSource->getOverridesSync();
            } catch (\Throwable) {
                $overrideMap = null;
            }
            if (\is_array($overrideMap)) {
                foreach (array_keys($overrideMap) as $k) {
                    if (\is_string($k)) {
                        $keys[] = $k;
                    }
                }
            }
        }

        return array_values(array_unique($keys));
    }

    private function fetchAndApply(): FetchResult
    {
        if ($this->fetcher === null) {
            return new FetchResult(FetchResult::STATUS_FAILED, error: 'NO_FETCHER');
        }
        if ($this->offline) {
            // Spec 098 / #267 — covers AutoPoll / LazyLoad maybeFetch / ManualPoll forceRefresh.
            return new FetchResult(FetchResult::STATUS_FAILED, error: 'OFFLINE_MODE');
        }
        $result = $this->fetcher->fetch($this->etag);
        switch ($result->status) {
            case FetchResult::STATUS_FETCHED:
                if (\is_array($result->body)) {
                    $this->config = $result->body;
                    $this->etag = $result->etag;
                    $this->lastFetchedAt = microtime(true);
                    $this->persistCache();
                    // Hook bus (spec 109 / #268) — fire configChanged with new settings.
                    $this->hooks->fireOnConfigChanged($result->body);
                }
                break;
            case FetchResult::STATUS_NOT_MODIFIED:
                if ($result->etag !== null) {
                    $this->etag = $result->etag;
                }
                $this->lastFetchedAt = microtime(true);
                break;
            case FetchResult::STATUS_FAILED:
            default:
                // Hook bus (spec 109 / #268) — fire error on fetch failure.
                $this->hooks->fireOnError($result->error ?? 'Config fetch failed.');
                break;
        }

        return $result;
    }
}
