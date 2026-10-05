<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\Evaluator;
use Confeature\Internal\TraceLevel;
use Confeature\Internal\TraceSink;
use PHPUnit\Framework\TestCase;

/**
 * Evaluation-log TRACE fidelity (ADR 0003 / epic #494, PHP slice of #501).
 *
 * Replays `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`
 * — each scenario tuple carries an `expectedTrace` byte-string — and asserts the
 * federated PHP evaluator emits the byte-identical textual trace. Mirrors the
 * Ruby reference (`spec/parity_upstream_spec.rb`'s trace example), the Python
 * `test_eval_log_trace_fidelity`, the Go `parity_evallog_trace_test.go`, and the
 * TS `assertEvalLogTrace`: a capturing sink records every (level, eventId,
 * message) the evaluator emits during the walk (the WARN 3001/3003/3004 + ERROR
 * 1002 lines, then the INFO 5000 multi-line trace); each call is rendered
 * `"<LEVEL>: [<eventId>] <message>"` and joined with "\n". `expectedTrace` is
 * already Confeature-canonical, so this is the same byte-string every native
 * runner replays.
 */
final class EvalLogTraceCorpusTest extends TestCase
{
    /** The 14 scenarios that carry an `expectedTrace` (others assert value only). */
    private const TRACE_SCENARIOS = [
        'simple_value', '1_targeting_rule', '2_targeting_rules', 'and_rules',
        'options_based_on_user_id', 'options_based_on_custom_attr',
        'options_after_targeting_rule', 'options_within_targeting_rule',
        'list_truncation', 'number_validation', 'circular_dep', 'prerequisite_flag',
        'semver_validation', 'epoch_date_validation',
    ];

    private const LEVEL_LABEL = [
        TraceLevel::ERROR => 'ERROR',
        TraceLevel::WARN => 'WARN',
        TraceLevel::INFO => 'INFO',
        TraceLevel::DEBUG => 'DEBUG',
    ];

    public function testEmitsByteIdenticalTraceForEveryTraceBearingScenario(): void
    {
        $tuples = WorkspaceRoot::parityEvaluationLog();
        self::assertNotEmpty($tuples, 'parity-evaluationlog.json produced no tuples');

        $failures = [];
        $seen = [];
        foreach ($tuples as $tuple) {
            $expected = $tuple['expectedTrace'] ?? null;
            $scenario = $tuple['scenario'] ?? null;
            if (!\is_string($expected) || !\is_string($scenario) || !\in_array($scenario, self::TRACE_SCENARIOS, true)) {
                continue;
            }
            $seen[$scenario] = ($seen[$scenario] ?? 0) + 1;
            self::assertTraceTuple($tuple, $expected, $failures);
        }

        self::assertSame(
            [],
            $failures,
            \count($failures) . " drift:\n" . implode("\n\n", $failures),
        );

        // Every trace-bearing scenario must have been asserted (guards a silently
        // shrinking oracle / a renamed scenario).
        $missing = array_values(array_filter(
            self::TRACE_SCENARIOS,
            static fn (string $s): bool => ($seen[$s] ?? 0) < 1,
        ));
        self::assertSame([], $missing, 'scenarios with no asserted tuples: ' . implode(', ', $missing));
    }

    /**
     * @param array<string, mixed> $tuple
     * @param list<string>         $failures
     */
    private static function assertTraceTuple(array $tuple, string $expected, array &$failures): void
    {
        $sink = new CaptureTraceSink();
        $config = $tuple['config'] ?? null;
        $key = (string) ($tuple['key'] ?? '');
        $user = self::traceUser(\is_array($tuple['user'] ?? null) ? $tuple['user'] : null);
        $default = self::traceDefault($tuple['defaultValue'] ?? null, $config, $key);

        Evaluator::evaluateTraced($config, $key, $default, $user, $sink);
        $actual = self::reconstructTrace($sink);
        if ($actual === $expected) {
            return;
        }
        $failures[] = "trace mismatch for {$tuple['scenario']}/{$key}\n"
            . "--- want ---\n{$expected}\n--- got ---\n{$actual}";
    }

    /**
     * Build a User from the tuple's LOWERCASE user object (port `traceUser`):
     * `{identifier, email?, country?, custom?}`. Custom values are fed
     * un-stringified so the typed-attribute conversion cases are exercised.
     *
     * @param array<string, mixed>|null $raw
     */
    private static function traceUser(?array $raw): ?CorpusUser
    {
        if ($raw === null || $raw === []) {
            return null;
        }
        $custom = $raw['custom'] ?? null;

        return new CorpusUser(
            \is_string($raw['identifier'] ?? null) ? $raw['identifier'] : '',
            \is_string($raw['email'] ?? null) ? $raw['email'] : null,
            \is_string($raw['country'] ?? null) ? $raw['country'] : null,
            \is_array($custom) && $custom !== [] ? $custom : null,
        );
    }

    /**
     * Coerce the JSON-decoded default to the type the setting expects. JSON
     * decodes every integral number to int; the strict evaluator wants a float
     * for a double setting (`t=3`) — a wrong-kind numeric default would
     * TYPE_MISMATCH before the trace (e.g. `doubleDefaultPi`).
     */
    private static function traceDefault(mixed $default, mixed $config, string $key): mixed
    {
        if (\is_bool($default) || (!\is_int($default) && !\is_float($default))) {
            return $default;
        }
        $settings = \is_array($config) ? ($config['f'] ?? null) : null;
        $setting = \is_array($settings) ? ($settings[$key] ?? null) : null;
        $t = \is_array($setting) ? ($setting['t'] ?? null) : null;
        if ($t === Evaluator::SETTING_TYPE_DOUBLE) {
            return (float) $default;
        }
        if ($t === Evaluator::SETTING_TYPE_INT) {
            return (int) $default;
        }

        return $default;
    }

    private static function reconstructTrace(CaptureTraceSink $sink): string
    {
        $lines = [];
        foreach ($sink->calls as [$level, $eventId, $message]) {
            $label = self::LEVEL_LABEL[$level] ?? (string) $level;
            $lines[] = "{$label}: [{$eventId}] {$message}";
        }

        return implode("\n", $lines);
    }
}

/**
 * Records each emitted (level, eventId, message) for the capture string.
 * Mirrors the Go/Python/Ruby tests' inline logger. `level()` reports INFO so the
 * evaluator builds the trace; `log()` appends each emitted line.
 */
final class CaptureTraceSink implements TraceSink
{
    /** @var list<array{0: int, 1: string, 2: string}> */
    public array $calls = [];

    public function level(): int
    {
        return TraceLevel::INFO;
    }

    public function log(int $level, string $eventId, string $message): void
    {
        $this->calls[] = [$level, $eventId, $message];
    }
}
