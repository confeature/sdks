<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\Evaluator;
use PHPUnit\Framework\TestCase;

/**
 * Exercises the four-type evaluator's error-tagging contract. The
 * parity corpus covers the happy paths byte-for-byte across all four
 * SettingTypes — this file pins the explicit failure-mode error strings
 * and the per-type strict-default guards (spec 072, issue #259).
 */
final class EvaluatorTest extends TestCase
{
    public function testNullConfigReturnsDefaultWithNoConfig(): void
    {
        $result = Evaluator::evaluate(null, 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('NO_CONFIG', $result->error);
    }

    public function testMalformedConfigReturnsDefaultWithMalformedConfig(): void
    {
        $result = Evaluator::evaluate(['no-settings-key' => true], 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('MALFORMED_CONFIG', $result->error);
    }

    public function testMissingKeyReturnsDefaultWithKeyNotFound(): void
    {
        $config = ['f' => []];
        $result = Evaluator::evaluate($config, 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('KEY_NOT_FOUND', $result->error);
    }

    /**
     * Spec 072 (#259) reshape: UNSUPPORTED_TYPE now applies only to a
     * GENUINELY unknown `t` (not present in the SettingType enum).
     * The pre-existing "non-boolean setting → UNSUPPORTED_TYPE" check
     * is replaced — non-boolean settings now resolve via the widened
     * evaluator.
     */
    public function testGenuinelyUnknownSettingTypeReturnsUnsupportedType(): void
    {
        $config = [
            'f' => [
                'feature.dark' => [
                    't' => 99, // not one of 0/1/2/3
                    'v' => ['b' => true],
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('UNSUPPORTED_TYPE', $result->error);
    }

    public function testNonBooleanDefaultReturnsTypeMismatch(): void
    {
        $config = [
            'f' => [
                'feature.dark' => [
                    't' => 0,
                    'v' => ['b' => true],
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.dark', 'not-a-bool');
        self::assertSame('not-a-bool', $result->value);
        self::assertSame('TYPE_MISMATCH', $result->error);
    }

    public function testHappyPathReturnsCachedValue(): void
    {
        $config = [
            'f' => [
                'feature.dark' => [
                    't' => 0,
                    'v' => ['b' => true],
                    'i' => 'v-dark',
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.dark', false);
        self::assertTrue($result->value);
        self::assertNull($result->error);
        self::assertSame('v-dark', $result->variationId);
        self::assertTrue($result->ok());
    }

    public function testMissingValueSlotReturnsMalformedValue(): void
    {
        $config = [
            'f' => [
                'feature.dark' => [
                    't' => 0,
                    'v' => 'not-an-array',
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('MALFORMED_VALUE', $result->error);
    }

    public function testValueSlotNotBoolReturnsValueNotBool(): void
    {
        $config = [
            'f' => [
                'feature.dark' => [
                    't' => 0,
                    'v' => ['b' => 'true'],
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.dark', false);
        self::assertSame(false, $result->value);
        self::assertSame('VALUE_NOT_BOOL', $result->error);
    }

    // ── Typed-value resolution (spec 072, #259) ─────────────────────

    public function testTypedStringSettingResolvesToString(): void
    {
        $config = [
            'f' => [
                'feature.welcome' => [
                    't' => 1,
                    'v' => ['s' => 'hello'],
                    'i' => 'v-welcome',
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.welcome', 'fallback');
        self::assertSame('hello', $result->value);
        self::assertNull($result->error);
        self::assertSame('v-welcome', $result->variationId);
    }

    public function testTypedIntSettingResolvesToInt(): void
    {
        $config = [
            'f' => [
                'feature.max-retries' => [
                    't' => 2,
                    'v' => ['i' => 5],
                    'i' => 'v-retries',
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.max-retries', -1);
        self::assertSame(5, $result->value);
        self::assertNull($result->error);
        self::assertSame('v-retries', $result->variationId);
    }

    public function testTypedDoubleSettingResolvesToFloat(): void
    {
        $config = [
            'f' => [
                'feature.sample-rate' => [
                    't' => 3,
                    'v' => ['d' => 0.25],
                    'i' => 'v-rate',
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'feature.sample-rate', 0.0);
        self::assertSame(0.25, $result->value);
        self::assertNull($result->error);
    }

    public function testIntDefaultAgainstStringSettingIsTypeMismatch(): void
    {
        $config = [
            'f' => ['k' => ['t' => 1, 'v' => ['s' => 'hello']]],
        ];
        $result = Evaluator::evaluate($config, 'k', 42);
        self::assertSame(42, $result->value);
        self::assertSame('TYPE_MISMATCH', $result->error);
    }

    public function testStringDefaultAgainstIntSettingIsTypeMismatch(): void
    {
        $config = [
            'f' => ['k' => ['t' => 2, 'v' => ['i' => 5]]],
        ];
        $result = Evaluator::evaluate($config, 'k', 'fallback');
        self::assertSame('fallback', $result->value);
        self::assertSame('TYPE_MISMATCH', $result->error);
    }

    public function testIntDefaultAgainstDoubleSettingIsTypeMismatch(): void
    {
        // Strict — `is_float(5)` is false in PHP. Int defaults against
        // a t:3 setting refuse with TYPE_MISMATCH (matches ConfigCat-PHP).
        $config = [
            'f' => ['k' => ['t' => 3, 'v' => ['d' => 0.25]]],
        ];
        $result = Evaluator::evaluate($config, 'k', 5);
        self::assertSame(5, $result->value);
        self::assertSame('TYPE_MISMATCH', $result->error);
    }

    public function testBoolDefaultAgainstIntSettingIsTypeMismatch(): void
    {
        // PHP's `is_int(true)` is already false — but we assert the
        // path explicitly so a future refactor cannot silently break
        // the boolean/int separation.
        $config = [
            'f' => ['k' => ['t' => 2, 'v' => ['i' => 5]]],
        ];
        $result = Evaluator::evaluate($config, 'k', true);
        self::assertTrue($result->value);
        self::assertSame('TYPE_MISMATCH', $result->error);
    }

    public function testTypedStringMissingSlotIsMalformedValue(): void
    {
        $config = [
            'f' => ['k' => ['t' => 1, 'v' => ['b' => true]]],
        ];
        $result = Evaluator::evaluate($config, 'k', 'fallback');
        self::assertSame('fallback', $result->value);
        self::assertSame('MALFORMED_VALUE', $result->error);
    }

    public function testTypedIntNonIntegerSlotIsMalformedValue(): void
    {
        $config = [
            'f' => ['k' => ['t' => 2, 'v' => ['i' => 'five']]],
        ];
        $result = Evaluator::evaluate($config, 'k', -1);
        self::assertSame(-1, $result->value);
        self::assertSame('MALFORMED_VALUE', $result->error);
    }

    public function testTypedDoubleMissingSlotIsMalformedValue(): void
    {
        $config = [
            'f' => ['k' => ['t' => 3, 'v' => ['s' => '0.25']]],
        ];
        $result = Evaluator::evaluate($config, 'k', 0.0);
        self::assertSame(0.0, $result->value);
        self::assertSame('MALFORMED_VALUE', $result->error);
    }
}
