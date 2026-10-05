// SPDX-License-Identifier: MIT

import Foundation

/// How local overrides interact with the remote configuration.
///
/// In the v1 wave only ``localOnly`` is wired through; the other
/// variants exist at the type level for ABI parity with `ConfigCat-iOS`
/// but resolve to the supplied default at evaluation time (see the
/// 7-branch decision tree in ``OverrideEval``).
public enum OverrideBehaviour: Sendable, Equatable {
    /// Overrides only; remote config is ignored entirely. Honoured in
    /// the v1 evaluator.
    case localOnly
    /// Overrides shadow remote; fall back to remote when key absent.
    /// Deferred — returns the supplied default.
    case localOverRemote
    /// Remote wins; overrides fill gaps. Deferred — returns the
    /// supplied default.
    case remoteOverLocal
}
