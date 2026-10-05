// SPDX-License-Identifier: MIT

/// Polling strategies for the Confeature SDK.
///
/// Three options mirror `configcat_client`'s `PollingMode` 1:1
/// (constitution Principle II):
///
///   - [AutoPoll]: background `Timer.periodic` fetches every
///     `pollInterval`. Default 60s. First fetch happens during
///     [client construction]; subsequent fetches on the timer cadence.
///   - [LazyLoad]: fetch on first `getValue` past the
///     `cacheRefreshInterval` staleness threshold.
///   - [ManualPoll]: fetch only when the customer calls
///     `client.forceRefresh()`.
///
/// The classes are simple value types — the actual scheduling logic
/// lives in `client.dart` (which owns the `Timer` and the `_closed`
/// state).
library;

import 'package:meta/meta.dart';

/// Sealed base for the three polling strategies.
@sealed
abstract class PollingMode {
  /// Default constructor for the three concrete subtypes.
  const PollingMode();

  /// Factory: AutoPoll(60s, 5s) is the default — matches
  /// `configcat_client`'s defaults.
  static PollingMode autoPoll({
    Duration pollInterval = const Duration(seconds: 60),
    Duration maxInitWaitTime = const Duration(seconds: 5),
  }) =>
      AutoPoll(pollInterval: pollInterval, maxInitWaitTime: maxInitWaitTime);

  /// Factory: LazyLoad(60s) — refresh on first stale read.
  static PollingMode lazyLoad({
    Duration cacheRefreshInterval = const Duration(seconds: 60),
  }) =>
      LazyLoad(cacheRefreshInterval: cacheRefreshInterval);

  /// Factory: ManualPoll() — only fetch on explicit `forceRefresh`.
  static PollingMode manualPoll() => const ManualPoll();
}

/// Background-polling strategy. A `Timer.periodic` ticks at
/// [pollInterval] cadence; `client.forceRefresh()` fetches off-cadence.
@immutable
class AutoPoll extends PollingMode {
  /// Construct an AutoPoll strategy.
  const AutoPoll({
    this.pollInterval = const Duration(seconds: 60),
    this.maxInitWaitTime = const Duration(seconds: 5),
  });

  /// Time between background fetches.
  final Duration pollInterval;

  /// Maximum time `getValue` waits for the initial fetch to complete
  /// before falling through to the cached config / default.
  final Duration maxInitWaitTime;
}

/// On-demand strategy. `getValue` triggers a fetch when the last
/// successful fetch is older than [cacheRefreshInterval].
@immutable
class LazyLoad extends PollingMode {
  /// Construct a LazyLoad strategy.
  const LazyLoad({
    this.cacheRefreshInterval = const Duration(seconds: 60),
  });

  /// Staleness threshold after which the next `getValue` triggers a
  /// fetch.
  final Duration cacheRefreshInterval;
}

/// No-background-fetch strategy. Only `client.forceRefresh()` triggers
/// a fetch.
@immutable
class ManualPoll extends PollingMode {
  /// Construct a ManualPoll strategy.
  const ManualPoll();
}
