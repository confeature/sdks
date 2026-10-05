// SPDX-License-Identifier: MIT

/// ConfigCat-parity flag evaluator — full decision engine (spec 123).
///
/// Ported from the spec-117 TS reference
/// (`packages/sdk-shared/src/evaluator.ts`) and the spec-118/119/120/121/122
/// Python / Go / Ruby / PHP / .NET ports. The evaluator consumes a parsed
/// `config_v6.json` map and a (key, default, user) tuple and returns an
/// [EvaluationResult] carrying the resolved value, an optional reason-coded
/// error, the variation id, and the matched targeting rule / percentage
/// option.
///
/// Decision flow (mirrors `evaluator.ts::evaluateSetting`):
///   1. walk `setting['r']` first-match-wins; each rule's `c` conditions are
///      AND-grouped (short-circuit); a matched rule serves its fixed value `s`
///      or buckets into its percentage options `p`;
///   2. no rule matches → setting-level percentage options `p`;
///   3. else → served fallback `setting['v']`.
///
/// Conditions dispatch to the 36 comparators (comparators.dart), segment
/// membership (segments.dart), and prerequisite flags with bounded
/// circular-dependency detection (prerequisites.dart).
///
/// Preserved invariants (SC-006 — NON-NEGOTIABLE, Principle II):
///   - the existing typed-widening + TYPE_MISMATCH / VALUE_NOT_BOOL decision
///     tree (strict int/double resolvers, disjoint int/double guards) runs
///     UNCHANGED on the resolved value envelope, whatever its source;
///   - fail-closed: the function NEVER throws; any unexpected state (incl. a
///     detected prerequisite cycle) resolves to the caller's default with an
///     `EVAL_EXCEPTION` reason, bounded (FR-007/SC-004);
///   - the rule-less / no-user path is byte-identical to the pre-engine
///     behaviour, preserving the tier-0 error-code set.
///
/// No-user / missing-attribute on a rule is NOT an error to the caller — the
/// rule simply does not match and evaluation continues; an informational
/// reason is surfaced on [EvaluationResult.evalError] (FR-016), while [error]
/// stays null because a value WAS cleanly resolved.
library;

import 'package:meta/meta.dart';

import '../user.dart';
import 'comparators.dart';
import 'errors.dart';
import 'eval_log.dart';
import 'hashing.dart';
import 'prerequisites.dart';
import 'segments.dart';
import 'semver.dart';
import 'trace_log.dart';

/// `SettingType.Bool` from `packages/sdk-shared/src/config-json.ts`.
const int _settingTypeBool = 0;

/// `SettingType.String`.
const int _settingTypeString = 1;

/// `SettingType.Int`.
const int _settingTypeInt = 2;

/// `SettingType.Double`.
const int _settingTypeDouble = 3;

const String _missingUserObjectError =
    'cannot evaluate, User Object is missing';
const String _identifierAttribute = 'Identifier';
const String _emailAttribute = 'Email';
const String _countryAttribute = 'Country';

String _missingUserAttributeError(String attr) =>
    'cannot evaluate, the User.$attr attribute is missing';

/// Duck-typed targeting context the evaluator reads. The public [User]
/// stringifies custom values by contract; the conformance corpus needs to feed
/// numbers / arrays / epochs un-stringified, so it supplies its own [EvalUser]
/// (mirrors the PHP `CorpusUser` / Ruby / Python conformance harness users).
/// Production code routes through [evaluate] with a real [User], wrapped by
/// [_PublicUser].
abstract class EvalUser {
  /// Stable user identifier (empty string when unset).
  String get identifier;

  /// Optional contact email.
  String? get email;

  /// Optional country tag.
  String? get country;

  /// Read a custom attribute by [name]; `null` when absent. The value retains
  /// its native type (string / num / bool / list).
  Object? customAttribute(String name);

  /// All custom attributes in insertion order; `null` (or empty) when none.
  /// Used only by the eval-log header (ADR 0003) to render the `for User '…'`
  /// token in the order the user supplied.
  Map<String, Object?>? get customAttributes;
}

/// Adapts the public [User] (custom attrs are `Map<String, String>`) to the
/// duck-typed [EvalUser] the engine reads.
class _PublicUser implements EvalUser {
  const _PublicUser(this._user);

  final User _user;

  @override
  String get identifier => _user.identifier;

  @override
  String? get email => _user.email;

  @override
  String? get country => _user.country;

  @override
  Object? customAttribute(String name) => _user.custom?[name];

  @override
  Map<String, Object?>? get customAttributes => _user.custom;
}

/// Result of [evaluate]. `error` is `null` on the happy path.
@immutable
class EvaluationResult<T> {
  /// Construct an evaluation result.
  const EvaluationResult({
    required this.value,
    this.error,
    this.variationId,
    this.matchedTargetingRule,
    this.matchedPercentageOption,
    this.evalError,
  });

  /// The resolved value (or the supplied default on any error branch).
  final T value;

  /// Short error code — `null` on the happy path.
  final String? error;

  /// Optional variation identifier (rule / option / setting `i`).
  final String? variationId;

  /// The matched targeting rule's raw map, when a rule decided the value.
  final Map<dynamic, dynamic>? matchedTargetingRule;

  /// The matched percentage option's raw map, when a `%` option decided it.
  final Map<dynamic, dynamic>? matchedPercentageOption;

  /// Informational reason surfaced during evaluation (no-user /
  /// missing-attribute / validation) when a value WAS still cleanly resolved
  /// (FR-016). Distinct from [error], which marks a fail-closed default.
  final String? evalError;
}

/// Internal raw resolution of a setting — the resolved `v` envelope plus the
/// matched-rule / matched-option identity.
class _SettingResult {
  const _SettingResult(
    this.value,
    this.variationId, [
    this.matchedRule,
    this.matchedOption,
  ]);

  final Object? value;
  final String? variationId;
  final Map<dynamic, dynamic>? matchedRule;
  final Map<dynamic, dynamic>? matchedOption;
}

/// Mutable evaluation-scoped state shared across prerequisite recursion.
class _EvalState {
  _EvalState([this.evalError]);

  String? evalError;

  /// Dedups the no-user WARN 3001 to once per context (common-js parity): a
  /// prerequisite flag evaluates in its OWN context, so a prereq referenced by
  /// N rules logs the WARN N times, but a single rule with multiple no-user
  /// conditions logs it once (ADR 0003).
  bool missingUserObjectLogged = false;
}

/// Per-evaluation context threaded through rule / condition / prerequisite
/// resolution. [state] + [visitedFlags] are SHARED mutable holders threaded
/// unchanged into child contexts during prerequisite recursion.
class _EvalContext {
  _EvalContext({
    required this.key,
    required this.setting,
    required this.settings,
    required this.segments,
    required this.configSalt,
    required this.user,
    required this.state,
    required this.visitedFlags,
    required this.log,
    this.logBuilder,
  });

  final String key;
  final Map<dynamic, dynamic> setting;
  final Map<dynamic, dynamic> settings;
  final List<dynamic> segments;
  final String configSalt;
  final EvalUser? user;
  final _EvalState state;
  final VisitedFlags visitedFlags;

  /// The eval-log trace logger (ADR 0003). Always present; gated internally so
  /// the no-trace hot path is zero-cost.
  final TraceLog log;

  /// The eval-log trace builder, present only when an INFO-enabled trace sink
  /// is attached. Shared across the recursion (a prerequisite re-evaluates
  /// nested in `( … )` on the SAME builder).
  final EvaluateLogBuilder? logBuilder;
}

/// Resolve [key] against [config]. Fail-closed to [defaultValue].
///
/// [user] is the public targeting context. The function NEVER throws; any
/// internal exception (incl. a detected prerequisite cycle) is converted to a
/// fail-closed result with `error='EVAL_EXCEPTION'`.
EvaluationResult<T> evaluate<T>(
  Map<String, dynamic>? config,
  String key,
  T defaultValue, [
  User? user,
]) {
  return evaluateWith<T>(
    config,
    key,
    defaultValue,
    user == null ? null : _PublicUser(user),
  );
}

/// Targeting-aware evaluation core. Identical to [evaluate] but accepts a
/// duck-typed [EvalUser] so the conformance corpus can feed TYPED custom
/// attributes the public, custom-stringifying [User] cannot carry.
EvaluationResult<T> evaluateWith<T>(
  Map<String, dynamic>? config,
  String key,
  T defaultValue, [
  EvalUser? user,
]) =>
    evaluateTraced<T>(config, key, defaultValue, user, null);

/// [evaluateWith] with an optional trace sink. When the sink is INFO-enabled it
/// drives the ConfigCat byte-identical evaluation-log trace: the WARN
/// 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and the final
/// INFO 5000 multi-line indented trace (ADR 0003 / epic #494). A `null` sink
/// (the hot path) is zero-cost — identical to [evaluate].
EvaluationResult<T> evaluateTraced<T>(
  Map<String, dynamic>? config,
  String key,
  T defaultValue, [
  EvalUser? user,
  TraceSink? sink,
]) {
  // No config yet → silent miss (caller's default wins).
  if (config == null) {
    return EvaluationResult<T>(value: defaultValue, error: 'NO_CONFIG');
  }

  final log = TraceLog(sink);

  try {
    final settings = config['f'];
    if (settings is! Map) {
      return EvaluationResult<T>(
          value: defaultValue, error: 'MALFORMED_CONFIG');
    }

    if (!settings.containsKey(key)) {
      return EvaluationResult<T>(value: defaultValue, error: 'KEY_NOT_FOUND');
    }

    final setting = settings[key];
    if (setting is! Map) {
      return EvaluationResult<T>(
          value: defaultValue, error: 'MALFORMED_CONFIG');
    }

    final settingType = setting['t'];
    if (settingType is! int) {
      return EvaluationResult<T>(
          value: defaultValue, error: 'MALFORMED_CONFIG');
    }

    // Type guard BEFORE evaluating rules (mirrors evaluator.ts): the default
    // must be type-compatible with the setting's declared type. A `null`
    // default bypasses the check — used by the variation-id matrix.
    if (defaultValue != null) {
      final mismatch = _checkDefaultType(settingType, defaultValue);
      if (mismatch != null) {
        return EvaluationResult<T>(value: defaultValue, error: mismatch);
      }
    }

    // Evaluation-log trace (ADR 0003). Built lazily — only when the sink would
    // emit at INFO. The header is appended here; the `Returning '<value>'.`
    // footer below; the whole multi-line trace is surfaced under event id 5000.
    EvaluateLogBuilder? logBuilder;
    if (log.enabled(TraceLevel.info)) {
      logBuilder = EvaluateLogBuilder();
      logBuilder.append("Evaluating '$key'");
      if (user != null) {
        logBuilder.append(" for User '${_userAttributesForLogJson(user)}'");
      }
    }

    // Evaluation core (the seam): resolve the setting to a `v` envelope +
    // matched-rule/option identity. For a rule-less config this collapses to
    // the served `setting['v']`, byte-identical to the pre-engine behaviour.
    final ctx = _EvalContext(
      key: key,
      setting: setting,
      settings: settings,
      segments: _configSegments(config),
      configSalt: _configSalt(config),
      user: user,
      state: _EvalState(),
      visitedFlags: VisitedFlags(),
      log: log,
      logBuilder: logBuilder,
    );
    final result = _evaluateSetting(ctx);

    final valueSlot = result.value;
    if (valueSlot is! Map) {
      return EvaluationResult<T>(value: defaultValue, error: 'MALFORMED_VALUE');
    }

    var variationId = result.variationId;
    if (variationId == null && setting['i'] is String) {
      variationId = setting['i'] as String;
    }

    // The typed-widening decision tree runs UNCHANGED on the resolved envelope
    // (rule-served, percentage-served, or static).
    final EvaluationResult<T> typed;
    switch (settingType) {
      case _settingTypeBool:
        typed = _resolveBool<T>(
            valueSlot, defaultValue, variationId, result, ctx.state.evalError);
        break;
      case _settingTypeString:
        typed = _resolveString<T>(
            valueSlot, defaultValue, variationId, result, ctx.state.evalError);
        break;
      case _settingTypeInt:
        typed = _resolveInt<T>(
            valueSlot, defaultValue, variationId, result, ctx.state.evalError);
        break;
      case _settingTypeDouble:
        typed = _resolveDouble<T>(
            valueSlot, defaultValue, variationId, result, ctx.state.evalError);
        break;
      default:
        return EvaluationResult<T>(
          value: defaultValue,
          error: 'UNSUPPORTED_TYPE',
        );
    }

    // Footer + emit. The INFO 5000 trace is emitted only when the resolved
    // value is clean (no error); a type/value error fails closed without a
    // footer (matching evaluator.ts, which emits after the value guard).
    if (logBuilder != null && typed.error == null) {
      logBuilder
          .newLine("Returning '${settingValueToLogString(typed.value)}'.");
      log.info(evalLogEventId, logBuilder.toString());
    }

    return typed;
  } on CircularDependencyError catch (cycle) {
    // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
    // (naming the setting + the chain), not the generic evaluation-error path.
    log.circularDependency(key, cycle.cycle);
    return EvaluationResult<T>(value: defaultValue, error: 'EVAL_EXCEPTION');
    // ignore: avoid_catches_without_on_clauses — fail-closed guard.
  } catch (_) {
    // Bounded fail-closed (FR-007/SC-004): every internal failure — a
    // malformed prereq/segment reference, or any unexpected error — resolves
    // to the caller's default with EVAL_EXCEPTION.
    return EvaluationResult<T>(value: defaultValue, error: 'EVAL_EXCEPTION');
  }
}

/// Render the user's attributes as the eval-log header shows them — a
/// Confeature-canonical object `{Identifier, Email?, Country?, …custom}`
/// JSON-serialized to the `for User '…'` token (ADR 0003 addendum). This is the
/// configcat-js form (the vendored go-sdk oracle's map is transformed to it in
/// the corpus so the cross-SDK trace stays byte-identical).
///
/// Insertion order is fixed (Identifier, Email, Country, then custom in the
/// order the user's custom map yields) and the serialization is compact (no
/// spaces) with JS-JSON string escaping — mirroring
/// `JSON.stringify(userAttributesForLog(user))`.
String _userAttributesForLogJson(EvalUser user) {
  final parts = <String>['"Identifier":${_jsJsonString(user.identifier)}'];
  final email = user.email;
  if (email != null) {
    parts.add('"Email":${_jsJsonString(email)}');
  }
  final country = user.country;
  if (country != null) {
    parts.add('"Country":${_jsJsonString(country)}');
  }
  final custom = user.customAttributes;
  if (custom != null) {
    custom.forEach((name, value) {
      parts.add('${_jsJsonString(name)}:'
          '${_jsJsonString(userAttributeValueToString(value))}');
    });
  }
  return '{${parts.join(',')}}';
}

/// Serialize a string exactly as ECMAScript `JSON.stringify` of a string:
/// wrapped in double quotes, with `"`, `\`, and the C0 control characters
/// escaped (`\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, else `\u00XX`), all other
/// code points (incl. `/` and non-ASCII) verbatim.
String _jsJsonString(String str) {
  final out = StringBuffer('"');
  for (final code in str.codeUnits) {
    switch (code) {
      case 0x22:
        out.write(r'\"');
        break;
      case 0x5C:
        out.write(r'\\');
        break;
      case 0x08:
        out.write(r'\b');
        break;
      case 0x09:
        out.write(r'\t');
        break;
      case 0x0A:
        out.write(r'\n');
        break;
      case 0x0C:
        out.write(r'\f');
        break;
      case 0x0D:
        out.write(r'\r');
        break;
      default:
        if (code < 0x20) {
          out.write('\\u${code.toRadixString(16).padLeft(4, '0')}');
        } else {
          out.writeCharCode(code);
        }
        break;
    }
  }
  out.write('"');
  return out.toString();
}

String _configSalt(Map<dynamic, dynamic> config) {
  final prefs = config['p'];
  final salt = prefs is Map ? prefs['s'] : null;
  return salt is String ? salt : '';
}

List<dynamic> _configSegments(Map<dynamic, dynamic> config) {
  final raw = config['s'];
  return raw is List ? raw : const <dynamic>[];
}

/// TYPE_MISMATCH if the default type is wrong, else null (preserves SC-006).
String? _checkDefaultType(int settingType, Object? defaultValue) {
  switch (settingType) {
    case _settingTypeBool:
      return defaultValue is bool ? null : 'TYPE_MISMATCH';
    case _settingTypeString:
      return defaultValue is String ? null : 'TYPE_MISMATCH';
    case _settingTypeInt:
      // Dart's `int` is disjoint from `double` and `bool`.
      return defaultValue is int ? null : 'TYPE_MISMATCH';
    case _settingTypeDouble:
      return defaultValue is double ? null : 'TYPE_MISMATCH';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Evaluation core — rule walk / conditions / percentage
// ---------------------------------------------------------------------------

_SettingResult _evaluateSetting(_EvalContext ctx) {
  final setting = ctx.setting;

  // 1. Targeting rules — first-match-wins (US1).
  final rules = setting['r'];
  if (rules is List && rules.isNotEmpty) {
    final ruleResult = _evaluateTargetingRules(rules, ctx);
    if (ruleResult != null) return ruleResult;
  }

  // 2. Setting-level percentage options (US3).
  final options = setting['p'];
  if (options is List && options.isNotEmpty) {
    final optionResult = _evaluatePercentageOptions(options, null, ctx);
    if (optionResult != null) return optionResult;
  }

  // 3. Served fallback `setting['v']`.
  return _SettingResult(
    setting['v'],
    setting['i'] is String ? setting['i'] as String : null,
  );
}

_SettingResult? _evaluateTargetingRules(List<dynamic> rules, _EvalContext ctx) {
  final lb = ctx.logBuilder;
  lb?.newLine(
      'Evaluating targeting rules and applying the first match if any:');
  for (final rule in rules) {
    if (rule is! Map) continue;
    final conditions = rule['c'];
    final conditionsList = conditions is List ? conditions : const <dynamic>[];
    final outcome = _evaluateConditions(
      conditionsList,
      ctx.key,
      ctx,
      rule,
    );
    if (outcome != true) {
      // A rule whose conditions ERRORED (missing user/attr) is ignored and
      // evaluation continues — ConfigCat emits this trace line. A rule that
      // merely did NOT match (false) just continues, with no such line.
      if (lb != null && outcome is ValidationError) {
        lb
            .increaseIndent()
            .newLine('The current targeting rule is ignored and the '
                'evaluation continues with the next rule.')
            .decreaseIndent();
      }
      continue;
    }

    final served = rule['s'];
    if (served is Map) {
      return _SettingResult(
        served['v'],
        served['i'] is String ? served['i'] as String : null,
        rule,
      );
    }

    // A rule serving % options: the block is traced one level deeper (under the
    // rule). If the options can't resolve (no user / missing keying attr) the
    // rule is ignored and evaluation continues.
    final options = rule['p'];
    lb?.increaseIndent();
    final optionResult = _evaluatePercentageOptions(
      options is List ? options : const <dynamic>[],
      rule,
      ctx,
    );
    if (optionResult != null) {
      lb?.decreaseIndent();
      return optionResult;
    }
    lb
        ?.newLine('The current targeting rule is ignored and the evaluation '
            'continues with the next rule.')
        .decreaseIndent();
    // % options weren't resolvable (no user / missing attr) → ignore the rule.
  }
  return null;
}

_SettingResult? _evaluatePercentageOptions(
  List<dynamic> options,
  Map<dynamic, dynamic>? matchedRule,
  _EvalContext ctx,
) {
  final lb = ctx.logBuilder;
  final user = ctx.user;
  if (user == null) {
    _surfaceMissingUser(ctx);
    lb?.newLine('Skipping % options because the User Object is missing.');
    return null;
  }

  final rawAttrName = ctx.setting['a'];
  String attrName;
  Object? attrValue;
  if (rawAttrName is! String) {
    attrName = _identifierAttribute;
    attrValue = user.identifier;
  } else {
    attrName = rawAttrName;
    attrValue = _getUserAttribute(user, attrName);
  }
  if (attrValue == null) {
    ctx.state.evalError ??= _missingUserAttributeError(attrName);
    ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName);
    lb?.newLine(
        'Skipping % options because the User.$attrName attribute is missing.');
    return null;
  }

  final hashValue =
      percentageBucket(ctx.key, userAttributeValueToString(attrValue));

  if (lb != null) {
    lb.newLine('Evaluating % options based on the User.$attrName attribute:');
    lb.newLine('- Computing hash in the [0..99] range from User.$attrName => '
        '$hashValue (this value is sticky and consistent across all SDKs)');
  }

  final settingType = ctx.setting['t'];
  var bucket = 0;
  var index = 0;
  for (final option in options) {
    if (option is! Map) continue;
    index++;
    final width = option['p'];
    bucket += (width is int) ? width : (width is double ? width.toInt() : 0);
    if (hashValue >= bucket) continue;
    final value = option['v'];
    if (lb != null && settingType is int) {
      final selected = _selectSettingValue(value, settingType);
      final widthLog = (width is int || width is double) ? width : 0;
      lb.newLine('- Hash value $hashValue selects % option $index '
          "(${settingValueToLogString(widthLog)}%), "
          "'${settingValueToLogString(selected)}'.");
    }
    return _SettingResult(
      value,
      option['i'] is String ? option['i'] as String : null,
      matchedRule,
      option,
    );
  }

  // Sum of widths < 100 — a malformed config. Throw so the outer fail-closed
  // frame returns the default (common-js throws here too).
  throw const MalformedConfigError(
      'Sum of percentage option percentages is less than 100.');
}

/// Evaluate an AND-grouped condition list, short-circuiting on first non-match
/// / error. Returns `true` (all matched), `false`, or a [ValidationError].
Object _evaluateConditions(
  List<dynamic> conditions,
  String contextSalt,
  _EvalContext ctx, [
  Map<dynamic, dynamic>? rule,
]) {
  final lb = ctx.logBuilder;
  lb?.newLine('- ');
  Object result = true;
  var i = 0;
  for (final condition in conditions) {
    if (lb != null) {
      if (i == 0) {
        lb.append('IF ').increaseIndent();
      } else {
        lb.increaseIndent().newLine('AND ');
      }
    }
    if (condition is! Map) {
      result = error('empty condition');
    } else if (condition['u'] is Map) {
      result = _evaluateUserCondition(
          condition['u'] as Map<dynamic, dynamic>, contextSalt, ctx);
    } else if (condition['p'] is Map) {
      result = _evaluatePrerequisiteCondition(
          condition['p'] as Map<dynamic, dynamic>, ctx);
    } else if (condition['s'] is Map) {
      result = _evaluateSegmentCondition(
          condition['s'] as Map<dynamic, dynamic>, ctx);
    } else {
      result = error('empty condition');
    }
    if (lb != null) {
      // The go-sdk oracle always shows the per-condition consequence (even for
      // a single-condition rule). A clean match is true; anything else
      // (no-match or surfaced error) renders the `=> false, skipping…` form.
      lb.appendConditionConsequence(result == true);
      lb.decreaseIndent();
    }
    i++;
    if (result != true) break;
  }

  // Append the rule's THEN consequence (rule-owned condition list only). The go
  // oracle newlines THEN when the rule has conditions.
  if (rule != null && lb != null) {
    _appendRuleConsequence(lb, rule, conditions, result, ctx);
  }
  return result;
}

/// Append the matched/no-match/error THEN consequence for a targeting rule.
void _appendRuleConsequence(
  EvaluateLogBuilder lb,
  Map<dynamic, dynamic> rule,
  List<dynamic> conditions,
  Object result,
  _EvalContext ctx,
) {
  final (thenValue, hasThen) = _ruleThenValue(rule, ctx);
  final MatchOrError outcome;
  if (result == true) {
    outcome = MatchOrError.match();
  } else if (result is ValidationError) {
    outcome = MatchOrError.error(result.message);
  } else {
    outcome = MatchOrError.noMatch();
  }
  lb.appendTargetingRuleConsequence(
      hasThen ? thenValue : null, outcome, conditions.isNotEmpty);
}

/// A rule's formatted served value (e.g. `Dog`) for a fixed-value rule;
/// `(null, false)` for a rule serving `% options`.
(String?, bool) _ruleThenValue(Map<dynamic, dynamic> rule, _EvalContext ctx) {
  final served = rule['s'];
  if (served is! Map) return (null, false);
  final settingType = ctx.setting['t'];
  if (settingType is! int) return (null, false);
  final value = _selectSettingValue(served['v'], settingType);
  return (settingValueToLogString(value), true);
}

Object _evaluateUserCondition(
  Map<dynamic, dynamic> condition,
  String contextSalt,
  _EvalContext ctx,
) {
  ctx.logBuilder?.appendUserCondition(condition);
  final user = ctx.user;
  if (user == null) {
    _surfaceMissingUser(ctx);
    return error(_missingUserObjectError);
  }

  final rawAttrName = condition['a'];
  final attrName = rawAttrName is String ? rawAttrName : null;
  final attrValue = attrName == null ? null : _getUserAttribute(user, attrName);
  if (attrName == null || attrValue == null || attrValue == '') {
    final msg = _missingUserAttributeError(rawAttrName?.toString() ?? '');
    ctx.state.evalError ??= msg;
    // ConfigCat logs a WARN 3003 per targeting rule whose attribute is missing
    // (not deduped — AND short-circuit means one per rule).
    ctx.log
        .userObjectAttributeIsMissing(ctx.key, rawAttrName?.toString() ?? '');
    return error(msg);
  }

  final cmp = condition['c'];
  if (cmp is! int) return error('unknown comparator');
  final list = _stringList(condition['l']);
  final sv = condition['s'] is String ? condition['s'] as String : '';
  final dvRaw = condition['d'];
  final dv = dvRaw is int ? dvRaw.toDouble() : (dvRaw is double ? dvRaw : 0.0);
  final rawDv =
      dvRaw is int ? dvRaw.toDouble() : (dvRaw is double ? dvRaw : null);

  final result = _dispatchComparator(cmp, attrName, attrValue, list, sv, dv,
      rawDv, ctx.configSalt, contextSalt);
  if (result is ValidationError) {
    _surfaceUserConditionError(result, ctx);
  }
  return result;
}

/// Surface + log the typed validation / malformed-operand outcomes the trace
/// replays. An attribute-invalid error → WARN 3004
/// (`userObjectAttributeIsInvalid`); a malformed config operand (#509) → WARN
/// 3004 (`comparisonValueIsInvalid`). Both also feed `state.evalError` (FR-016)
/// the way the missing paths do.
void _surfaceUserConditionError(ValidationError result, _EvalContext ctx) {
  ctx.state.evalError ??= result.message;
  final m = _attrInvalidRe.firstMatch(result.message);
  if (m != null) {
    ctx.log.userObjectAttributeIsInvalid(ctx.key, m.group(1)!, m.group(2)!);
  } else if (result.message.startsWith("comparison value '")) {
    ctx.log.comparisonValueIsInvalid(ctx.key, result.message);
  }
}

final RegExp _attrInvalidRe =
    RegExp(r'^cannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)$');

Object _dispatchComparator(
  int cmp,
  String attrName,
  Object? attrValue,
  List<String> list,
  String sv,
  double dv,
  double? rawDv,
  String salt,
  String contextSalt,
) {
  String text() => attributeAsText(attrValue);

  switch (cmp) {
    case Cmp.textEquals:
    case Cmp.textNotEquals:
      return evaluateTextEquals(text(), sv, cmp == Cmp.textNotEquals);
    case Cmp.sensitiveTextEquals:
    case Cmp.sensitiveTextNotEquals:
      return evaluateSensitiveTextEquals(
          text(), sv, salt, contextSalt, cmp == Cmp.sensitiveTextNotEquals);
    case Cmp.textIsOneOf:
    case Cmp.textIsNotOneOf:
      return evaluateTextIsOneOf(text(), list, cmp == Cmp.textIsNotOneOf);
    case Cmp.sensitiveTextIsOneOf:
    case Cmp.sensitiveTextIsNotOneOf:
      return evaluateSensitiveTextIsOneOf(
          text(), list, salt, contextSalt, cmp == Cmp.sensitiveTextIsNotOneOf);
    case Cmp.textStartsWithAnyOf:
    case Cmp.textNotStartsWithAnyOf:
      return evaluateTextSliceEqualsAnyOf(
          text(), list, true, cmp == Cmp.textNotStartsWithAnyOf);
    case Cmp.sensitiveTextStartsWithAnyOf:
    case Cmp.sensitiveTextNotStartsWithAnyOf:
      return evaluateSensitiveTextSliceEqualsAnyOf(text(), list, salt,
          contextSalt, true, cmp == Cmp.sensitiveTextNotStartsWithAnyOf);
    case Cmp.textEndsWithAnyOf:
    case Cmp.textNotEndsWithAnyOf:
      return evaluateTextSliceEqualsAnyOf(
          text(), list, false, cmp == Cmp.textNotEndsWithAnyOf);
    case Cmp.sensitiveTextEndsWithAnyOf:
    case Cmp.sensitiveTextNotEndsWithAnyOf:
      return evaluateSensitiveTextSliceEqualsAnyOf(text(), list, salt,
          contextSalt, false, cmp == Cmp.sensitiveTextNotEndsWithAnyOf);
    case Cmp.textContainsAnyOf:
    case Cmp.textNotContainsAnyOf:
      return evaluateTextContainsAnyOf(
          text(), list, cmp == Cmp.textNotContainsAnyOf);
    case Cmp.semverIsOneOf:
    case Cmp.semverIsNotOneOf:
      final r = attributeAsSemver(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateSemverIsOneOf(
              r as SemVer, list, cmp == Cmp.semverIsNotOneOf);
    case Cmp.semverLess:
    case Cmp.semverLessOrEquals:
    case Cmp.semverGreater:
    case Cmp.semverGreaterOrEquals:
      // configcat-common validates the CONFIG comparison value BEFORE the user
      // attribute (#509): a malformed operand wins even when the attribute is
      // also malformed.
      final cv = comparisonValueAsSemver(sv);
      if (cv is ComparisonValueError) return error(cv.message);
      final r = attributeAsSemver(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateSemverRelation(r as SemVer, cmp, sv);
    case Cmp.numberEquals:
    case Cmp.numberNotEquals:
    case Cmp.numberLess:
    case Cmp.numberLessOrEquals:
    case Cmp.numberGreater:
    case Cmp.numberGreaterOrEquals:
      final cvn = comparisonValueAsNumber(rawDv);
      if (cvn is ComparisonValueError) return error(cvn.message);
      final r = attributeAsNumber(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateNumberRelation(r as double, cmp, dv);
    case Cmp.datetimeBefore:
    case Cmp.datetimeAfter:
      final cvd = comparisonValueAsUnixTimeSeconds(rawDv);
      if (cvd is ComparisonValueError) return error(cvd.message);
      final r = attributeAsUnixTimeSeconds(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateDatetimeRelation(
              r as double, dv, cmp == Cmp.datetimeBefore);
    case Cmp.arrayContainsAnyOf:
    case Cmp.arrayNotContainsAnyOf:
      final r = attributeAsStringArray(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateArrayContainsAnyOf(
              r as List<String>, list, cmp == Cmp.arrayNotContainsAnyOf);
    case Cmp.sensitiveArrayContainsAnyOf:
    case Cmp.sensitiveArrayNotContainsAnyOf:
      final r = attributeAsStringArray(attrName, attrValue);
      return r is ValidationError
          ? r
          : evaluateSensitiveArrayContainsAnyOf(r as List<String>, list, salt,
              contextSalt, cmp == Cmp.sensitiveArrayNotContainsAnyOf);
    default:
      return error('unknown comparator $cmp');
  }
}

Object _evaluatePrerequisiteCondition(
  Map<dynamic, dynamic> condition,
  _EvalContext ctx,
) {
  final lb = ctx.logBuilder;

  int? prereqType(String prereqKey) {
    final s = ctx.settings[prereqKey];
    final t = s is Map ? s['t'] : null;
    return t is int ? t : null;
  }

  // Trace the `Flag 'X' EQUALS 'Y'` condition before recursing (the comparison
  // value is read through the prereq flag's own declared type).
  if (lb != null) {
    final prereqKey = condition['f'];
    var cmpText = '';
    if (prereqKey is String) {
      final pt = prereqType(prereqKey);
      if (pt != null) {
        final cmpVal = _selectSettingValue(condition['v'], pt);
        if (cmpVal != null) cmpText = settingValueToLogString(cmpVal);
      }
    }
    final cmp = condition['c'];
    lb.appendPrerequisiteFlagCondition(
      prereqKey is String ? prereqKey : '',
      cmp is int ? cmp : -1,
      cmpText,
    );
  }

  Object? evaluatePrereqFlag(String prereqKey) {
    final prereqSetting = ctx.settings[prereqKey];
    if (prereqSetting is! Map) {
      throw const MalformedConfigError(
          'Prerequisite flag is missing or invalid.');
    }
    // A prerequisite flag evaluates in its OWN context (configcat
    // forPrerequisiteFlag): the no-user WARN dedups per flag, so a prereq
    // referenced by N rules logs it N times — hence a fresh state that carries
    // forward the already-surfaced evalError (FR-016). The child shares the
    // SAME mutable visited-flags stack so a cross-level cycle is detected.
    final childState = _EvalState(ctx.state.evalError);
    final child = _EvalContext(
      key: prereqKey,
      setting: prereqSetting,
      settings: ctx.settings,
      segments: ctx.segments,
      configSalt: ctx.configSalt,
      user: ctx.user,
      state: childState,
      visitedFlags: ctx.visitedFlags,
      log: ctx.log,
      logBuilder: lb,
    );
    if (lb != null) {
      lb.newLine('(').increaseIndent().newLine("Evaluating '$prereqKey'");
      if (ctx.user != null) {
        lb.append(" for User '${_userAttributesForLogJson(ctx.user!)}'");
      }
    }
    final resolved = _evaluateSetting(child);
    ctx.state.evalError ??= childState.evalError;
    if (lb != null) {
      final declaredType = prereqType(prereqKey);
      final childValue = declaredType == null
          ? null
          : _selectSettingValue(resolved.value, declaredType);
      lb
          .newLine("Returning '${settingValueToLogString(childValue)}'.")
          .decreaseIndent()
          .newLine(')');
    }
    return resolved.value;
  }

  return evaluatePrerequisiteFlagCondition(
    condition,
    ctx.key,
    ctx.visitedFlags,
    prereqType,
    evaluatePrereqFlag,
    _selectSettingValue,
  );
}

Object _evaluateSegmentCondition(
  Map<dynamic, dynamic> condition,
  _EvalContext ctx,
) {
  if (ctx.logBuilder == null) {
    // Hot path — behaviour identical to before the trace seam existed.
    String surface() {
      _surfaceMissingUser(ctx);
      return _missingUserObjectError;
    }

    return evaluateSegmentCondition(
      condition,
      ctx.segments,
      ctx.user != null,
      surface,
      (uc, salt) => _evaluateUserCondition(uc, salt, ctx),
    );
  }
  return _evaluateSegmentConditionTraced(condition, ctx);
}

/// Traced segment path (mirrors evaluator.ts / Go's evaluateSegmentCond).
/// Resolve the segment name first so the `User IS [NOT] IN SEGMENT 'X'` line is
/// appended before the no-user / reference guards, exactly like the oracle.
Object _evaluateSegmentConditionTraced(
  Map<dynamic, dynamic> condition,
  _EvalContext ctx,
) {
  final lb = ctx.logBuilder!;

  final index = condition['s'];
  Map<dynamic, dynamic>? segment;
  if (index is int && index >= 0 && index < ctx.segments.length) {
    final candidate = ctx.segments[index];
    if (candidate is Map) segment = candidate;
  }
  final rawName = segment?['n'];
  final segmentName = rawName is String ? rawName : '';
  final cmp = condition['c'];
  final cmpInt = cmp is int ? cmp : segmentIsIn;
  lb.appendSegmentCondition(segmentName, cmpInt);

  if (ctx.user == null) {
    _surfaceMissingUser(ctx);
    return error(_missingUserObjectError);
  }
  if (segment == null || segmentName.isEmpty) {
    throw const MalformedConfigError('Segment reference is invalid.');
  }

  lb
      .newLine('(')
      .increaseIndent()
      .newLine("Evaluating segment '$segmentName':");
  final rawRules = segment['r'];
  final wrapped = <Map<dynamic, dynamic>>[];
  if (rawRules is List) {
    for (final uc in rawRules) {
      wrapped.add(<dynamic, dynamic>{'u': uc});
    }
  }
  final inSegment = _evaluateConditions(wrapped, segmentName, ctx);

  final errored = inSegment is ValidationError;
  // IsNotIn negates a clean boolean outcome; an errored segment is surfaced
  // un-negated — IsNotIn never flips an error into a match.
  Object result = inSegment;
  if (!errored && cmpInt == segmentIsNotIn) {
    result = !(inSegment as bool);
  }

  lb.newLine('Segment evaluation result: ');
  if (errored) {
    lb.append(ctx.state.evalError ?? '');
  } else {
    lb.append(
        inSegment == true ? 'User IS IN SEGMENT' : 'User IS NOT IN SEGMENT');
  }
  lb.append('.');
  lb
      .newLine('Condition (')
      .appendSegmentCondition(segmentName, cmpInt)
      .append(')');
  if (errored) {
    lb.append(' failed to evaluate');
  } else {
    lb.append(' evaluates to ').appendConditionResult(result == true);
  }
  lb.append('.').decreaseIndent().newLine(')');

  if (errored) {
    return error(ctx.state.evalError ?? _missingUserObjectError);
  }
  return result;
}

/// Read the typed value out of a `v` envelope by the setting's `t`. Mirrors
/// `evaluator.ts::selectSettingValue`. The key is chosen from `t`, never from
/// the runtime shape of the parsed value.
Object? _selectSettingValue(Object? value, int settingType) {
  if (value is! Map) return null;
  switch (settingType) {
    case _settingTypeBool:
      return value['b'];
    case _settingTypeString:
      return value['s'];
    case _settingTypeInt:
      return value['i'];
    case _settingTypeDouble:
      // JSON numbers without a fractional part decode as int; widen an integral
      // double so the prerequisite `==` matches the float comparison value.
      final v = value['d'];
      return v is int ? v.toDouble() : v;
    default:
      return null;
  }
}

void _surfaceMissingUser(_EvalContext ctx) {
  ctx.state.evalError ??= _missingUserObjectError;
  if (ctx.state.missingUserObjectLogged) return;
  ctx.log.userObjectIsMissing(ctx.key);
  ctx.state.missingUserObjectLogged = true;
}

Object? _getUserAttribute(EvalUser user, String name) {
  switch (name) {
    case _identifierAttribute:
      return user.identifier;
    case _emailAttribute:
      return user.email;
    case _countryAttribute:
      return user.country;
    default:
      return user.customAttribute(name);
  }
}

List<String> _stringList(Object? raw) {
  if (raw is! List) return const <String>[];
  final out = <String>[];
  for (final item in raw) {
    if (item is String) out.add(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed value resolution (spec-072 widening) — preserved UNCHANGED (SC-006)
// ---------------------------------------------------------------------------

EvaluationResult<T> _resolveBool<T>(
  Map<dynamic, dynamic> valueSlot,
  T defaultValue,
  String? variationId,
  _SettingResult result,
  String? evalError,
) {
  if (defaultValue is! bool && defaultValue != null) {
    return EvaluationResult<T>(value: defaultValue, error: 'TYPE_MISMATCH');
  }
  final raw = valueSlot['b'];
  if (raw is! bool) {
    return EvaluationResult<T>(value: defaultValue, error: 'VALUE_NOT_BOOL');
  }
  return EvaluationResult<T>(
    value: raw as T,
    variationId: variationId,
    matchedTargetingRule: result.matchedRule,
    matchedPercentageOption: result.matchedOption,
    evalError: evalError,
  );
}

EvaluationResult<T> _resolveString<T>(
  Map<dynamic, dynamic> valueSlot,
  T defaultValue,
  String? variationId,
  _SettingResult result,
  String? evalError,
) {
  if (defaultValue is! String && defaultValue != null) {
    return EvaluationResult<T>(value: defaultValue, error: 'TYPE_MISMATCH');
  }
  final raw = valueSlot['s'];
  if (raw is! String) {
    return EvaluationResult<T>(value: defaultValue, error: 'MALFORMED_VALUE');
  }
  return EvaluationResult<T>(
    value: raw as T,
    variationId: variationId,
    matchedTargetingRule: result.matchedRule,
    matchedPercentageOption: result.matchedOption,
    evalError: evalError,
  );
}

EvaluationResult<T> _resolveInt<T>(
  Map<dynamic, dynamic> valueSlot,
  T defaultValue,
  String? variationId,
  _SettingResult result,
  String? evalError,
) {
  // Dart's `int` is disjoint from `double` — a `double` default refuses with
  // TYPE_MISMATCH. `bool` is also disjoint from `int`, so no bool guard needed.
  if (defaultValue is! int && defaultValue != null) {
    return EvaluationResult<T>(value: defaultValue, error: 'TYPE_MISMATCH');
  }
  final raw = valueSlot['i'];
  if (raw is! int) {
    return EvaluationResult<T>(value: defaultValue, error: 'MALFORMED_VALUE');
  }
  return EvaluationResult<T>(
    value: raw as T,
    variationId: variationId,
    matchedTargetingRule: result.matchedRule,
    matchedPercentageOption: result.matchedOption,
    evalError: evalError,
  );
}

EvaluationResult<T> _resolveDouble<T>(
  Map<dynamic, dynamic> valueSlot,
  T defaultValue,
  String? variationId,
  _SettingResult result,
  String? evalError,
) {
  // Strict — Dart's `double` is disjoint from `int`. An `int` default against a
  // t:3 setting refuses with TYPE_MISMATCH.
  if (defaultValue is! double && defaultValue != null) {
    return EvaluationResult<T>(value: defaultValue, error: 'TYPE_MISMATCH');
  }
  // `jsonDecode` returns `int` for integer-valued JSON numbers; widen.
  final raw = valueSlot['d'];
  double? widened;
  if (raw is double) {
    widened = raw;
  } else if (raw is int) {
    widened = raw.toDouble();
  }
  if (widened == null) {
    return EvaluationResult<T>(value: defaultValue, error: 'MALFORMED_VALUE');
  }
  return EvaluationResult<T>(
    value: widened as T,
    variationId: variationId,
    matchedTargetingRule: result.matchedRule,
    matchedPercentageOption: result.matchedOption,
    evalError: evalError,
  );
}
