<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel as PsrLogLevel;
use Stringable;

/**
 * Pluggable logger surface.
 *
 * Customers integrate by either:
 *   - passing any PSR-3 `LoggerInterface` (e.g. monolog) via the
 *     client's `logger` option, or
 *   - keeping the default `Logger` which wraps stderr writes at
 *     `LogLevel::WARNING`.
 *
 * The Confeature SDK code path interacts ONLY with the PSR-3 surface
 * (`debug`/`info`/`warning`/`error`) — this class is the default
 * implementation, not a required base class.
 */
final class Logger extends AbstractLogger
{
    private int $level;

    /** @var resource */
    private $stream;

    /**
     * @param resource|null $stream Defaults to STDERR.
     */
    public function __construct(int $level = LogLevel::WARNING, $stream = null)
    {
        $this->level = $level;
        $this->stream = $stream ?? STDERR;
    }

    public function level(): int
    {
        return $this->level;
    }

    /**
     * @param mixed             $level
     * @param string|Stringable $message
     * @param array<mixed>      $context
     */
    public function log($level, string|Stringable $message, array $context = []): void
    {
        $confeatureLevel = self::psrToConfeatureLevel((string) $level);
        if ($confeatureLevel < $this->level) {
            return;
        }
        $line = '[' . self::labelFor($confeatureLevel) . '] confeature: ' . (string) $message . "\n";
        @fwrite($this->stream, $line);
    }

    private static function psrToConfeatureLevel(string $psrLevel): int
    {
        return match ($psrLevel) {
            PsrLogLevel::DEBUG => LogLevel::DEBUG,
            PsrLogLevel::INFO, PsrLogLevel::NOTICE => LogLevel::INFO,
            PsrLogLevel::WARNING => LogLevel::WARNING,
            PsrLogLevel::ERROR, PsrLogLevel::CRITICAL, PsrLogLevel::ALERT, PsrLogLevel::EMERGENCY => LogLevel::ERROR,
            default => LogLevel::WARNING,
        };
    }

    private static function labelFor(int $level): string
    {
        return match ($level) {
            LogLevel::DEBUG => 'DEBUG',
            LogLevel::INFO => 'INFO',
            LogLevel::WARNING => 'WARN',
            LogLevel::ERROR => 'ERROR',
            default => 'LOG',
        };
    }

    /**
     * Build the SDK's default logger — stderr, WARNING level.
     */
    public static function default(): LoggerInterface
    {
        return new self();
    }
}
