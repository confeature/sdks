<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Confeature\User;

/**
 * ConfigCat-parity flag evaluator — full decision engine (spec 121).
 *
 * Ported from the spec-117 TS reference
 * (`packages/sdk-shared/src/evaluator.ts`) and the spec-118/119/120 Python /
 * Go / Ruby ports. The evaluator consumes a parsed `config_v6.json` array and
 * a (key, default, user) tuple and returns an `EvaluationResult` carrying the
 * resolved value, an optional reason-coded error, the variation id, and the
 * matched targeting rule / percentage option.
 *
 * Decision flow (mirrors `evaluator.ts::evaluateSetting`):
 *   1. walk `setting['r']` first-match-wins; each rule's `c` conditions are
 *      AND-grouped (short-circuit); a matched rule serves its fixed value `s`
 *      or buckets into its percentage options `p`;
 *   2. no rule matches → setting-level percentage options `p`;
 *   3. else → served fallback `setting['v']`.
 *
 * Conditions dispatch to the 36 comparators ({@link Comparators}), segment
 * membership ({@link Segments}), and prerequisite flags with bounded
 * circular-dependency detection ({@link Prerequisites}).
 *
 * Preserved invariants (SC-006 — NON-NEGOTIABLE, Principle II):
 *   - the existing typed-widening + TYPE_MISMATCH / VALUE_NOT_BOOL decision
 *     tree (strict int/double resolvers, the bool-is-int guard) runs UNCHANGED
 *     on the resolved value envelope, whatever its source (rule / % / static);
 *   - fail-closed: the function NEVER throws; any unexpected state (incl. a
 *     detected prerequisite cycle) resolves to the caller's default with a
 *     reason-coded error (`EVAL_EXCEPTION`), bounded (FR-007/SC-004);
 *   - the rule-less / no-user path is byte-identical to the pre-engine
 *     behaviour, preserving the tier-0 error-code set.
 *
 * No-user / missing-attribute on a rule is NOT an error to the caller — the
 * rule simply does not match and evaluation continues; an informational
 * reason is surfaced on `EvaluationResult::evalError` (FR-016), while `error`
 * stays null because a value WAS cleanly resolved.
 */
final class Evaluator
{
    /**
     * SettingType discriminators from `packages/sdk-shared/src/config-json.ts`.
     */
    public const SETTING_TYPE_BOOL = 0;
    public const SETTING_TYPE_STRING = 1;
    public const SETTING_TYPE_INT = 2;
    public const SETTING_TYPE_DOUBLE = 3;

    private const MISSING_USER_OBJECT_ERROR = 'cannot evaluate, User Object is missing';

    private const IDENTIFIER_ATTRIBUTE = 'Identifier';
    private const EMAIL_ATTRIBUTE = 'Email';
    private const COUNTRY_ATTRIBUTE = 'Country';

    /**
     * Prevent instantiation — pure static helper.
     */
    private function __construct()
    {
    }

    /**
     * Resolve `$key` against `$config`. Fail-closed to `$defaultValue`.
     *
     * The function NEVER throws. Any internal exception (incl. a detected
     * prerequisite cycle) is converted to a fail-closed result with
     * `error="EVAL_EXCEPTION"`.
     *
     * @param mixed $config The parsed `config_v6.json` as an array, or null.
     */
    public static function evaluate(
        mixed $config,
        string $key,
        mixed $defaultValue,
        ?User $user = null,
    ): EvaluationResult {
        return self::evaluateWith($config, $key, $defaultValue, $user);
    }

    /**
     * Targeting-aware evaluation core. Identical to {@link evaluate} but
     * accepts any user-like `object` exposing `identifier`/`email`/`country`/
     * `custom` (duck-typed, mirroring the TS/Python/Go/Ruby ports) so the
     * conformance corpus can feed TYPED custom attributes the public, custom-
     * stringifying `Confeature\User` cannot carry. Production code always
     * routes through {@link evaluate} with a real `User`.
     */
    public static function evaluateWith(
        mixed $config,
        string $key,
        mixed $defaultValue,
        ?object $user = null,
    ): EvaluationResult {
        return self::evaluateTraced($config, $key, $defaultValue, $user, null);
    }

    /**
     * {@link evaluateWith} with an optional trace sink. When the sink is
     * INFO-enabled it drives the ConfigCat byte-identical evaluation-log trace:
     * the WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and
     * the final INFO 5000 multi-line indented trace (ADR 0003 / epic #494). A
     * `null` sink (the hot path) is zero-cost — identical to {@link evaluate}.
     */
    public static function evaluateTraced(
        mixed $config,
        string $key,
        mixed $defaultValue,
        ?object $user = null,
        ?TraceSink $sink = null,
    ): EvaluationResult {
        if ($config === null) {
            return new EvaluationResult($defaultValue, 'NO_CONFIG');
        }

        $log = new TraceLog($sink);

        try {
            if (!\is_array($config)) {
                return new EvaluationResult($defaultValue, 'MALFORMED_CONFIG');
            }

            $settings = $config['f'] ?? null;
            if (!\is_array($settings)) {
                return new EvaluationResult($defaultValue, 'MALFORMED_CONFIG');
            }

            if (!\array_key_exists($key, $settings)) {
                return new EvaluationResult($defaultValue, 'KEY_NOT_FOUND');
            }

            $setting = $settings[$key];
            if (!\is_array($setting)) {
                return new EvaluationResult($defaultValue, 'MALFORMED_CONFIG');
            }

            $settingType = $setting['t'] ?? null;
            // `t` must be an int discriminator. Anything else is malformed.
            if (!\is_int($settingType)) {
                return new EvaluationResult($defaultValue, 'MALFORMED_CONFIG');
            }

            // Type guard BEFORE evaluating rules (mirrors evaluator.ts): the
            // default must be type-compatible with the setting's declared type.
            // A `null` default bypasses the check — used by the variation-id
            // matrix, which evaluates with a `null` default to read the
            // variation id regardless of value type.
            if ($defaultValue !== null) {
                $mismatch = self::checkDefaultType($settingType, $defaultValue);
                if ($mismatch !== null) {
                    return new EvaluationResult($defaultValue, $mismatch);
                }
            }

            // Evaluation-log trace (ADR 0003). Built lazily — only when the sink
            // would emit at INFO. The header is appended here; the
            // `Returning '<value>'.` footer below; the whole multi-line trace is
            // surfaced under event id 5000.
            $logBuilder = null;
            if ($log->enabled(TraceLevel::INFO)) {
                $logBuilder = new EvaluateLogBuilder();
                $logBuilder->append("Evaluating '{$key}'");
                if ($user !== null) {
                    $logBuilder->append(" for User '" . self::userAttributesForLogJson($user) . "'");
                }
            }

            // Evaluation core (the seam): resolve the setting to a `v`
            // envelope + matched-rule/option identity. For a rule-less config
            // this collapses to the served `setting['v']`, byte-identical to
            // the pre-engine behaviour.
            $ctx = new EvalContext(
                $key,
                $setting,
                $settings,
                self::configSegments($config),
                self::configSalt($config),
                $user,
                new EvalState(),
                $log,
                $logBuilder,
            );
            $result = self::evaluateSetting($ctx);

            $valueSlot = $result->value;
            if (!\is_array($valueSlot)) {
                return new EvaluationResult($defaultValue, 'MALFORMED_VALUE');
            }

            $variationId = $result->variationId;
            if ($variationId === null && \is_string($setting['i'] ?? null)) {
                $variationId = $setting['i'];
            }

            // The typed-widening decision tree runs UNCHANGED on the resolved
            // envelope (rule-served, percentage-served, or static).
            $typed = self::resolveTyped(
                $settingType,
                $valueSlot,
                $defaultValue,
                $variationId,
                $result,
                $ctx->state->evalError,
            );

            // Footer + emit. The INFO 5000 trace is emitted only when the
            // resolved value is clean (no error); a type/value error fails closed
            // without a footer (matching evaluator.ts, which emits after the
            // value guard).
            if ($logBuilder !== null && $typed->error === null) {
                $logBuilder->newLine("Returning '" . EvalLog::settingValueToLogString($typed->value) . "'.");
                $log->info(EvalLog::EVAL_LOG_EVENT_ID, (string) $logBuilder);
            }

            return $typed;
        } catch (CircularDependencyException $cycle) {
            // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR
            // 1002 (naming the setting + the chain), not the generic
            // evaluation-error path.
            $log->circularDependency($key, $cycle->cycle);

            return new EvaluationResult($defaultValue, 'EVAL_EXCEPTION');
        } catch (\Throwable) {
            // Bounded fail-closed (FR-007/SC-004): every internal failure — a
            // malformed prereq/segment reference, or any unexpected error —
            // resolves to the caller's default with an `EVAL_EXCEPTION` reason.
            return new EvaluationResult($defaultValue, 'EVAL_EXCEPTION');
        }
    }

    /**
     * Render the user's attributes as the eval-log header shows them — a
     * Confeature-canonical object `{Identifier, Email?, Country?, …custom}`
     * JSON-serialized to the `for User '…'` token (ADR 0003 addendum). This is
     * the configcat-js form (the vendored go-sdk oracle's map is transformed to
     * it in the corpus so the cross-SDK trace stays byte-identical).
     *
     * Insertion order is fixed (Identifier, Email, Country, then custom in the
     * order the user's custom map yields) and the serialization is compact (no
     * spaces) with JS-JSON string escaping — mirroring
     * `JSON.stringify(userAttributesForLog(user))`.
     */
    private static function userAttributesForLogJson(object $user): string
    {
        $parts = ['"Identifier":' . self::jsJsonString(self::userIdentifier($user))];
        $email = $user->email ?? null;
        if ($email !== null) {
            $parts[] = '"Email":' . self::jsJsonString(\is_string($email) ? $email : (string) $email); // @phpstan-ignore-line cast.string
        }
        $country = $user->country ?? null;
        if ($country !== null) {
            $parts[] = '"Country":' . self::jsJsonString(\is_string($country) ? $country : (string) $country); // @phpstan-ignore-line cast.string
        }
        $custom = $user->custom ?? null;
        if (\is_array($custom)) {
            foreach ($custom as $name => $value) {
                $parts[] = self::jsJsonString((string) $name)
                    . ':' . self::jsJsonString(Comparators::userAttributeValueToString($value));
            }
        }

        return '{' . implode(',', $parts) . '}';
    }

    /**
     * Serialize a string exactly as ECMAScript `JSON.stringify` of a string:
     * wrapped in double quotes, with `"`, `\`, and the C0 control characters
     * escaped (`\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, else `\u00XX`), all
     * other code points (incl. `/` and non-ASCII) verbatim.
     */
    private static function jsJsonString(string $str): string
    {
        $out = '"';
        // Iterate by Unicode code point so non-ASCII bytes pass through verbatim.
        $len = \strlen($str);
        for ($i = 0; $i < $len; ++$i) {
            $ch = $str[$i];
            $out .= match ($ch) {
                '"' => '\\"',
                '\\' => '\\\\',
                "\x08" => '\\b',
                "\t" => '\\t',
                "\n" => '\\n',
                "\x0C" => '\\f',
                "\r" => '\\r',
                default => \ord($ch) < 0x20 ? sprintf('\\u%04x', \ord($ch)) : $ch,
            };
        }

        return $out . '"';
    }

    /**
     * @param array<string, mixed> $config
     */
    private static function configSalt(array $config): string
    {
        $prefs = $config['p'] ?? null;
        $salt = \is_array($prefs) ? ($prefs['s'] ?? null) : null;

        return \is_string($salt) ? $salt : '';
    }

    /**
     * @param array<string, mixed> $config
     *
     * @return list<array<string, mixed>>
     */
    private static function configSegments(array $config): array
    {
        $raw = $config['s'] ?? null;

        return \is_array($raw) ? array_values($raw) : [];
    }

    /**
     * Return a TYPE_MISMATCH reason code if the default type is wrong, else
     * null. Preserves the existing strict typed-default guards (SC-006).
     */
    private static function checkDefaultType(int $settingType, mixed $defaultValue): ?string
    {
        return match ($settingType) {
            self::SETTING_TYPE_BOOL => \is_bool($defaultValue) ? null : 'TYPE_MISMATCH',
            self::SETTING_TYPE_STRING => \is_string($defaultValue) ? null : 'TYPE_MISMATCH',
            self::SETTING_TYPE_INT => (\is_int($defaultValue) && !\is_bool($defaultValue)) ? null : 'TYPE_MISMATCH',
            self::SETTING_TYPE_DOUBLE => \is_float($defaultValue) ? null : 'TYPE_MISMATCH',
            default => null,
        };
    }

    /**
     * Read the typed primitive from the resolved envelope (spec-072 widening).
     * Runs UNCHANGED on rule-served / percentage-served / static envelopes.
     *
     * @param array<string, mixed> $valueSlot
     */
    private static function resolveTyped(
        int $settingType,
        array $valueSlot,
        mixed $defaultValue,
        ?string $variationId,
        SettingResult $result,
        ?string $evalError,
    ): EvaluationResult {
        $ok = static fn (mixed $raw): EvaluationResult => new EvaluationResult(
            $raw,
            null,
            $variationId,
            $result->matchedRule,
            $result->matchedOption,
            $evalError,
        );

        switch ($settingType) {
            case self::SETTING_TYPE_BOOL:
                $raw = $valueSlot['b'] ?? null;
                if (!\is_bool($raw)) {
                    return new EvaluationResult($defaultValue, 'VALUE_NOT_BOOL');
                }

                return $ok($raw);
            case self::SETTING_TYPE_STRING:
                $raw = $valueSlot['s'] ?? null;
                if (!\is_string($raw)) {
                    return new EvaluationResult($defaultValue, 'MALFORMED_VALUE');
                }

                return $ok($raw);
            case self::SETTING_TYPE_INT:
                $raw = $valueSlot['i'] ?? null;
                if (!\is_int($raw) || \is_bool($raw)) {
                    return new EvaluationResult($defaultValue, 'MALFORMED_VALUE');
                }

                return $ok($raw);
            case self::SETTING_TYPE_DOUBLE:
                $raw = $valueSlot['d'] ?? null;
                if (\is_bool($raw)) {
                    return new EvaluationResult($defaultValue, 'MALFORMED_VALUE');
                }
                // JSON numbers without a fractional part decode as int; ConfigCat
                // double settings legitimately carry integral doubles (5.0 → 5).
                if (\is_int($raw)) {
                    $raw = (float) $raw;
                }
                if (!\is_float($raw)) {
                    return new EvaluationResult($defaultValue, 'MALFORMED_VALUE');
                }

                return $ok($raw);
            default:
                return new EvaluationResult($defaultValue, 'UNSUPPORTED_TYPE');
        }
    }

    // -----------------------------------------------------------------------
    // Evaluation core — rule walk / conditions / percentage
    // -----------------------------------------------------------------------

    private static function evaluateSetting(EvalContext $ctx): SettingResult
    {
        $setting = $ctx->setting;

        // 1. Targeting rules — first-match-wins (US1).
        $rules = $setting['r'] ?? [];
        if (\is_array($rules) && $rules !== []) {
            $ruleResult = self::evaluateTargetingRules($rules, $ctx);
            if ($ruleResult !== null) {
                return $ruleResult;
            }
        }

        // 2. Setting-level percentage options (US3).
        $options = $setting['p'] ?? [];
        if (\is_array($options) && $options !== []) {
            $optionResult = self::evaluatePercentageOptions($options, null, $ctx);
            if ($optionResult !== null) {
                return $optionResult;
            }
        }

        // 3. Served fallback `setting['v']`.
        return new SettingResult(
            $setting['v'] ?? null,
            \is_string($setting['i'] ?? null) ? $setting['i'] : null,
        );
    }

    /**
     * Walk rules in document order; return the first whose conditions all
     * match.
     *
     * @param array<int, mixed> $rules
     */
    private static function evaluateTargetingRules(array $rules, EvalContext $ctx): ?SettingResult
    {
        $lb = $ctx->logBuilder;
        $lb?->newLine('Evaluating targeting rules and applying the first match if any:');
        foreach ($rules as $rule) {
            if (!\is_array($rule)) {
                continue;
            }
            $conditions = $rule['c'] ?? [];
            $conditions = \is_array($conditions) ? $conditions : [];
            $outcome = self::evaluateConditions($conditions, $ctx->key, $ctx, $rule);
            if ($outcome !== true) {
                // A rule whose conditions ERRORED (missing user/attr) is ignored
                // and evaluation continues — ConfigCat emits this trace line. A
                // rule that merely did NOT match (false) just continues, with no
                // such line.
                if ($lb !== null && $outcome instanceof ValidationError) {
                    $lb->increaseIndent()
                        ->newLine('The current targeting rule is ignored and the evaluation continues with the next rule.')
                        ->decreaseIndent();
                }

                continue;
            }

            $served = $rule['s'] ?? null;
            if (\is_array($served)) {
                return new SettingResult(
                    $served['v'] ?? null,
                    \is_string($served['i'] ?? null) ? $served['i'] : null,
                    $rule,
                );
            }

            // A rule serving % options: the block is traced one level deeper
            // (under the rule). If the options can't resolve (no user / missing
            // keying attr) the rule is ignored and evaluation continues.
            $options = $rule['p'] ?? [];
            $lb?->increaseIndent();
            $optionResult = self::evaluatePercentageOptions(\is_array($options) ? $options : [], $rule, $ctx);
            if ($optionResult !== null) {
                $lb?->decreaseIndent();

                return $optionResult;
            }
            $lb?->newLine('The current targeting rule is ignored and the evaluation continues with the next rule.')
                ?->decreaseIndent();
        }

        return null;
    }

    /**
     * Resolve a percentage-option list to its bucket (US3, SHA-1 unsalted).
     * Returns null (skip) when there is no user or the keying attribute is
     * missing — never throws on a skippable condition. Mirrors common-js.
     *
     * @param array<int, mixed>          $options
     * @param ?array<string, mixed>      $matchedRule
     */
    private static function evaluatePercentageOptions(
        array $options,
        ?array $matchedRule,
        EvalContext $ctx,
    ): ?SettingResult {
        $lb = $ctx->logBuilder;
        if ($ctx->user === null) {
            self::surfaceMissingUser($ctx);
            $lb?->newLine('Skipping % options because the User Object is missing.');

            return null;
        }

        $attrName = $ctx->setting['a'] ?? null;
        if (!\is_string($attrName)) {
            $attrName = self::IDENTIFIER_ATTRIBUTE;
            $attrValue = self::userIdentifier($ctx->user);
        } else {
            $attrValue = self::getUserAttribute($ctx->user, $attrName);
        }
        if ($attrValue === null) {
            $ctx->state->evalError ??= self::missingUserAttributeError($attrName);
            $ctx->log->userObjectAttributeIsMissingForPercentage($ctx->key, $attrName);
            $lb?->newLine("Skipping % options because the User.{$attrName} attribute is missing.");

            return null;
        }

        $hashValue = Hashing::percentageBucket($ctx->key, Comparators::userAttributeValueToString($attrValue));

        if ($lb !== null) {
            $lb->newLine("Evaluating % options based on the User.{$attrName} attribute:");
            $lb->newLine(
                "- Computing hash in the [0..99] range from User.{$attrName} => {$hashValue} "
                . '(this value is sticky and consistent across all SDKs)',
            );
        }

        $settingType = $ctx->setting['t'] ?? null;
        $bucket = 0;
        $index = 0;
        foreach ($options as $option) {
            if (!\is_array($option)) {
                continue;
            }
            ++$index;
            $width = $option['p'] ?? 0;
            $bucket += \is_int($width) || \is_float($width) ? (int) $width : 0;
            if ($hashValue >= $bucket) {
                continue;
            }

            $value = $option['v'] ?? null;
            if ($lb !== null && \is_int($settingType)) {
                $selected = self::selectSettingValue($value, $settingType);
                $widthLog = \is_int($width) || \is_float($width) ? $width : 0;
                $lb->newLine(
                    "- Hash value {$hashValue} selects % option {$index} ({$widthLog}%), "
                    . "'" . EvalLog::settingValueToLogString($selected) . "'.",
                );
            }

            return new SettingResult(
                $value,
                \is_string($option['i'] ?? null) ? $option['i'] : null,
                $matchedRule,
                $option,
            );
        }

        // Sum of widths < 100 — a malformed config. Throw so the outer
        // fail-closed frame returns the default (common-js throws here too).
        throw new MalformedConfigException('Sum of percentage option percentages is less than 100.');
    }

    /**
     * Evaluate an AND-grouped condition list, short-circuiting on first
     * non-match / error. `true` = all matched; `false` = a condition did not
     * match; {@link ValidationError} = a condition errored (surfaced — FR-010).
     *
     * @param array<int, mixed> $conditions
     */
    private static function evaluateConditions(
        array $conditions,
        string $contextSalt,
        EvalContext $ctx,
        ?array $rule = null,
    ): bool|ValidationError {
        $lb = $ctx->logBuilder;
        $lb?->newLine('- ');
        $result = true;
        $i = 0;
        foreach ($conditions as $condition) {
            if ($lb !== null) {
                if ($i === 0) {
                    $lb->append('IF ')->increaseIndent();
                } else {
                    $lb->increaseIndent()->newLine('AND ');
                }
            }
            if (!\is_array($condition)) {
                $result = Comparators::error('empty condition');
            } elseif (\is_array($condition['u'] ?? null)) {
                $result = self::evaluateUserCondition($condition['u'], $contextSalt, $ctx);
            } elseif (\is_array($condition['p'] ?? null)) {
                $result = self::evaluatePrerequisiteCondition($condition['p'], $ctx);
            } elseif (\is_array($condition['s'] ?? null)) {
                $result = self::evaluateSegmentCondition($condition['s'], $ctx);
            } else {
                $result = Comparators::error('empty condition');
            }
            if ($lb !== null) {
                // The go-sdk oracle always shows the per-condition consequence
                // (even for a single-condition rule). A clean match is true;
                // anything else (no-match or surfaced error) renders the
                // `=> false, skipping…` form.
                $lb->appendConditionConsequence($result === true);
                $lb->decreaseIndent();
            }
            ++$i;
            if ($result !== true) {
                break;
            }
        }

        // Append the rule's THEN consequence (rule-owned condition list only).
        // The go oracle newlines THEN when the rule has conditions.
        if ($rule !== null && $lb !== null) {
            self::appendRuleConsequence($lb, $rule, $conditions, $result, $ctx);
        }

        return $result;
    }

    /**
     * Append the matched/no-match/error THEN consequence for a targeting rule.
     *
     * @param array<string, mixed> $rule
     * @param array<int, mixed>    $conditions
     */
    private static function appendRuleConsequence(
        EvaluateLogBuilder $lb,
        array $rule,
        array $conditions,
        bool|ValidationError $result,
        EvalContext $ctx,
    ): void {
        [$thenValue, $hasThen] = self::ruleThenValue($rule, $ctx);
        $outcome = $result === true
            ? MatchOrError::match()
            : ($result instanceof ValidationError ? MatchOrError::error($result->message) : MatchOrError::noMatch());
        $lb->appendTargetingRuleConsequence($hasThen ? $thenValue : null, $outcome, $conditions !== []);
    }

    /**
     * A rule's formatted served value (e.g. `Dog`) for a fixed-value rule;
     * `[null, false]` for a rule serving `% options`.
     *
     * @param array<string, mixed> $rule
     *
     * @return array{0: ?string, 1: bool}
     */
    private static function ruleThenValue(array $rule, EvalContext $ctx): array
    {
        $served = $rule['s'] ?? null;
        if (!\is_array($served)) {
            return [null, false];
        }
        $settingType = $ctx->setting['t'] ?? null;
        if (!\is_int($settingType)) {
            return [null, false];
        }
        $value = self::selectSettingValue($served['v'] ?? null, $settingType);

        return [EvalLog::settingValueToLogString($value), true];
    }

    /**
     * Dispatch one user condition to its comparator (US2).
     *
     * @param array<string, mixed> $condition
     */
    private static function evaluateUserCondition(
        array $condition,
        string $contextSalt,
        EvalContext $ctx,
    ): bool|ValidationError {
        $ctx->logBuilder?->appendUserCondition($condition);
        if ($ctx->user === null) {
            self::surfaceMissingUser($ctx);

            return Comparators::error(self::MISSING_USER_OBJECT_ERROR);
        }

        $rawAttrName = $condition['a'] ?? null;
        $attrName = \is_string($rawAttrName) ? $rawAttrName : null;
        $attrValue = $attrName === null ? null : self::getUserAttribute($ctx->user, $attrName);
        if ($attrName === null || $attrValue === null || $attrValue === '') {
            $msg = self::missingUserAttributeError((string) $rawAttrName);
            $ctx->state->evalError ??= $msg;
            // ConfigCat logs a WARN 3003 per targeting rule whose attribute is
            // missing (not deduped — AND short-circuit means one per rule).
            $ctx->log->userObjectAttributeIsMissing($ctx->key, (string) $rawAttrName);

            return Comparators::error($msg);
        }

        $cmp = $condition['c'] ?? null;
        if (!\is_int($cmp)) {
            return Comparators::error('unknown comparator');
        }
        $list = self::stringList($condition['l'] ?? null);
        $sv = \is_string($condition['s'] ?? null) ? $condition['s'] : '';
        $dvRaw = $condition['d'] ?? null;
        $dv = \is_int($dvRaw) || \is_float($dvRaw) ? (float) $dvRaw : 0.0;
        $rawDv = \is_int($dvRaw) || \is_float($dvRaw) ? (float) $dvRaw : null;

        $result = self::dispatchComparator($cmp, $attrName, $attrValue, $list, $sv, $dv, $rawDv, $ctx->configSalt, $contextSalt);
        if ($result instanceof ValidationError) {
            self::surfaceUserConditionError($result, $ctx);
        }

        return $result;
    }

    /**
     * Surface + log the typed validation / malformed-operand outcomes the trace
     * replays. An attribute-invalid error → WARN 3004
     * (`userObjectAttributeIsInvalid`); a malformed config operand (#509) → WARN
     * 3004 (`comparisonValueIsInvalid`). Both also feed `state.evalError`
     * (FR-016) the way the missing paths do.
     */
    private static function surfaceUserConditionError(ValidationError $result, EvalContext $ctx): void
    {
        $ctx->state->evalError ??= $result->message;
        if (preg_match('/^cannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)$/', $result->message, $m) === 1) {
            $ctx->log->userObjectAttributeIsInvalid($ctx->key, $m[1], $m[2]);
        } elseif (str_starts_with($result->message, "comparison value '")) {
            $ctx->log->comparisonValueIsInvalid($ctx->key, $result->message);
        }
    }

    /**
     * @param list<string> $list
     */
    private static function dispatchComparator(
        int $cmp,
        string $attrName,
        mixed $attrValue,
        array $list,
        string $sv,
        float $dv,
        ?float $rawDv,
        string $salt,
        string $contextSalt,
    ): bool|ValidationError {
        $c = Comparators::class;
        $text = static fn (): string => Comparators::attributeAsText($attrValue);

        switch ($cmp) {
            case $c::TEXT_EQUALS:
            case $c::TEXT_NOT_EQUALS:
                return Comparators::evaluateTextEquals($text(), $sv, $cmp === $c::TEXT_NOT_EQUALS);
            case $c::SENSITIVE_TEXT_EQUALS:
            case $c::SENSITIVE_TEXT_NOT_EQUALS:
                return Comparators::evaluateSensitiveTextEquals(
                    $text(),
                    $sv,
                    $salt,
                    $contextSalt,
                    $cmp === $c::SENSITIVE_TEXT_NOT_EQUALS,
                );
            case $c::TEXT_IS_ONE_OF:
            case $c::TEXT_IS_NOT_ONE_OF:
                return Comparators::evaluateTextIsOneOf($text(), $list, $cmp === $c::TEXT_IS_NOT_ONE_OF);
            case $c::SENSITIVE_TEXT_IS_ONE_OF:
            case $c::SENSITIVE_TEXT_IS_NOT_ONE_OF:
                return Comparators::evaluateSensitiveTextIsOneOf(
                    $text(),
                    $list,
                    $salt,
                    $contextSalt,
                    $cmp === $c::SENSITIVE_TEXT_IS_NOT_ONE_OF,
                );
            case $c::TEXT_STARTS_WITH_ANY_OF:
            case $c::TEXT_NOT_STARTS_WITH_ANY_OF:
                return Comparators::evaluateTextSliceEqualsAnyOf(
                    $text(),
                    $list,
                    true,
                    $cmp === $c::TEXT_NOT_STARTS_WITH_ANY_OF,
                );
            case $c::SENSITIVE_TEXT_STARTS_WITH_ANY_OF:
            case $c::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF:
                return Comparators::evaluateSensitiveTextSliceEqualsAnyOf(
                    $text(),
                    $list,
                    $salt,
                    $contextSalt,
                    true,
                    $cmp === $c::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
                );
            case $c::TEXT_ENDS_WITH_ANY_OF:
            case $c::TEXT_NOT_ENDS_WITH_ANY_OF:
                return Comparators::evaluateTextSliceEqualsAnyOf(
                    $text(),
                    $list,
                    false,
                    $cmp === $c::TEXT_NOT_ENDS_WITH_ANY_OF,
                );
            case $c::SENSITIVE_TEXT_ENDS_WITH_ANY_OF:
            case $c::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF:
                return Comparators::evaluateSensitiveTextSliceEqualsAnyOf(
                    $text(),
                    $list,
                    $salt,
                    $contextSalt,
                    false,
                    $cmp === $c::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
                );
            case $c::TEXT_CONTAINS_ANY_OF:
            case $c::TEXT_NOT_CONTAINS_ANY_OF:
                return Comparators::evaluateTextContainsAnyOf($text(), $list, $cmp === $c::TEXT_NOT_CONTAINS_ANY_OF);
            case $c::SEMVER_IS_ONE_OF:
            case $c::SEMVER_IS_NOT_ONE_OF:
                $r = Comparators::attributeAsSemver($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateSemverIsOneOf($r, $list, $cmp === $c::SEMVER_IS_NOT_ONE_OF);
            case $c::SEMVER_LESS:
            case $c::SEMVER_LESS_OR_EQUALS:
            case $c::SEMVER_GREATER:
            case $c::SEMVER_GREATER_OR_EQUALS:
                // configcat-common validates the CONFIG comparison value BEFORE
                // the user attribute (#509): a malformed operand wins even when
                // the attribute is also malformed.
                $cv = Comparators::comparisonValueAsSemver($sv);
                if ($cv instanceof ComparisonValueError) {
                    return Comparators::error($cv->message);
                }
                $r = Comparators::attributeAsSemver($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateSemverRelation($r, $cmp, $sv);
            case $c::NUMBER_EQUALS:
            case $c::NUMBER_NOT_EQUALS:
            case $c::NUMBER_LESS:
            case $c::NUMBER_LESS_OR_EQUALS:
            case $c::NUMBER_GREATER:
            case $c::NUMBER_GREATER_OR_EQUALS:
                $cvn = Comparators::comparisonValueAsNumber($rawDv);
                if ($cvn instanceof ComparisonValueError) {
                    return Comparators::error($cvn->message);
                }
                $r = Comparators::attributeAsNumber($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateNumberRelation($r, $cmp, $dv);
            case $c::DATETIME_BEFORE:
            case $c::DATETIME_AFTER:
                $cvd = Comparators::comparisonValueAsUnixTimeSeconds($rawDv);
                if ($cvd instanceof ComparisonValueError) {
                    return Comparators::error($cvd->message);
                }
                $r = Comparators::attributeAsUnixTimeSeconds($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateDatetimeRelation($r, $dv, $cmp === $c::DATETIME_BEFORE);
            case $c::ARRAY_CONTAINS_ANY_OF:
            case $c::ARRAY_NOT_CONTAINS_ANY_OF:
                $r = Comparators::attributeAsStringArray($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateArrayContainsAnyOf($r, $list, $cmp === $c::ARRAY_NOT_CONTAINS_ANY_OF);
            case $c::SENSITIVE_ARRAY_CONTAINS_ANY_OF:
            case $c::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF:
                $r = Comparators::attributeAsStringArray($attrName, $attrValue);

                return $r instanceof ValidationError
                    ? $r
                    : Comparators::evaluateSensitiveArrayContainsAnyOf(
                        $r,
                        $list,
                        $salt,
                        $contextSalt,
                        $cmp === $c::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
                    );
            default:
                return Comparators::error("unknown comparator {$cmp}");
        }
    }

    /**
     * Resolve a prerequisite-flag condition (US4) — child context, shared
     * stack.
     *
     * @param array<string, mixed> $condition
     */
    private static function evaluatePrerequisiteCondition(array $condition, EvalContext $ctx): bool|ValidationError
    {
        $lb = $ctx->logBuilder;
        $prereqType = static function (string $prereqKey) use ($ctx): ?int {
            $s = $ctx->settings[$prereqKey] ?? null;
            $t = \is_array($s) ? ($s['t'] ?? null) : null;

            return \is_int($t) ? $t : null;
        };

        // Trace the `Flag 'X' EQUALS 'Y'` condition before recursing (the
        // comparison value is read through the prereq flag's own declared type).
        if ($lb !== null) {
            $prereqKey = $condition['f'] ?? null;
            $cmpText = '';
            if (\is_string($prereqKey)) {
                $pt = $prereqType($prereqKey);
                if ($pt !== null) {
                    $cmpVal = self::selectSettingValue($condition['v'] ?? null, $pt);
                    if ($cmpVal !== null) {
                        $cmpText = EvalLog::settingValueToLogString($cmpVal);
                    }
                }
            }
            $cmp = $condition['c'] ?? null;
            $lb->appendPrerequisiteFlagCondition(
                \is_string($prereqKey) ? $prereqKey : '',
                \is_int($cmp) ? $cmp : -1,
                $cmpText,
            );
        }

        $evaluatePrereqFlag = static function (string $prereqKey) use ($ctx, $lb, $prereqType): mixed {
            $prereqSetting = $ctx->settings[$prereqKey] ?? null;
            if (!\is_array($prereqSetting)) {
                throw new MalformedConfigException('Prerequisite flag is missing or invalid.');
            }
            // A prerequisite flag evaluates in its OWN context (configcat
            // forPrerequisiteFlag): the no-user WARN dedups per flag, so a prereq
            // referenced by N rules logs it N times — hence a fresh state that
            // carries forward the already-surfaced evalError (FR-016). The child
            // shares the SAME mutable visited-flags stack so a cross-level cycle
            // is detected.
            $childState = new EvalState($ctx->state->evalError, false);
            $child = new EvalContext(
                $prereqKey,
                $prereqSetting,
                $ctx->settings,
                $ctx->segments,
                $ctx->configSalt,
                $ctx->user,
                $childState,
                $ctx->log,
                $lb,
                $ctx->visitedFlags,
            );

            if ($lb !== null) {
                $lb->newLine('(')->increaseIndent()->newLine("Evaluating '{$prereqKey}'");
                if ($ctx->user !== null) {
                    $lb->append(" for User '" . self::userAttributesForLogJson($ctx->user) . "'");
                }
            }
            $resolved = self::evaluateSetting($child);
            $ctx->state->evalError ??= $childState->evalError;
            if ($lb !== null) {
                $declaredType = $prereqType($prereqKey);
                $childValue = $declaredType === null ? null : self::selectSettingValue($resolved->value, $declaredType);
                $lb->newLine("Returning '" . EvalLog::settingValueToLogString($childValue) . "'.")
                    ->decreaseIndent()
                    ->newLine(')');
            }

            return $resolved->value;
        };

        return Prerequisites::evaluatePrerequisiteFlagCondition(
            $condition,
            $ctx->key,
            $ctx->visitedFlags,
            $prereqType,
            $evaluatePrereqFlag,
            self::selectSettingValue(...),
        );
    }

    /**
     * Resolve a segment condition (US4) — segment name as the context salt.
     *
     * @param array<string, mixed> $condition
     */
    private static function evaluateSegmentCondition(array $condition, EvalContext $ctx): bool|ValidationError
    {
        if ($ctx->logBuilder === null) {
            // Hot path — behaviour identical to before the trace seam existed.
            $surface = static function () use ($ctx): string {
                self::surfaceMissingUser($ctx);

                return self::MISSING_USER_OBJECT_ERROR;
            };

            return Segments::evaluateSegmentCondition(
                $condition,
                $ctx->segments,
                $ctx->user !== null,
                $surface,
                static fn (array $uc, string $salt): bool|ValidationError => self::evaluateUserCondition($uc, $salt, $ctx),
            );
        }

        return self::evaluateSegmentConditionTraced($condition, $ctx);
    }

    /**
     * Traced segment path (mirrors evaluator.ts / Go's evaluateSegmentCond).
     * Resolve the segment name first so the `User IS [NOT] IN SEGMENT 'X'` line
     * is appended before the no-user / reference guards, exactly like the oracle.
     *
     * @param array<string, mixed> $condition
     */
    private static function evaluateSegmentConditionTraced(array $condition, EvalContext $ctx): bool|ValidationError
    {
        $lb = $ctx->logBuilder;
        \assert($lb !== null);

        $index = $condition['s'] ?? null;
        $segment = null;
        if (\is_int($index) && $index >= 0 && $index < \count($ctx->segments)) {
            $candidate = $ctx->segments[$index];
            if (\is_array($candidate)) {
                $segment = $candidate;
            }
        }
        $segmentName = ($segment !== null && \is_string($segment['n'] ?? null)) ? $segment['n'] : '';
        $cmp = $condition['c'] ?? null;
        $cmpInt = \is_int($cmp) ? $cmp : Segments::SEGMENT_IS_IN;
        $lb->appendSegmentCondition($segmentName, $cmpInt);

        if ($ctx->user === null) {
            self::surfaceMissingUser($ctx);

            return Comparators::error(self::MISSING_USER_OBJECT_ERROR);
        }
        if ($segment === null || $segmentName === '') {
            throw new MalformedConfigException('Segment reference is invalid.');
        }

        $lb->newLine('(')->increaseIndent()->newLine("Evaluating segment '{$segmentName}':");
        $rawRules = $segment['r'] ?? [];
        $wrapped = [];
        foreach (\is_array($rawRules) ? $rawRules : [] as $uc) {
            $wrapped[] = ['u' => $uc];
        }
        $inSegment = self::evaluateConditions($wrapped, $segmentName, $ctx);

        $errored = $inSegment instanceof ValidationError;
        // IsNotIn negates a clean boolean outcome; an errored segment is
        // surfaced un-negated — IsNotIn never flips an error into a match.
        $result = $inSegment;
        if (!$errored && $cmpInt === Segments::SEGMENT_IS_NOT_IN) {
            $result = !$inSegment;
        }

        $lb->newLine('Segment evaluation result: ');
        if ($errored) {
            $lb->append($ctx->state->evalError ?? '');
        } else {
            $lb->append($inSegment === true ? 'User IS IN SEGMENT' : 'User IS NOT IN SEGMENT');
        }
        $lb->append('.');
        $lb->newLine('Condition (')->appendSegmentCondition($segmentName, $cmpInt)->append(')');
        if ($errored) {
            $lb->append(' failed to evaluate');
        } else {
            $lb->append(' evaluates to ')->appendConditionResult($result === true);
        }
        $lb->append('.')->decreaseIndent()->newLine(')');

        if ($errored) {
            return Comparators::error($ctx->state->evalError ?? self::MISSING_USER_OBJECT_ERROR);
        }

        return $result;
    }

    /**
     * Read the typed value out of a `v` envelope by the setting's `t`.
     * Mirrors `evaluator.ts::selectSettingValue`. The key is chosen from `t`,
     * never from the runtime shape of the parsed value.
     */
    private static function selectSettingValue(mixed $value, int $settingType): mixed
    {
        if (!\is_array($value)) {
            return null;
        }

        return match ($settingType) {
            self::SETTING_TYPE_BOOL => $value['b'] ?? null,
            self::SETTING_TYPE_STRING => $value['s'] ?? null,
            self::SETTING_TYPE_INT => $value['i'] ?? null,
            // JSON numbers without a fractional part decode as int; widen an
            // integral double to float so the prerequisite `===` matches the
            // float comparison value (mirrors resolveTyped's double case and
            // the TS reference). bool/string/int slots are unaffected.
            self::SETTING_TYPE_DOUBLE => (static function () use ($value): mixed {
                $v = $value['d'] ?? null;

                return \is_int($v) ? (float) $v : $v;
            })(),
            default => null,
        };
    }

    /**
     * Surface the "User Object is missing" reason once per context (FR-016).
     * Also logs the WARN 3001 once per context (common-js parity).
     */
    private static function surfaceMissingUser(EvalContext $ctx): void
    {
        $ctx->state->evalError ??= self::MISSING_USER_OBJECT_ERROR;
        if ($ctx->state->missingUserObjectLogged) {
            return;
        }
        $ctx->log->userObjectIsMissing($ctx->key);
        $ctx->state->missingUserObjectLogged = true;
    }

    private static function missingUserAttributeError(string $attr): string
    {
        return "cannot evaluate, the User.{$attr} attribute is missing";
    }

    /**
     * Read a well-known or custom attribute off a user-like object. Mirrors
     * `user.ts::getUserAttribute`: `Identifier` → identifier ?? "", `Email` →
     * email, `Country` → country, else → custom[name]. Returns null for an
     * absent attribute (the evaluator treats null and "" as "missing"). Reads
     * are duck-typed (`identifier`/`email`/`country`/`custom` properties) so
     * the corpus harness can feed typed custom values without redesigning the
     * public `Confeature\User`.
     */
    private static function getUserAttribute(object $user, string $name): mixed
    {
        switch ($name) {
            case self::IDENTIFIER_ATTRIBUTE:
                return self::userIdentifier($user);
            case self::EMAIL_ATTRIBUTE:
                return $user->email ?? null;
            case self::COUNTRY_ATTRIBUTE:
                return $user->country ?? null;
            default:
                $custom = $user->custom ?? null;

                return \is_array($custom) ? ($custom[$name] ?? null) : null;
        }
    }

    private static function userIdentifier(object $user): string
    {
        $id = $user->identifier ?? null;

        return \is_string($id) ? $id : '';
    }

    /**
     * Coerce a condition's `l` operand list to a list of strings.
     *
     * @return list<string>
     */
    private static function stringList(mixed $raw): array
    {
        if (!\is_array($raw)) {
            return [];
        }
        $out = [];
        foreach ($raw as $item) {
            if (\is_string($item)) {
                $out[] = $item;
            }
        }

        return $out;
    }
}
