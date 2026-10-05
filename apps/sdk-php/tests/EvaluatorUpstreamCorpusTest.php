<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\Evaluator;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * ConfigCat conformance gate (spec 121, SC-001) — the PHP engine replays the
 * vendored upstream evaluation matrix. Mirrors the spec-117 TS reference suite
 * (`packages/sdk-shared/tests/parity-upstream.test.ts`) and the spec-118/119/120
 * Python / Go / Ruby ports. The corpus
 * (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
 * `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is the
 * oracle: each `(config, key, user) → expected` tuple is checked against
 * `Evaluator::evaluateWith(...)->value` (and `->variationId` for the
 * variation-id matrix).
 *
 * Scope = the full conformance surface: US1 targeting rules, US2 the 36
 * comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
 * multilevel + circular detection) / AND-groups, US5 attribute conversion +
 * trimming + typed-attribute validation + variationId / matched detail. Per
 * FR-017 only structured value / identity is asserted — never a textual trace.
 *
 * The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
 * faithfully — most critically the Go `csv.Reader` LazyQuotes semantics (a `"`
 * only opens a quoted field at the field start), without which every JSON-array
 * attribute cell is corrupted. The CSV is parsed by a hand-rolled LazyQuotes
 * reader rather than a library; `str_getcsv` mis-parses the LazyQuotes
 * JSON-array cells.
 *
 * Custom attributes are fed through {@link CorpusUser} (a typed value object the
 * evaluator reads duck-typed) so the conversion-driver cases can deliver numbers
 * / arrays / epochs un-stringified — the public `Confeature\User` stringifies
 * custom values by contract, which would defeat those cases.
 */
final class EvaluatorUpstreamCorpusTest extends TestCase
{
    private const NULL_TOKEN = '##null##';

    private const PKD = 'configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/';
    private const JCP = 'configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/';

    /**
     * `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob
     * was NOT captured by the spec-117 vendoring (known DATA gap #401, not an
     * engine gap). The multilevel-prerequisite path IS exercised by the 3-level
     * circular_dep chain + the reconstructed-chain test below. Excluded LOUDLY
     * (the same marker the TS / Python / Ruby references use), never silently.
     */
    private const UNVENDORED_EVAL_LOG_KEYS = ['dependentFeatureMultipleLevels'];

    /** @var array<string, mixed>|null */
    private static ?array $contentByKeyCache = null;

    /** @var array<string, mixed>|null */
    private static ?array $evalLogConfigsCache = null;

    // -----------------------------------------------------------------------
    // Matrix → SDK key mapping (verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    /**
     * @return array{matrix: string, sdkKey: string, kind: string}|null
     */
    private static function matrixEntry(string $matrix): ?array
    {
        $map = [
            ['matrix' => 'testmatrix.csv', 'sdkKey' => self::PKD . 'AG6C1ngVb0CvM07un6JisQ', 'kind' => 'value'],
            ['matrix' => 'testmatrix_semantic.csv', 'sdkKey' => self::PKD . 'iV8vH2MBakKxkFZylxHmTg', 'kind' => 'value'],
            ['matrix' => 'testmatrix_number.csv', 'sdkKey' => self::PKD . 'FCWN-k1dV0iBf8QZrDgjdw', 'kind' => 'value'],
            ['matrix' => 'testmatrix_semantic_2.csv', 'sdkKey' => self::PKD . 'U8nt3zEhDEO5S2ulubCopA', 'kind' => 'value'],
            ['matrix' => 'testmatrix_sensitive.csv', 'sdkKey' => self::PKD . '-0YmVOUNgEGKkgRF-rU65g', 'kind' => 'value'],
            ['matrix' => 'testmatrix_segments_old.csv', 'sdkKey' => self::PKD . 'y_ZB7o-Xb0Swxth-ZlMSeA', 'kind' => 'value'],
            ['matrix' => 'testmatrix_and_or.csv', 'sdkKey' => self::JCP . 'ByMO9yZNn02kXcm72lnY1A', 'kind' => 'value'],
            ['matrix' => 'testmatrix_comparators_v6.csv', 'sdkKey' => self::JCP . 'OfQqcTjfFUGBwMKqtyEOrQ', 'kind' => 'value'],
            ['matrix' => 'testmatrix_prerequisite_flag.csv', 'sdkKey' => self::JCP . 'JoGwdqJZQ0K2xDy7LnbyOg', 'kind' => 'value'],
            ['matrix' => 'testmatrix_segments.csv', 'sdkKey' => self::JCP . 'h99HYXWWNE2bH8eWyLAVMA', 'kind' => 'value'],
            ['matrix' => 'testmatrix_unicode.csv', 'sdkKey' => self::JCP . 'Da6w8dBbmUeMUBhh0iEeQQ', 'kind' => 'value'],
            ['matrix' => 'testmatrix_variationId.csv', 'sdkKey' => self::PKD . 'spQnkRTIPEWVivZkWM84lQ', 'kind' => 'variation'],
        ];
        foreach ($map as $entry) {
            if ($entry['matrix'] === $matrix) {
                return $entry;
            }
        }

        return null;
    }

    // -----------------------------------------------------------------------
    // Config loaders (cached).
    // -----------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    private static function contentByKey(): array
    {
        return self::$contentByKeyCache ??= WorkspaceRoot::upstreamJson('content-by-key.json');
    }

    /**
     * @return array<string, mixed>
     */
    private static function evalLogConfigs(): array
    {
        return self::$evalLogConfigsCache ??= WorkspaceRoot::upstreamJson('evaluationlog/_configs-by-key.json');
    }

    // -----------------------------------------------------------------------
    // CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port). A
    // `"` only opens a quoted field when it is the FIRST char of the field;
    // anywhere else it is a literal quote. Getting this wrong corrupts every
    // JSON-array attribute cell.
    // -----------------------------------------------------------------------

    /**
     * @return list<string>
     */
    private static function parseCsvLine(string $line): array
    {
        $fields = [];
        $field = '';
        $inQuotes = false;
        $fieldStart = true;
        $i = 0;
        $n = \strlen($line);
        while ($i < $n) {
            $ch = $line[$i];
            if ($inQuotes && $ch === '"' && $i + 1 < $n && $line[$i + 1] === '"') {
                $field .= '"';
                ++$i;
            } elseif ($inQuotes && $ch === '"') {
                $inQuotes = false;
            } elseif ($inQuotes) {
                $field .= $ch;
            } elseif ($ch === '"' && $fieldStart) {
                $inQuotes = true;
                $fieldStart = false;
            } elseif ($ch === ';') {
                $fields[] = $field;
                $field = '';
                $fieldStart = true;
            } else {
                $field .= $ch;
                $fieldStart = false;
            }
            ++$i;
        }
        $fields[] = $field;

        return $fields;
    }

    /**
     * Parse a CSV cell to its primitive (mirrors upstream `parseCell`).
     */
    private static function parseCell(string $s): bool|int|float|string
    {
        if (preg_match('/^-?\d+$/', $s) === 1) {
            $n = (int) $s;
            if (abs($n) <= 9007199254740991 && (string) $n === $s) {
                return $n;
            }
        }
        if (preg_match('/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $s) === 1) {
            return (float) $s;
        }
        if ($s === 'True') {
            return true;
        }
        if ($s === 'False') {
            return false;
        }

        return $s;
    }

    /**
     * Build a CorpusUser from the first four CSV columns (port `userFromRow`).
     *
     * @param list<string> $line
     */
    private static function userFromRow(array $line, string $customKey): ?CorpusUser
    {
        if ($line === [] || ($line[0] ?? '') === self::NULL_TOKEN) {
            return null;
        }
        $setOrNull = static fn (?string $v): ?string => ($v === null || $v === '' || $v === self::NULL_TOKEN) ? null : $v;

        $identifier = ($line[0] ?? '') !== '' ? $line[0] : '';
        $email = $setOrNull($line[1] ?? null);
        $country = $setOrNull($line[2] ?? null);
        $customVal = $setOrNull($line[3] ?? null);
        $custom = $customVal === null ? null : [$customKey => $customVal];

        return new CorpusUser($identifier, $email, $country, $custom);
    }

    /**
     * @return list<array{matrix: string, key: string, user: ?CorpusUser, kind: string, expected: mixed, config: mixed}>
     */
    private static function loadMatrix(string $matrix): array
    {
        $entry = self::matrixEntry($matrix);
        if ($entry === null) {
            throw new \RuntimeException("Unknown testmatrix file: {$matrix}");
        }
        $config = self::contentByKey()[$entry['sdkKey']] ?? null;
        if ($config === null) {
            throw new \RuntimeException("No config for matrix {$matrix} (sdkKey {$entry['sdkKey']})");
        }

        $text = WorkspaceRoot::upstreamText($matrix);
        $lines = array_values(array_filter(preg_split('/\r?\n/', $text) ?: [], static fn (string $l): bool => $l !== ''));
        $header = self::parseCsvLine($lines[0]);
        $customKey = $header[3] ?? 'Custom1';
        $settingKeys = \array_slice($header, 4);

        $tuples = [];
        $count = \count($lines);
        for ($r = 1; $r < $count; ++$r) {
            $cols = self::parseCsvLine($lines[$r]);
            $user = self::userFromRow($cols, $customKey);
            foreach ($settingKeys as $c => $key) {
                $raw = ($c + 4) < \count($cols) ? $cols[$c + 4] : '';
                $expected = $entry['kind'] === 'value' ? self::parseCell($raw) : $raw;
                $tuples[] = [
                    'matrix' => $matrix,
                    'key' => $key,
                    'user' => $user,
                    'kind' => $entry['kind'],
                    'expected' => $expected,
                    'config' => $config,
                ];
            }
        }

        return $tuples;
    }

    // -----------------------------------------------------------------------
    // evaluationlog/<scenario> (port loadEvalLogScenario).
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed>|null $raw
     */
    private static function evalLogUser(?array $raw): ?CorpusUser
    {
        if ($raw === null || $raw === []) {
            return null;
        }
        $identifier = '';
        $email = null;
        $country = null;
        $custom = [];
        foreach ($raw as $k => $v) {
            switch ($k) {
                // The three well-known attributes are typed string/?string on
                // CorpusUser (mirroring the public surface), so they coerce.
                case 'Identifier':
                    $identifier = (string) $v;
                    break;
                case 'Email':
                    $email = (string) $v;
                    break;
                case 'Country':
                    $country = (string) $v;
                    break;
                    // Custom attributes keep their native JSON-decoded type (port
                    // of the matrix loader's userFromRow intent): a numeric/bool
                    // custom attr reaches the comparator un-stringified so
                    // CorpusUser exercises the native-typed branch, not only the
                    // string->float coercion path.
                default:
                    $custom[$k] = $v;
            }
        }

        return new CorpusUser($identifier, $email, $country, $custom === [] ? null : $custom);
    }

    /**
     * @param array<string, mixed> $suite
     */
    private static function evalLogConfig(array $suite): mixed
    {
        $jsonOverride = $suite['jsonOverride'] ?? null;
        if (\is_string($jsonOverride)) {
            return WorkspaceRoot::upstreamJson('evaluationlog/_overrides/' . $jsonOverride);
        }
        $sdkKey = $suite['sdkKey'] ?? null;
        if (\is_string($sdkKey)) {
            $config = self::contentByKey()[$sdkKey] ?? self::evalLogConfigs()[$sdkKey] ?? null;
            if ($config === null) {
                throw new \RuntimeException("No config for eval-log sdkKey {$sdkKey}");
            }

            return $config;
        }
        throw new \RuntimeException('Eval-log suite has neither jsonOverride nor sdkKey');
    }

    /**
     * @return list<array{scenario: string, key: string, defaultValue: mixed, user: ?CorpusUser, expectedValue: mixed, config: mixed}>
     */
    private static function loadEvalLogScenario(string $scenario): array
    {
        $suite = WorkspaceRoot::upstreamJson("evaluationlog/{$scenario}.json");
        $config = self::evalLogConfig($suite);
        $tests = $suite['tests'] ?? [];
        $out = [];
        foreach (\is_array($tests) ? $tests : [] as $t) {
            if (!\is_array($t)) {
                continue;
            }
            $out[] = [
                'scenario' => $scenario,
                'key' => (string) ($t['key'] ?? ''),
                'defaultValue' => $t['defaultValue'] ?? null,
                'user' => self::evalLogUser(\is_array($t['user'] ?? null) ? $t['user'] : null),
                'expectedValue' => $t['returnValue'] ?? null,
                'config' => $config,
            ];
        }

        return $out;
    }

    // -----------------------------------------------------------------------
    // Assertion helpers.
    // -----------------------------------------------------------------------

    private static function settingType(mixed $config, string $key): ?int
    {
        $settings = \is_array($config) ? ($config['f'] ?? null) : null;
        $setting = \is_array($settings) ? ($settings[$key] ?? null) : null;
        $t = \is_array($setting) ? ($setting['t'] ?? null) : null;

        return \is_int($t) && !\is_bool($t) ? $t : null;
    }

    /**
     * Type-appropriate default matching the resolved primitive type. The
     * strict evaluator distinguishes int (t=2) from double (t=3), so the
     * default must be the SAME numeric kind the setting type expects.
     */
    private static function defaultFor(mixed $expected, ?int $settingType): mixed
    {
        if (\is_bool($expected)) {
            return false;
        }
        if (\is_int($expected) || \is_float($expected)) {
            return $settingType === Evaluator::SETTING_TYPE_DOUBLE ? 0.0 : 0;
        }

        return '__default__';
    }

    /**
     * Cast a JSON-decoded eval-log default to the type implied by `t`.
     */
    private static function coerceDefault(mixed $default, ?int $settingType): mixed
    {
        if (\is_bool($default)) {
            return $default;
        }
        if ($settingType === Evaluator::SETTING_TYPE_DOUBLE && \is_int($default)) {
            return (float) $default;
        }
        if ($settingType === Evaluator::SETTING_TYPE_INT && \is_float($default)) {
            return (int) $default;
        }

        return $default;
    }

    /**
     * Numeric-tolerant equality (5 == 5.0); booleans must not equate with ints.
     */
    private static function valueEqual(mixed $actual, mixed $expected): bool
    {
        if ((\is_int($expected) || \is_float($expected)) && !\is_bool($expected)) {
            if (\is_bool($actual)) {
                return false;
            }
            if (\is_float($expected) && is_nan($expected)) {
                return \is_float($actual) && is_nan($actual);
            }

            return (\is_int($actual) || \is_float($actual)) && $actual == $expected;
        }
        if (\is_bool($expected) !== \is_bool($actual)) {
            return false;
        }

        return $actual === $expected;
    }

    private static function userRepr(?CorpusUser $user): string
    {
        if ($user === null) {
            return 'null';
        }

        return sprintf(
            'id=%s email=%s country=%s custom=%s',
            var_export($user->identifier, true),
            var_export($user->email, true),
            var_export($user->country, true),
            var_export($user->custom, true),
        );
    }

    /**
     * @param array{matrix: string, key: string, user: ?CorpusUser, kind: string, expected: mixed, config: mixed} $tuple
     * @param list<string> $failures
     */
    private static function assertMatrixTuple(array $tuple, array &$failures): void
    {
        $label = "{$tuple['matrix']} {$tuple['key']} user=" . self::userRepr($tuple['user']);
        if ($tuple['kind'] === 'variation') {
            $result = Evaluator::evaluateWith($tuple['config'], $tuple['key'], null, $tuple['user']);
            if ($result->variationId !== $tuple['expected']) {
                $failures[] = "{$label}: actual=" . var_export($result->variationId, true)
                    . ' expected=' . var_export($tuple['expected'], true);
            }

            return;
        }
        $expected = $tuple['expected'];
        $default = self::defaultFor($expected, self::settingType($tuple['config'], $tuple['key']));
        $result = Evaluator::evaluateWith($tuple['config'], $tuple['key'], $default, $tuple['user']);
        if (!self::valueEqual($result->value, $expected)) {
            $failures[] = "{$label}: actual=" . var_export($result->value, true)
                . ' expected=' . var_export($expected, true);
        }
    }

    /**
     * @param array{scenario: string, key: string, defaultValue: mixed, user: ?CorpusUser, expectedValue: mixed, config: mixed} $tuple
     * @param list<string> $failures
     */
    private static function assertEvalLogValue(array $tuple, array &$failures): void
    {
        $expected = $tuple['expectedValue'];
        $settingType = self::settingType($tuple['config'], $tuple['key']);
        $default = $tuple['defaultValue'] === null
            ? self::defaultFor($expected, $settingType)
            : self::coerceDefault($tuple['defaultValue'], $settingType);
        $label = "{$tuple['scenario']} {$tuple['key']} user=" . self::userRepr($tuple['user']);
        $result = Evaluator::evaluateWith($tuple['config'], $tuple['key'], $default, $tuple['user']);
        if (!self::valueEqual($result->value, $expected)) {
            $failures[] = "{$label}: actual=" . var_export($result->value, true)
                . ' expected=' . var_export($expected, true);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private static function comparisonConfig(string $fixture): array
    {
        return WorkspaceRoot::upstreamJson("{$fixture}.json");
    }

    // =======================================================================
    // US1 / US2 — value + comparator matrices
    // =======================================================================

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function valueMatrices(): iterable
    {
        foreach ([
            'testmatrix.csv', 'testmatrix_comparators_v6.csv', 'testmatrix_semantic.csv',
            'testmatrix_semantic_2.csv', 'testmatrix_number.csv', 'testmatrix_sensitive.csv',
            'testmatrix_unicode.csv',
        ] as $matrix) {
            yield $matrix => [$matrix];
        }
    }

    #[DataProvider('valueMatrices')]
    public function testValueMatrices(string $matrix): void
    {
        $tuples = self::loadMatrix($matrix);
        self::assertNotEmpty($tuples, "{$matrix} produced no tuples");
        $failures = [];
        foreach ($tuples as $tuple) {
            self::assertMatrixTuple($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    // =======================================================================
    // US1 — targeting-rule eval-log scenarios
    // =======================================================================

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function targetingRuleScenarios(): iterable
    {
        foreach (['1_targeting_rule', '2_targeting_rules', 'simple_value'] as $scenario) {
            yield $scenario => [$scenario];
        }
    }

    #[DataProvider('targetingRuleScenarios')]
    public function testTargetingRuleScenarios(string $scenario): void
    {
        $failures = [];
        foreach (self::loadEvalLogScenario($scenario) as $tuple) {
            self::assertEvalLogValue($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    public function testMatchedTargetingRuleIsReported(): void
    {
        $cases = self::loadEvalLogScenario('1_targeting_rule');
        $matching = self::firstWhere($cases, static fn (array $c): bool => $c['expectedValue'] === 'Dog');
        $result = Evaluator::evaluateWith($matching['config'], $matching['key'], 'default', $matching['user']);
        self::assertSame('Dog', $result->value);
        self::assertNotNull($result->matchedTargetingRule);
        self::assertNull($result->matchedPercentageOption);
        self::assertSame('d0cd8f06', $result->variationId);
    }

    public function testNoUserServesFallbackWithReasonAndNeverThrows(): void
    {
        $cases = self::loadEvalLogScenario('1_targeting_rule');
        $noUser = self::firstWhere($cases, static fn (array $c): bool => $c['user'] === null);
        $result = Evaluator::evaluateWith($noUser['config'], $noUser['key'], 'default', null);
        self::assertSame('Cat', $result->value); // fallback
        self::assertNull($result->error); // a value was cleanly resolved
        self::assertNotNull($result->evalError);
        self::assertStringContainsString('User Object is missing', $result->evalError);
        self::assertNull($result->matchedTargetingRule);
    }

    // =======================================================================
    // US3 — percentage rollout
    // =======================================================================

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function percentageScenarios(): iterable
    {
        foreach ([
            'options_based_on_user_id', 'options_based_on_custom_attr',
            'options_after_targeting_rule', 'options_within_targeting_rule',
        ] as $scenario) {
            yield $scenario => [$scenario];
        }
    }

    #[DataProvider('percentageScenarios')]
    public function testPercentageScenarios(string $scenario): void
    {
        $failures = [];
        foreach (self::loadEvalLogScenario($scenario) as $tuple) {
            self::assertEvalLogValue($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    public function testPercentageBucketingIsDeterministic(): void
    {
        $cases = self::loadEvalLogScenario('options_based_on_user_id');
        $withUser = self::firstWhere($cases, static fn (array $c): bool => $c['user'] !== null);
        $config = $withUser['config'];
        $key = $withUser['key'];
        $user = $withUser['user'];
        $first = Evaluator::evaluateWith($config, $key, 'default', $user);
        for ($i = 0; $i < 20; ++$i) {
            $again = Evaluator::evaluateWith($config, $key, 'default', $user);
            self::assertSame($first->value, $again->value, 'percentage bucketing must be repeat-invariant');
            self::assertSame($first->variationId, $again->variationId);
        }
        self::assertTrue(self::valueEqual($first->value, $withUser['expectedValue']));
        self::assertNotNull($first->matchedPercentageOption);
    }

    // =======================================================================
    // US4 — segments / prerequisites / AND-OR matrices + scenarios
    // =======================================================================

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function us4Matrices(): iterable
    {
        foreach ([
            'testmatrix_and_or.csv', 'testmatrix_segments.csv',
            'testmatrix_segments_old.csv', 'testmatrix_prerequisite_flag.csv',
        ] as $matrix) {
            yield $matrix => [$matrix];
        }
    }

    #[DataProvider('us4Matrices')]
    public function testUs4Matrices(string $matrix): void
    {
        $tuples = self::loadMatrix($matrix);
        self::assertNotEmpty($tuples, "{$matrix} produced no tuples");
        $failures = [];
        foreach ($tuples as $tuple) {
            self::assertMatrixTuple($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function us4EvalLogScenarios(): iterable
    {
        foreach (['segment', 'prerequisite_flag', 'and_rules'] as $scenario) {
            yield $scenario => [$scenario];
        }
    }

    #[DataProvider('us4EvalLogScenarios')]
    public function testUs4EvalLogScenarios(string $scenario): void
    {
        $failures = [];
        foreach (self::loadEvalLogScenario($scenario) as $tuple) {
            if (\in_array($tuple['key'], self::UNVENDORED_EVAL_LOG_KEYS, true)) {
                continue;
            }
            self::assertEvalLogValue($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    public function testMultilevelPrerequisiteResolvesThroughReconstructedChain(): void
    {
        // Reconstructed from evaluationlog/prerequisite_flag (its config blob was
        // not vendored, #401). Proves the engine recurses A → B → C correctly.
        $config = [
            'p' => ['u' => '', 'r' => 0, 's' => 'salt'],
            's' => [],
            'f' => [
                'mainFeatureWithoutUserCondition' => ['t' => 0, 'v' => ['b' => true], 'i' => 'main', 'r' => []],
                'intermediateFeature' => [
                    't' => 0, 'v' => ['b' => false], 'i' => 'inter',
                    'r' => [[
                        'c' => [
                            ['p' => ['f' => 'mainFeatureWithoutUserCondition', 'c' => 0, 'v' => ['b' => true]]],
                            ['p' => ['f' => 'mainFeatureWithoutUserCondition', 'c' => 0, 'v' => ['b' => true]]],
                        ],
                        's' => ['v' => ['b' => true], 'i' => 'interT'],
                    ]],
                ],
                'dependentFeatureMultipleLevels' => [
                    't' => 1, 'v' => ['s' => 'Cat'], 'i' => 'dep',
                    'r' => [[
                        'c' => [['p' => ['f' => 'intermediateFeature', 'c' => 0, 'v' => ['b' => true]]]],
                        's' => ['v' => ['s' => 'Dog'], 'i' => 'depDog'],
                    ]],
                ],
            ],
        ];
        $result = Evaluator::evaluate($config, 'dependentFeatureMultipleLevels', 'default', null);
        self::assertSame('Dog', $result->value);
        self::assertNotNull($result->matchedTargetingRule);
    }

    // =======================================================================
    // US4 — circular-dependency termination (SC-004)
    // =======================================================================

    public function testCircularDepScenariosBoundedFallback(): void
    {
        $failures = [];
        foreach (self::loadEvalLogScenario('circular_dep') as $tuple) {
            $start = hrtime(true);
            $result = Evaluator::evaluateWith($tuple['config'], $tuple['key'], 'default', $tuple['user']);
            $elapsedSeconds = (hrtime(true) - $start) / 1_000_000_000;
            if ($elapsedSeconds >= 1.0) {
                $failures[] = "{$tuple['key']} took too long ({$elapsedSeconds}s) — cycle not bounded";
            }
            if ($result->value !== 'default') {
                $failures[] = "{$tuple['key']} value=" . var_export($result->value, true) . ' (expected fail-closed default)';
            }
            if ($result->error === null) {
                $failures[] = "{$tuple['key']} resolved with no error code";
            }
        }
        self::assertSame([], $failures, implode("\n", $failures));
    }

    public function testDirectTwoFlagCycleTerminates(): void
    {
        $config = [
            'p' => ['u' => '', 'r' => 0, 's' => 'salt'],
            's' => [],
            'f' => [
                'flagA' => [
                    't' => 1, 'v' => ['s' => 'A'], 'i' => 'a',
                    'r' => [['c' => [['p' => ['f' => 'flagB', 'c' => 0, 'v' => ['b' => true]]]], 's' => ['v' => ['s' => 'AA'], 'i' => 'aa']]],
                ],
                'flagB' => [
                    't' => 1, 'v' => ['s' => 'B'], 'i' => 'b',
                    'r' => [['c' => [['p' => ['f' => 'flagA', 'c' => 0, 'v' => ['b' => true]]]], 's' => ['v' => ['s' => 'BB'], 'i' => 'bb']]],
                ],
            ],
        ];
        $start = hrtime(true);
        $result = Evaluator::evaluate($config, 'flagA', 'default', null);
        $elapsedSeconds = (hrtime(true) - $start) / 1_000_000_000;
        self::assertLessThan(1.0, $elapsedSeconds, 'a direct two-flag cycle must terminate bounded');
        self::assertSame('default', $result->value);
        self::assertNotNull($result->error);
    }

    // =======================================================================
    // US5 — normalization / conversion / trimming (comparison_*.json drivers)
    // =======================================================================

    public function testComparisonAttributeConversion(): void
    {
        $config = self::comparisonConfig('comparison_attribute_conversion');
        $driver = [
            ['key' => 'numberToStringConversion', 'custom1' => 0.12345, 'expected' => '1'],
            ['key' => 'numberToStringConversionInt', 'custom1' => 125, 'expected' => '4'],
            ['key' => 'numberToStringConversionPositiveExp', 'custom1' => -1.23456789e96, 'expected' => '2'],
            ['key' => 'numberToStringConversionNegativeExp', 'custom1' => -1.23456789e-96, 'expected' => '4'],
            ['key' => 'numberToStringConversionNaN', 'custom1' => \NAN, 'expected' => '3'],
            ['key' => 'numberToStringConversionPositiveInf', 'custom1' => \INF, 'expected' => '4'],
            ['key' => 'numberToStringConversionNegativeInf', 'custom1' => -\INF, 'expected' => '3'],
            ['key' => 'dateToStringConversion', 'custom1' => 1680307199.999, 'expected' => '3'],
            ['key' => 'dateToStringConversionNaN', 'custom1' => \NAN, 'expected' => '3'],
            ['key' => 'dateToStringConversionPositiveInf', 'custom1' => \INF, 'expected' => '1'],
            ['key' => 'dateToStringConversionNegativeInf', 'custom1' => -\INF, 'expected' => '5'],
            ['key' => 'stringArrayToStringConversion', 'custom1' => ['read', 'Write', ' eXecute '], 'expected' => '4'],
            ['key' => 'stringArrayToStringConversionEmpty', 'custom1' => [], 'expected' => '5'],
            ['key' => 'stringArrayToStringConversionSpecialChars', 'custom1' => ["+<>%\"'\\/\t\r\n"], 'expected' => '3'],
            ['key' => 'stringArrayToStringConversionUnicode', 'custom1' => ['äöüÄÖÜçéèñışğâ¢™✓😀'], 'expected' => '2'],
        ];
        $failures = [];
        foreach ($driver as $c) {
            $user = new CorpusUser('12345', null, null, ['Custom1' => $c['custom1']]);
            $result = Evaluator::evaluateWith($config, $c['key'], 'default', $user);
            if ($result->value !== $c['expected']) {
                $failures[] = "{$c['key']}: actual=" . var_export($result->value, true) . ' expected=' . var_export($c['expected'], true);
            }
        }
        self::assertSame([], $failures, implode("\n", $failures));
    }

    /**
     * Native-typed custom attributes must reach the numeric comparator
     * un-stringified and evaluate identically to their string spelling. This
     * directly exercises CorpusUser's native-numeric branch
     * (`Comparators::attributeAsNumber`'s `isNumericNonBool → (float) $value`
     * path), not only the string→float coercion path that the matrix CSVs
     * and eval-log scenarios (all-string custom attrs) cover.
     */
    public function testNativeNumericCustomAttributeMatchesStringForm(): void
    {
        // Single flag: Custom1 >= 18 selects "match" via a targeting rule,
        // otherwise the off value "no-match".
        $config = [
            'p' => ['u' => '', 'r' => 0, 's' => 'salt'],
            's' => [],
            'f' => [
                'numericGate' => [
                    't' => 1,
                    'a' => 'Custom1',
                    'v' => ['s' => 'no-match'],
                    'i' => 'ng',
                    'r' => [[
                        // c=15 is NUMBER_GREATER_OR_EQUALS (Comparators::NUMBER_GREATER_OR_EQUALS).
                        'c' => [['u' => ['a' => 'Custom1', 'c' => 15, 'd' => 18.0]]],
                        's' => ['v' => ['s' => 'match'], 'i' => 'm'],
                    ]],
                ],
            ],
        ];

        $cases = [
            'native-int-pass' => [21, 'match'],
            'native-float-pass' => [18.0, 'match'],
            'native-int-fail' => [17, 'no-match'],
            'native-float-fail' => [17.999, 'no-match'],
            'string-int-pass' => ['21', 'match'],
            'string-float-pass' => ['18.0', 'match'],
            'string-int-fail' => ['17', 'no-match'],
        ];

        $failures = [];
        foreach ($cases as $label => [$attr, $expected]) {
            $user = new CorpusUser('12345', null, null, ['Custom1' => $attr]);
            $result = Evaluator::evaluateWith($config, 'numericGate', 'default', $user);
            if ($result->value !== $expected) {
                $failures[] = "{$label}: actual=" . var_export($result->value, true)
                    . ' expected=' . var_export($expected, true);
            }
        }
        self::assertSame([], $failures, implode("\n", $failures));
    }

    public function testComparisonAttributeTrimming(): void
    {
        $config = self::comparisonConfig('comparison_attribute_trimming');
        $user = new CorpusUser(
            ' 12345 ',
            null,
            '[" USA "]',
            ['Version' => ' 1.0.0 ', 'Number' => ' 3 ', 'Date' => ' 1705253400 '],
        );
        $failures = [];
        foreach (self::trimmingDriver() as $c) {
            $result = Evaluator::evaluateWith($config, $c['key'], 'default', $user);
            if ($result->value !== $c['expected']) {
                $failures[] = "{$c['key']}: actual=" . var_export($result->value, true) . ' expected=' . var_export($c['expected'], true);
            }
        }
        self::assertSame([], $failures, implode("\n", $failures));
    }

    public function testComparisonValueTrimming(): void
    {
        $config = self::comparisonConfig('comparison_value_trimming');
        $user = new CorpusUser(
            '12345',
            null,
            '["USA"]',
            ['Version' => '1.0.0', 'Number' => '3', 'Date' => '1705253400'],
        );
        $failures = [];
        foreach (self::valueTrimmingDriver() as $c) {
            $result = Evaluator::evaluateWith($config, $c['key'], 'default', $user);
            if ($result->value !== $c['expected']) {
                $failures[] = "{$c['key']}: actual=" . var_export($result->value, true) . ' expected=' . var_export($c['expected'], true);
            }
        }
        self::assertSame([], $failures, implode("\n", $failures));
    }

    // =======================================================================
    // US5 — typed-attribute validation outcomes (FR-010) + list truncation
    // =======================================================================

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function validationScenarios(): iterable
    {
        foreach (['semver_validation', 'number_validation', 'epoch_date_validation', 'list_truncation'] as $scenario) {
            yield $scenario => [$scenario];
        }
    }

    #[DataProvider('validationScenarios')]
    public function testValidationScenarios(string $scenario): void
    {
        $failures = [];
        foreach (self::loadEvalLogScenario($scenario) as $tuple) {
            self::assertEvalLogValue($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    // =======================================================================
    // US5 — variationId + matched rule/option detail (FR-011)
    // =======================================================================

    public function testVariationIdMatrix(): void
    {
        $tuples = self::loadMatrix('testmatrix_variationId.csv');
        self::assertNotEmpty($tuples);
        $failures = [];
        foreach ($tuples as $tuple) {
            self::assertMatrixTuple($tuple, $failures);
        }
        self::assertSame([], $failures, \count($failures) . " drift:\n" . implode("\n", $failures));
    }

    public function testSegmentMatchedFlagReportsValueAndVariationId(): void
    {
        $cases = self::loadEvalLogScenario('segment');
        $match = self::firstWhere(
            $cases,
            static fn (array $c): bool => $c['key'] === 'featureWithSegmentTargeting' && $c['user'] !== null,
        );
        $result = Evaluator::evaluateWith($match['config'], $match['key'], false, $match['user']);
        self::assertTrue($result->value);
        self::assertNotNull($result->matchedTargetingRule);
        self::assertNotNull($result->variationId);
    }

    // -----------------------------------------------------------------------
    // Trimming driver tables (ported verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    /**
     * @return list<array{key: string, expected: string}>
     */
    private static function trimmingDriver(): array
    {
        $noTrim = [
            'isoneof', 'isnotoneof', 'isoneofhashed', 'isnotoneofhashed', 'equalshashed',
            'notequalshashed', 'arraycontainsanyofhashed', 'arraynotcontainsanyofhashed', 'equals',
            'notequals', 'startwithanyof', 'notstartwithanyof', 'endswithanyof', 'notendswithanyof',
            'arraycontainsanyof', 'arraynotcontainsanyof', 'startwithanyofhashed', 'notstartwithanyofhashed',
            'endswithanyofhashed', 'notendswithanyofhashed',
        ];
        $out = [];
        foreach ($noTrim as $key) {
            $out[] = ['key' => $key, 'expected' => 'no trim'];
        }
        foreach ([
            'semverisoneof' => '4 trim', 'semverisnotoneof' => '5 trim', 'semverless' => '6 trim',
            'semverlessequals' => '7 trim', 'semvergreater' => '8 trim', 'semvergreaterequals' => '9 trim',
            'numberequals' => '10 trim', 'numbernotequals' => '11 trim', 'numberless' => '12 trim',
            'numberlessequals' => '13 trim', 'numbergreater' => '14 trim', 'numbergreaterequals' => '15 trim',
            'datebefore' => '18 trim', 'dateafter' => '19 trim',
        ] as $key => $expected) {
            $out[] = ['key' => $key, 'expected' => $expected];
        }
        $out[] = ['key' => 'containsanyof', 'expected' => 'no trim'];
        $out[] = ['key' => 'notcontainsanyof', 'expected' => 'no trim'];

        return $out;
    }

    /**
     * @return list<array{key: string, expected: string}>
     */
    private static function valueTrimmingDriver(): array
    {
        $noTrim = [
            'isoneof', 'isnotoneof', 'containsanyof', 'notcontainsanyof', 'isoneofhashed', 'isnotoneofhashed',
            'equalshashed', 'notequalshashed', 'arraycontainsanyofhashed', 'arraynotcontainsanyofhashed',
            'equals', 'notequals', 'startwithanyof', 'notstartwithanyof', 'endswithanyof', 'notendswithanyof',
            'arraycontainsanyof', 'arraynotcontainsanyof', 'startwithanyofhashed', 'notstartwithanyofhashed',
            'endswithanyofhashed', 'notendswithanyofhashed',
        ];
        $out = [];
        foreach ($noTrim as $key) {
            $out[] = ['key' => $key, 'expected' => 'no trim'];
        }
        foreach ([
            'semverisoneof' => '4 trim', 'semverisnotoneof' => '5 trim', 'semverless' => '6 trim',
            'semverlessequals' => '7 trim', 'semvergreater' => '8 trim', 'semvergreaterequals' => '9 trim',
        ] as $key => $expected) {
            $out[] = ['key' => $key, 'expected' => $expected];
        }

        return $out;
    }

    /**
     * @param list<array<string, mixed>> $cases
     * @param callable(array<string, mixed>): bool $predicate
     *
     * @return array<string, mixed>
     */
    private static function firstWhere(array $cases, callable $predicate): array
    {
        foreach ($cases as $c) {
            if ($predicate($c)) {
                return $c;
            }
        }
        throw new \RuntimeException('No matching case in corpus scenario');
    }
}
