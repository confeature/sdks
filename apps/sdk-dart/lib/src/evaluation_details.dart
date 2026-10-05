// SPDX-License-Identifier: MIT

/// Typed result envelope returned by
/// `ConfeatureClient.getValueDetails<T>` +
/// `ConfeatureSnapshot.getValueDetails<T>`.
///
/// Spec 088 / closes #266 for the sdk-dart slice. Field layout mirrors
/// upstream `configcat_client` 4.x's `EvaluationDetails<T>` 1:1 so a
/// migrating consumer reads the same field names in the same positions:
/// a customer migrating from ConfigCat to Confeature renames only the
/// `package:` import.
///
/// Stable error codes populating [error] on fail branches match the
/// evaluator's tier-0 set:
///   `KEY_NOT_FOUND` / `TYPE_MISMATCH` / `MALFORMED_VALUE` /
///   `UNSUPPORTED_TYPE` / `NO_CONFIG` / `MALFORMED_CONFIG` /
///   `VALUE_NOT_BOOL` / `CLIENT_CLOSED`.
///
/// [fetchTime] is a [DateTime] (UTC) at which the active config was
/// last fetched from the CDN / restored from the on-disk cache. `null`
/// until any config has loaded.
///
/// [matchedTargetingRule] + [matchedPercentageOption] are v1
/// placeholders (always `null`); a future spec lands the wire-level
/// targeting tree and populates them.
library;

import 'package:meta/meta.dart';

import 'user.dart';

/// Typed result envelope. Generic over the resolved value type [T].
@immutable
class EvaluationDetails<T> {
  /// Construct an evaluation-details envelope. All fields except
  /// [key] + [value] are optional and default to the upstream zero
  /// values (`null` / `false`).
  const EvaluationDetails({
    required this.key,
    required this.value,
    this.variationId,
    this.user,
    this.isDefaultValue = false,
    this.error,
    this.fetchTime,
    this.matchedTargetingRule,
    this.matchedPercentageOption,
  });

  /// The flag key the envelope describes.
  final String key;

  /// Optional variation identifier (the `i` field of the setting).
  final String? variationId;

  /// Targeting context used during evaluation, if any.
  final User? user;

  /// `true` iff the resolved [value] is the caller-supplied default
  /// (i.e. a fail-closed branch was taken).
  final bool isDefaultValue;

  /// Short stable error code on fail-closed branches — `null` on the
  /// happy path.
  final String? error;

  /// The resolved value, or the caller-supplied default on any
  /// error branch.
  final T value;

  /// UTC timestamp at which the active config was last fetched /
  /// restored. `null` until any config has loaded.
  final DateTime? fetchTime;

  /// v1 placeholder — populated by a future spec that lands the
  /// wire-level targeting tree.
  final TargetingRule? matchedTargetingRule;

  /// v1 placeholder — populated by a future spec that lands the
  /// wire-level percentage-option tree.
  final PercentageOption? matchedPercentageOption;

  /// Convenience factory for fail-closed branches: closed client,
  /// caller-supplied invalid input, etc. Mirrors upstream
  /// `EvaluationDetails.makeError` 1:1 — the 4-arg
  /// `(key, defaultValue, error, user)` signature carries.
  static EvaluationDetails<T> makeError<T>(
    String key,
    T defaultValue,
    String error,
    User? user,
  ) =>
      EvaluationDetails<T>(
        key: key,
        value: defaultValue,
        isDefaultValue: true,
        error: error,
        user: user,
      );
}

/// v1 placeholder — Confeature's v1 evaluator produces no
/// targeting-rule matches. A future spec lands the wire-level
/// targeting tree and the matching class shape.
@immutable
class TargetingRule {
  /// Default constructor — empty for v1.
  const TargetingRule();
}

/// v1 placeholder — same as [TargetingRule] for percentage options.
@immutable
class PercentageOption {
  /// Default constructor — empty for v1.
  const PercentageOption();
}
