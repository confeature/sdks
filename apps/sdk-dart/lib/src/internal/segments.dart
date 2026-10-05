// SPDX-License-Identifier: MIT

/// Segment-condition resolution (v6 + legacy v5). Ported from the spec-117 TS
/// reference (`packages/sdk-shared/src/segments.ts`), cross-checked against
/// the spec-118/119/120/121/122 ports, itself from common-js
/// `RolloutEvaluator.evaluateSegmentCondition`.
///
/// A segment condition (`{'s': index, 'c': comparator}`) references a segment
/// by index into the config's top-level `s[]` (`{'n': name, 'r': [...]}`) and
/// a comparator (`IsIn` / `IsNotIn`). The segment's `r[]` entries are **bare
/// user conditions**, AND-grouped: the user IS-IN the segment iff every
/// condition matches. The decision is then optionally negated by `IsNotIn`.
///
/// The **sensitive-comparator context salt is the segment NAME** (`n`), NOT
/// the setting key — the crucial divergence from a user condition.
///
/// Three-valued outcome: `true` / `false` (a Dart `bool`), or a
/// [ValidationError]. An error is returned **un-negated** — `IsNotIn` never
/// flips an error into a match.
library;

import 'comparators.dart';
import 'errors.dart';

/// `SegmentComparator.IsIn`.
const int segmentIsIn = 0;

/// `SegmentComparator.IsNotIn`.
const int segmentIsNotIn = 1;

/// Resolve one segment condition. [evaluateUserCondition] is injected (the
/// evaluator owns it) so this module has no back-reference to the evaluator; it
/// evaluates one segment `r[]` user condition with the segment NAME as the
/// context salt.
///
/// Returns a Dart `bool` or a [ValidationError]. Throws
/// [MalformedConfigError] on a malformed segment reference.
Object evaluateSegmentCondition(
  Map<dynamic, dynamic> condition,
  List<dynamic> segments,
  bool hasUser,
  String Function() surfaceMissingUser,
  Object Function(Map<dynamic, dynamic> uc, String contextSalt)
      evaluateUserCondition,
) {
  // No user → the whole segment condition is the missing-user error.
  if (!hasUser) {
    return error(surfaceMissingUser());
  }

  final index = condition['s'];
  if (index is! int || index < 0 || index >= segments.length) {
    throw const MalformedConfigError('Segment reference is invalid.');
  }

  final segment = segments[index];
  final segmentName = segment is Map ? segment['n'] : null;
  if (segmentName is! String || segmentName.isEmpty) {
    throw const MalformedConfigError('Segment name is missing.');
  }

  // The segment's `r[]` is an AND-group of BARE user conditions; the context
  // salt is the segment NAME. Short-circuit on first non-match.
  final rules = (segment)['r'];
  Object inSegment = true;
  if (rules is List) {
    for (final uc in rules) {
      if (uc is! Map) {
        throw const MalformedConfigError('Segment condition is invalid.');
      }
      inSegment = evaluateUserCondition(uc, segmentName);
      if (inSegment != true) break;
    }
  }

  // An error is returned un-negated — IsNotIn never converts an error into a
  // match (matches common-js: the comparator switch only runs on a clean bool).
  if (inSegment is! bool) return inSegment;

  return condition['c'] == segmentIsNotIn ? !inSegment : inSegment;
}
