// SPDX-License-Identifier: MIT

/// Prerequisite-flag condition resolution + circular-dependency detection.
/// Ported from the spec-117 TS reference
/// (`packages/sdk-shared/src/prerequisites.ts`), cross-checked against the
/// spec-118/119/120/121/122 ports, itself from common-js
/// `RolloutEvaluator.evaluatePrerequisiteFlagCondition`.
///
/// A prerequisite condition (`{'f': key, 'c': comparator, 'v': env}`) is
/// resolved by **re-evaluating the prerequisite flag** in a child context
/// (same config / user, SHARED [VisitedFlags] list), then comparing its
/// resolved value to the expected `v` via the comparator (`Equals` /
/// `NotEquals`). Both the resolved value and `v` are read through the
/// prerequisite flag's own declared `SettingType`.
///
/// **Cycle detection** uses the shared list: push the CURRENT key, check
/// whether the prerequisite key is already on the list BEFORE recursing — if
/// so, push the prerequisite key too and throw [CircularDependencyError]. The
/// outer `evaluate` catch-all turns that into a fail-closed fallback + error,
/// so a cycle is **bounded** (the key set is finite; the second visit throws)
/// — never a hang, never a stack overflow escape (FR-007, SC-004). On the
/// non-cycle path the current key is popped in a `finally` so siblings restore
/// even if the child throws.
library;

import 'errors.dart';

/// `PrerequisiteFlagComparator.Equals`.
const int prerequisiteEquals = 0;

/// `PrerequisiteFlagComparator.NotEquals`.
const int prerequisiteNotEquals = 1;

/// Shared, mutable cycle-detection stack threaded through prerequisite
/// recursion. Wraps a `List<String>` so the same instance is shared by child
/// contexts (matching the spec-117 shared-array semantics).
class VisitedFlags {
  final List<String> _flags = <String>[];

  /// Push [key] onto the stack.
  void push(String key) => _flags.add(key);

  /// Pop the top key off the stack.
  void pop() {
    if (_flags.isNotEmpty) _flags.removeLast();
  }

  /// True iff [key] is already on the stack.
  bool contains(String key) => _flags.contains(key);

  /// The cycle chain as `a -> b -> a`.
  String chain() => _flags.join(' -> ');
}

/// Resolve one prerequisite-flag condition. The setting re-evaluator + value
/// selector are injected so this module has no back-reference to the evaluator.
/// Returns the comparison result (`true` / `false`). Throws
/// [CircularDependencyError] on a detected cycle or [MalformedConfigError] on
/// a missing prerequisite flag.
bool evaluatePrerequisiteFlagCondition(
  Map<dynamic, dynamic> condition,
  String currentKey,
  VisitedFlags visitedFlags,
  int? Function(String key) prereqType,
  Object? Function(String key) evaluatePrereqFlag,
  Object? Function(Object? value, int type) selectValue,
) {
  final prereqKey = condition['f'];
  if (prereqKey is! String) {
    throw const MalformedConfigError(
        'Prerequisite flag key is missing or invalid.');
  }

  final declaredType = prereqType(prereqKey);
  if (declaredType == null) {
    throw const MalformedConfigError(
        'Prerequisite flag is missing or invalid.');
  }

  // The expected comparison value `v`, read through the prereq's type.
  final comparisonValue = selectValue(condition['v'], declaredType);

  // Cycle detection: push current key, detect a revisit BEFORE recursing.
  visitedFlags.push(currentKey);
  if (visitedFlags.contains(prereqKey)) {
    visitedFlags.push(prereqKey);
    final chain = visitedFlags.chain();
    throw CircularDependencyError(
      'Circular dependency detected between the following depending flags: '
      '$chain.',
      chain,
    );
  }

  // The pop MUST run even if the child evaluation throws, so the shared stack
  // restores for siblings (the spec-121 PHP review lesson) — hence finally.
  Object? resolvedEnvelope;
  try {
    resolvedEnvelope = evaluatePrereqFlag(prereqKey);
  } finally {
    visitedFlags.pop();
  }

  final resolvedValue = selectValue(resolvedEnvelope, declaredType);

  switch (condition['c']) {
    case prerequisiteEquals:
      return resolvedValue == comparisonValue;
    case prerequisiteNotEquals:
      return resolvedValue != comparisonValue;
    default:
      throw const MalformedConfigError(
          'Comparison operator is missing or invalid.');
  }
}
