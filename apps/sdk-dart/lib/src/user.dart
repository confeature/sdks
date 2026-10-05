// SPDX-License-Identifier: MIT

/// Targeting context for flag evaluation.
///
/// Field names mirror `configcat_client`'s `ConfigCatUser` 1:1
/// (constitution Principle II). The evaluator consumes [identifier],
/// [email], [country], and [custom] when resolving targeting rules and
/// percentage options.
///
/// `custom` is typed as `Map<String, Object>?`, byte-identical to the
/// upstream `ConfigCatUser.custom` contract (`configcat_client` 4.1.1).
/// Values may be `String`, `int`, `double`, `bool`, `DateTime`, or
/// `List<String>`; non-string values are converted on the way into the
/// evaluator exactly as ConfigCat converts them (number → invariant
/// decimal, `DateTime` → second-based Unix epoch, `List` → JSON), so a
/// rule authored against any of those types resolves identically to
/// ConfigCat.
library;

import 'package:meta/meta.dart';

/// Targeting context for a single flag evaluation.
@immutable
class User {
  /// Construct a targeting context.
  ///
  /// - [identifier]: stable user identifier. Required. Empty string is
  ///   accepted (corresponds to the `empty-id` parity-corpus variant).
  /// - [email]: optional contact email.
  /// - [country]: optional ISO country code or free-form country tag.
  /// - [custom]: optional flat map of typed custom attributes. Values may
  ///   be `String`, `int`, `double`, `bool`, `DateTime`, or
  ///   `List<String>` (mirrors `ConfigCatUser.custom`).
  const User({
    required this.identifier,
    this.email,
    this.country,
    this.custom,
  });

  /// Stable user identifier.
  final String identifier;

  /// Optional contact email.
  final String? email;

  /// Optional ISO country code or free-form country tag.
  final String? country;

  /// Optional flat map of typed custom attributes (`String`, `int`,
  /// `double`, `bool`, `DateTime`, or `List<String>`).
  final Map<String, Object>? custom;

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is User &&
        other.identifier == identifier &&
        other.email == email &&
        other.country == country &&
        _mapEquals(other.custom, custom);
  }

  @override
  int get hashCode => Object.hash(
        identifier,
        email,
        country,
        // We can't hash a Map directly in a stable way without sorting,
        // but the parity tests only compare `.value`, so a coarse hash
        // here is acceptable — equality is the load-bearing operation.
        custom == null ? 0 : custom!.length,
      );

  @override
  String toString() =>
      'User(identifier: $identifier, email: $email, country: $country, '
      'custom: $custom)';
}

bool _mapEquals(Map<String, Object>? a, Map<String, Object>? b) {
  if (identical(a, b)) return true;
  if (a == null || b == null) return false;
  if (a.length != b.length) return false;
  for (final entry in a.entries) {
    if (b[entry.key] != entry.value) return false;
  }
  return true;
}
