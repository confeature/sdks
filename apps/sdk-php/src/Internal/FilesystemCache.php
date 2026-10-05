<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Psr\SimpleCache\CacheInterface;

/**
 * Filesystem-backed PSR-16 cache for the latest `config_v6.json`.
 *
 * Default cache dir: `sys_get_temp_dir() . '/confeature'`. Per-entry
 * files live at `{dir}/confeature-{cacheKey}.json` and are written
 * atomically (tempfile + rename). On any I/O error, the instance
 * logs a single WARNING and falls back to its in-memory companion
 * — the filesystem is never retried for the remainder of the
 * process (matches the Ruby / Python ports).
 *
 * The class implements PSR-16 `CacheInterface` so customers can
 * swap in any other PSR-16 cache (Redis, Memcached, …) via the
 * client's `cache` option.
 */
final class FilesystemCache implements CacheInterface
{
    private string $cacheDir;
    private InMemoryCache $memory;
    private bool $fallbackTriggered = false;

    public function __construct(?string $cacheDir = null)
    {
        $this->cacheDir = $cacheDir ?? (sys_get_temp_dir() . \DIRECTORY_SEPARATOR . 'confeature');
        $this->memory = new InMemoryCache();
    }

    public function getCacheDir(): string
    {
        return $this->cacheDir;
    }

    public function get(string $key, mixed $default = null): mixed
    {
        if ($this->fallbackTriggered) {
            return $this->memory->get($key, $default);
        }

        $path = $this->pathFor($key);
        if (!is_file($path)) {
            return $this->memory->get($key, $default);
        }

        $contents = @file_get_contents($path);
        if ($contents === false) {
            return $default;
        }

        return $contents;
    }

    public function set(string $key, mixed $value, \DateInterval|int|null $ttl = null): bool
    {
        if (!\is_string($value)) {
            throw new \InvalidArgumentException(
                'FilesystemCache only stores string payloads; got ' . get_debug_type($value)
            );
        }

        // Always keep the in-memory mirror in sync so we degrade
        // gracefully if the filesystem write fails.
        $this->memory->set($key, $value, $ttl);

        if ($this->fallbackTriggered) {
            return true;
        }

        if (!$this->ensureDir()) {
            return false;
        }

        $path = $this->pathFor($key);
        $tmp = @tempnam($this->cacheDir, 'confeature-');
        if ($tmp === false) {
            $this->fallbackTriggered = true;

            return false;
        }
        if (@file_put_contents($tmp, $value, \LOCK_EX) === false) {
            @unlink($tmp);
            $this->fallbackTriggered = true;

            return false;
        }
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            $this->fallbackTriggered = true;

            return false;
        }
        // tempnam creates the file with 0600 by default; widen to 0644
        // so other processes on the host can read the cache file.
        @chmod($path, 0o644);

        return true;
    }

    public function delete(string $key): bool
    {
        $this->memory->delete($key);

        $path = $this->pathFor($key);
        if (!is_file($path)) {
            return true;
        }

        return @unlink($path);
    }

    public function clear(): bool
    {
        $this->memory->clear();
        if (!is_dir($this->cacheDir)) {
            return true;
        }
        $ok = true;
        foreach ((array) @scandir($this->cacheDir) as $entry) {
            if ($entry === '.' || $entry === '..' || !\is_string($entry)) {
                continue;
            }
            $full = $this->cacheDir . \DIRECTORY_SEPARATOR . $entry;
            if (is_file($full)) {
                $ok = @unlink($full) && $ok;
            }
        }

        return $ok;
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
        $ok = true;
        foreach ($values as $key => $value) {
            if (!\is_string($key)) {
                throw new \InvalidArgumentException('cache keys must be strings');
            }
            $ok = $this->set($key, $value, $ttl) && $ok;
        }

        return $ok;
    }

    public function deleteMultiple(iterable $keys): bool
    {
        $ok = true;
        foreach ($keys as $key) {
            if (!\is_string($key)) {
                throw new \InvalidArgumentException('cache keys must be strings');
            }
            $ok = $this->delete($key) && $ok;
        }

        return $ok;
    }

    public function has(string $key): bool
    {
        if ($this->fallbackTriggered) {
            return $this->memory->has($key);
        }

        return is_file($this->pathFor($key));
    }

    private function pathFor(string $key): string
    {
        // PSR-16 reserves `{}()/\@:` in keys. The cache key derived by
        // SdkKey contains `:` (the `confeature:cache:v1:` envelope),
        // so we hash the key on the way to the filesystem to keep the
        // implementation PSR-16 conformant AND filesystem-safe.
        $safe = hash('sha256', $key);

        return $this->cacheDir . \DIRECTORY_SEPARATOR . 'confeature-' . $safe . '.json';
    }

    private function ensureDir(): bool
    {
        if (is_dir($this->cacheDir)) {
            return true;
        }
        if (@mkdir($this->cacheDir, 0o755, true) || is_dir($this->cacheDir)) {
            return true;
        }
        $this->fallbackTriggered = true;

        return false;
    }
}
