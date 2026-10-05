// SPDX-License-Identifier: MIT

/// Confeature Dart SDK version.
///
/// Used in the `User-Agent` header (`confeature-dart-sdk/{sdkVersion}`)
/// emitted by every CDN request. MUST stay in sync with
/// `apps/sdk-dart/pubspec.yaml`'s `version:` field — the publish gate
/// (`dart pub publish --dry-run`) and the build-info banner both read
/// from `pubspec.yaml`, while runtime code reads from this constant.
library;

/// Public SDK version string. Bumped per the SDK's own semver track,
/// independently from the wire-contract major version (constitution
/// §Versioning).
const String sdkVersion = '0.1.0';
