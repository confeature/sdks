<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Psr\SimpleCache\CacheInterface;

/**
 * Process-local PSR-16 cache.
 *
 * Used as the default fallback when the filesystem cache cannot
 * write (read-only $TMPDIR, broken permissions, …) and as the
 * customer-facing option when they pass `cache: null` to disable
 * filesystem persistence entirely.
 */
final class InMemoryCache implements CacheInterface
{
    /** @var array<string, array{value: mixed, expires_at: ?float}> */
    private array $store = [];

    public function get(string $key, mixed $default = null): mixed
    {
        if (!isset($this->store[$key])) {
            return $default;
        }
        $entry = $this->store[$key];
        if ($entry['expires_at'] !== null && $entry['expires_at'] < microtime(true)) {
            unset($this->store[$key]);

            return $default;
        }

        return $entry['value'];
    }

    public function set(string $key, mixed $value, \DateInterval|int|null $ttl = null): bool
    {
        $this->store[$key] = [
            'value' => $value,
            'expires_at' => $this->expiresAt($ttl),
        ];

        return true;
    }

    public function delete(string $key): bool
    {
        unset($this->store[$key]);

        return true;
    }

    public function clear(): bool
    {
        $this->store = [];

        return true;
    }

    public function getMultiple(iterable $keys, mixed $default = null): iterable
    {
        $out = [];
        foreach ($keys as $key) {
            if (!\is_string($key)) {
                throw new \InvalidArgumentException('cache keys must be strings');
            }
            $out[$key] = $this->get($key, $default);
        }

        return $out;
    }

    public function setMultiple(iterable $values, \DateInterval|int|null $ttl = null): bool
    {
        foreach ($values as $key => $value) {
            if (!\is_string($key)) {
                throw new \InvalidArgumentException('cache keys must be strings');
            }
            $this->set($key, $value, $ttl);
        }

        return true;
    }

    public function deleteMultiple(iterable $keys): bool
    {
        foreach ($keys as $key) {
            if (!\is_string($key)) {
                throw new \InvalidArgumentException('cache keys must be strings');
            }
            $this->delete($key);
        }

        return true;
    }

    public function has(string $key): bool
    {
        return $this->get($key, $this) !== $this;
    }

    private function expiresAt(\DateInterval|int|null $ttl): ?float
    {
        if ($ttl === null) {
            return null;
        }
        if (\is_int($ttl)) {
            return microtime(true) + $ttl;
        }
        $now = new \DateTimeImmutable();
        $future = $now->add($ttl);

        return (float) $future->getTimestamp();
    }
}
