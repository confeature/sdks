// SPDX-License-Identifier: MIT

/**
 * `ConfeatureService` — Angular-idiomatic facade over a singleton
 * `ConfeatureClient` from `@confeature/sdk-browser-js`.
 *
 * The service is `providedIn: 'root'` so both `provideConfeature`
 * and `ConfeatureModule.forRoot` resolve to the same instance in
 * the same injector (FR-021).
 *
 * Emission model (research §R3 / FR-014, FR-015):
 *  - One `BehaviorSubject<unknown>` per flag key, lazy-created on the
 *    first `getValue(key, ...)` call. 100 subscribers to the same key
 *    share one underlying poll — no per-subscriber timer.
 *  - The service registers a single `configChanged` listener on the
 *    underlying client. On each refresh tick the listener walks the
 *    subject map, re-evaluates each key against the new cache, and
 *    pushes the new value through the subject. Subscribers receive
 *    the update on Angular's standard CD boundary because the emission
 *    happens off the zone — Angular's `async` pipe / `takeUntilDestroyed`
 *    pulls it back into change-detection (research §R3 — zoneless
 *    compatible).
 *
 * Lifecycle:
 *  - Construction is one-time at the root injector. The constructor
 *    reads `CONFEATURE_CONFIG` via `inject()` and constructs a fresh
 *    `ConfeatureClient` (NOT through `getClient(...)` because the
 *    factory's singleton table is per-process and would survive
 *    across Angular `TestBed` resets, causing flaky tests).
 *  - `close()` is idempotent (FR-016): sets a flag, completes every
 *    subject, disposes the client, removes the `configChanged`
 *    listener. Subsequent calls are no-ops.
 *
 * SDK key never logged (FR-025): the service never touches the
 * `sdkKey` value beyond passing it to `new ConfeatureClient(...)`.
 * Redaction in the runtime SDK's logger is inherited.
 */

import { inject, Injectable } from "@angular/core";
import {
  type ConfeatureClient as ConfeatureClientType,
  ConfeatureClient,
  type IConfigCatClientSnapshot,
  type IOptions,
  PollingMode,
  type User,
} from "@confeature/sdk-browser-js";
import { BehaviorSubject, from, type Observable } from "rxjs";
import { distinctUntilChanged, map } from "rxjs/operators";

import type { ConfeatureConfig, ConfeaturePollingMode } from "./config";
import { CONFEATURE_CONFIG } from "./internal/confeature-config.token";

/** Re-export the runtime SDK's snapshot interface under a friendlier name. */
export type ConfeatureSnapshot = IConfigCatClientSnapshot;

/**
 * Map the consumer-facing string union (matches @configcat/ng-client)
 * to the runtime SDK's numeric `PollingMode` enum.
 */
function mapPollingMode(mode: ConfeaturePollingMode | undefined): PollingMode {
  switch (mode) {
    case "lazyLoad":
      return PollingMode.LazyLoad;
    case "manualPoll":
      return PollingMode.ManualPoll;
    case "autoPoll":
    case undefined:
    default:
      return PollingMode.AutoPoll;
  }
}

/**
 * Build the runtime SDK's `IOptions` record from the Angular-flavoured
 * `ConfeatureConfig`. Only sets fields the user supplied — defaults
 * are handled inside `resolveOptions()` in the runtime SDK so we stay
 * byte-identical (research §R6).
 */
function toRuntimeOptions(config: ConfeatureConfig): IOptions {
  const opts: IOptions = {};
  if (config.baseUrl !== undefined) opts.baseUrl = config.baseUrl;
  if (config.logger !== undefined) opts.logger = config.logger;
  if (config.logLevel !== undefined) {
    // logLevel is exposed by the runtime SDK on the logger; the
    // Angular layer's `logLevel` field is purely a documentation /
    // parity hook (consumers configure the threshold inside their
    // custom logger). NOT forwarded to runtime options — the runtime
    // SDK has no top-level logLevel field; the level lives on the
    // logger instance.
  }
  if (config.flagOverrides !== undefined) opts.flagOverrides = config.flagOverrides;
  // pollIntervalSeconds + cacheRefreshIntervalSeconds: forward when set.
  if (config.pollIntervalSeconds !== undefined) {
    (opts as IOptions & { pollIntervalSeconds?: number }).pollIntervalSeconds =
      config.pollIntervalSeconds;
  }
  if (config.cacheRefreshIntervalSeconds !== undefined) {
    (opts as IOptions & { cacheRefreshIntervalSeconds?: number }).cacheRefreshIntervalSeconds =
      config.cacheRefreshIntervalSeconds;
  }
  return opts;
}

@Injectable({ providedIn: "root" })
export class ConfeatureService {
  private readonly client: ConfeatureClientType;
  private readonly subjects = new Map<string, BehaviorSubject<unknown>>();
  /**
   * Per-key resolution recipe — the args we used to seed the subject.
   * Used by the `configChanged` handler to re-evaluate every active
   * key against the new cache.
   */
  private readonly recipes = new Map<string, { defaultValue: unknown; user: User | undefined }>();
  private readonly configChangedHandler: () => void;
  private closed = false;

  constructor() {
    const config = inject(CONFEATURE_CONFIG);
    this.client = new ConfeatureClient(
      config.sdkKey,
      mapPollingMode(config.pollingMode),
      toRuntimeOptions(config),
    );
    this.configChangedHandler = (): void => {
      // Push the latest snapshot value into every active subject.
      // Errors inside one key MUST NOT prevent emission for the
      // others, so each iteration is wrapped in a try/catch.
      const snap = this.client.snapshot();
      for (const [key, subject] of this.subjects) {
        try {
          const recipe = this.recipes.get(key);
          if (!recipe) continue;
          const next = snap.getValue(key, recipe.defaultValue, recipe.user);
          subject.next(next);
        } catch (err) {
          // Logger inherits SDK-key redaction discipline (FR-025).
          // eslint-disable-next-line no-console
          console.warn("[ConfeatureService] error re-emitting key", key, err);
        }
      }
    };
    this.client.on("configChanged", this.configChangedHandler);
  }

  /**
   * Observable of the value cached for `key`. Emits the current value
   * immediately on subscribe (BehaviorSubject) and re-emits on every
   * underlying `configChanged` event (FR-015).
   *
   * Multiple subscribers to the same `key` share one BehaviorSubject —
   * no extra poll / no duplicate evaluation per subscriber (FR-014).
   */
  getValue<T>(key: string, defaultValue: T, user?: User): Observable<T> {
    if (this.closed) {
      return from([defaultValue]);
    }
    const existing = this.subjects.get(key);
    if (existing) {
      return existing.asObservable().pipe(
        map((v) => v as T),
        distinctUntilChanged(),
      );
    }
    // Seed synchronously from the current snapshot so the first
    // emission already carries the cached / override value.
    const seed = this.getValueSync(key, defaultValue, user);
    const subject = new BehaviorSubject<unknown>(seed);
    this.subjects.set(key, subject);
    this.recipes.set(key, { defaultValue, user });
    return subject.asObservable().pipe(
      map((v) => v as T),
      distinctUntilChanged(),
    );
  }

  /**
   * Synchronous read against the current snapshot. Safe to call outside
   * the Angular zone.
   */
  getValueSync<T>(key: string, defaultValue: T, user?: User): T {
    if (this.closed) return defaultValue;
    const snap = this.client.snapshot();
    return snap.getValue(key, defaultValue, user) as T;
  }

  /**
   * Triggers an immediate refresh. Returns an Observable that completes
   * when the refresh is done.
   */
  forceRefresh(): Observable<void> {
    return from(
      this.client.forceRefreshAsync().then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  /**
   * Idempotent shutdown. Completes every subject, disposes the
   * underlying client, removes the configChanged listener. Subsequent
   * calls are no-ops (FR-016).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.client.off("configChanged", this.configChangedHandler);
    } catch (err) {
      // Defensive — `off` is well-behaved but we never let close throw.
      // eslint-disable-next-line no-console
      console.warn("[ConfeatureService] error detaching configChanged", err);
    }
    for (const subject of this.subjects.values()) {
      try {
        subject.complete();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[ConfeatureService] error completing subject", err);
      }
    }
    this.subjects.clear();
    this.recipes.clear();
    try {
      this.client.dispose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ConfeatureService] error disposing client", err);
    }
  }

  /**
   * Returns the synchronous snapshot view of the underlying client.
   * Useful for ad-hoc batch reads (`snap.getValue('k', d)` for several
   * keys without rebuilding the Observable graph).
   */
  snapshot(): ConfeatureSnapshot {
    return this.client.snapshot();
  }

  /**
   * Internal escape hatch — exposes the underlying `ConfeatureClient`
   * to the thin-wrapper assertion test (FR-024). NOT part of the
   * public API; consumers should NOT call this method.
   *
   * @internal
   */
  _getInternalClient(): ConfeatureClientType {
    return this.client;
  }
}
