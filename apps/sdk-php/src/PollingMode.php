<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Polling-mode value object + factory.
 *
 * Mirrors the upstream `configcat/configcat-php-sdk` `PollingMode`
 * class: three static factory methods produce immutable value objects
 * that the client wires into the matching evaluation path.
 *
 * PHP's synchronous CLI execution model has no daemon threads — so
 * AutoPoll is implemented as a staleness-driven lazy-load (refresh
 * the in-memory config when older than `$pollIntervalSeconds`), which
 * matches the upstream ConfigCat PHP SDK behaviour exactly.
 */
final class PollingMode
{
    public const KIND_AUTO_POLL = 'auto_poll';
    public const KIND_LAZY_LOAD = 'lazy_load';
    public const KIND_MANUAL_POLL = 'manual_poll';

    public readonly string $kind;
    public readonly int $pollIntervalSeconds;
    public readonly int $maxInitWaitTimeSeconds;
    public readonly int $cacheRefreshIntervalSeconds;

    private function __construct(
        string $kind,
        int $pollIntervalSeconds,
        int $maxInitWaitTimeSeconds,
        int $cacheRefreshIntervalSeconds,
    ) {
        $this->kind = $kind;
        $this->pollIntervalSeconds = $pollIntervalSeconds;
        $this->maxInitWaitTimeSeconds = $maxInitWaitTimeSeconds;
        $this->cacheRefreshIntervalSeconds = $cacheRefreshIntervalSeconds;
    }

    public static function autoPoll(int $pollInterval = 60, int $maxInitWaitTime = 5): self
    {
        if ($pollInterval <= 0) {
            throw new \InvalidArgumentException('pollInterval must be > 0; got ' . $pollInterval);
        }
        if ($maxInitWaitTime < 0) {
            throw new \InvalidArgumentException('maxInitWaitTime must be >= 0; got ' . $maxInitWaitTime);
        }

        return new self(self::KIND_AUTO_POLL, $pollInterval, $maxInitWaitTime, 0);
    }

    public static function lazyLoad(int $cacheRefreshInterval = 60): self
    {
        if ($cacheRefreshInterval <= 0) {
            throw new \InvalidArgumentException('cacheRefreshInterval must be > 0; got ' . $cacheRefreshInterval);
        }

        return new self(self::KIND_LAZY_LOAD, 0, 0, $cacheRefreshInterval);
    }

    public static function manualPoll(): self
    {
        return new self(self::KIND_MANUAL_POLL, 0, 0, 0);
    }
}
