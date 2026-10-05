<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Logger;
use Confeature\LogLevel;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel as PsrLogLevel;

/**
 * Verify the default `Confeature\Logger` honours its level threshold
 * and emits PSR-3-shaped lines to the supplied stream.
 *
 * Every test wires a `php://memory` stream so we can assert against
 * the captured output without touching stderr.
 */
final class LoggerTest extends TestCase
{
    public function testDefaultFactoryReturnsLoggerInterface(): void
    {
        $logger = Logger::default();
        self::assertInstanceOf(LoggerInterface::class, $logger);
    }

    public function testWarningLineWrittenAtWarningLevel(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::WARNING, $stream);
        $logger->warning('hello');
        self::assertSame("[WARN] confeature: hello\n", self::readStream($stream));
    }

    public function testErrorLineWrittenAtWarningLevel(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::WARNING, $stream);
        $logger->error('boom');
        self::assertSame("[ERROR] confeature: boom\n", self::readStream($stream));
    }

    public function testInfoLineSilencedAtWarningLevel(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::WARNING, $stream);
        $logger->info('ignored');
        self::assertSame('', self::readStream($stream));
    }

    public function testDebugLineEmittedWhenLevelIsDebug(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::DEBUG, $stream);
        $logger->debug('trace');
        self::assertSame("[DEBUG] confeature: trace\n", self::readStream($stream));
    }

    public function testOffLevelSilencesEverything(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::OFF, $stream);
        $logger->error('still nothing');
        $logger->warning('also nothing');
        self::assertSame('', self::readStream($stream));
    }

    public function testLevelGetter(): void
    {
        $logger = new Logger(LogLevel::ERROR);
        self::assertSame(LogLevel::ERROR, $logger->level());
    }

    public function testUnknownPsrLevelMapsToWarning(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::WARNING, $stream);
        $logger->log('not-a-real-level', 'msg');
        self::assertSame("[WARN] confeature: msg\n", self::readStream($stream));
    }

    public function testCriticalEmittedAsErrorLine(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::WARNING, $stream);
        $logger->log(PsrLogLevel::CRITICAL, 'critical-msg');
        self::assertSame("[ERROR] confeature: critical-msg\n", self::readStream($stream));
    }

    public function testNoticeEmittedAsInfoLineWhenInfoEnabled(): void
    {
        $stream = self::openMemoryStream();
        $logger = new Logger(LogLevel::INFO, $stream);
        $logger->log(PsrLogLevel::NOTICE, 'notice-msg');
        self::assertSame("[INFO] confeature: notice-msg\n", self::readStream($stream));
    }

    /**
     * @return resource
     */
    private static function openMemoryStream()
    {
        $stream = fopen('php://memory', 'w+');
        if ($stream === false) {
            self::fail('Could not open php://memory');
        }

        return $stream;
    }

    /**
     * @param resource $stream
     */
    private static function readStream($stream): string
    {
        rewind($stream);
        $contents = stream_get_contents($stream);

        return $contents === false ? '' : $contents;
    }
}
