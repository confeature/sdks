// SPDX-License-Identifier: MIT

import Foundation

/// SDK version stamp. Interpolated into the outgoing User-Agent header
/// (`confeature-swift-sdk/{version}`) and exposed publicly for tests +
/// diagnostics.
///
/// Bumping this string is the only change required when cutting a new
/// release; the value MUST match the tag on the
/// `Confeature-vX.Y.Z` release commit.
public enum Version {
    /// Current SDK version. Format: semver `MAJOR.MINOR.PATCH`.
    public static let sdk: String = "0.1.0"
}
