// SPDX-License-Identifier: MIT

import { AutoPollConfigService } from "./auto-poll-service.ts";
import { HttpConfigFetcher, type IConfigFetcher } from "./config-fetcher.ts";
import {
  ClientCacheState,
  evaluateOverride,
  evaluateOverrideDetails,
  LoggerWrapper,
  NullLogger,
  OverrideBehaviour,
  ProjectConfig,
  RefreshResult,
  RolloutEvaluator,
  User,
  isValidConfeatureKeyFormat,
  type IConfigCatLogger,
  type IEvaluationDetails,
  type SettingTypeOf,
} from "@confeature/sdk-shared";
import { Hooks, type HookEvents, type IProvidesHooks } from "./hooks.ts";
import {
  type IAutoPollOptions,
  type IOptions,
  PollingMode,
  resolveOptions,
  type ResolvedOptions,
} from "./options.ts";
import type { OptionsForPollingMode } from "./types.ts";
/**
 * Sync snapshot of the client at a point in time. Mirrors
 * `configcat-common`'s `IConfigCatClientSnapshot`.
 */
export interface IConfigCatClientSnapshot {
  cacheState: ClientCacheState;
  fetchedConfig: ProjectConfig;
  getAllKeys(): string[];
  getValue<T>(key: string, defaultValue: T, user?: User): SettingTypeOf<T>;
  getValueDetails<T>(
    key: string,
    defaultValue: T,
    user?: User,
  ): IEvaluationDetails<SettingTypeOf<T>>;
}

/**
 * Settings key/value tuple — matches `configcat-common`'s `SettingKeyValue`.
 */
export class SettingKeyValue<T = unknown> {
  constructor(
    public readonly settingKey: string,
    public readonly settingValue: T,
  ) {}
}

/**
 * Full client interface — every method in `configcat-common`'s
 * `IConfigCatClient` reproduced verbatim. Customer code that depends on
 * the type compiles unchanged under `@confeature/sdk-node`.
 */
export interface IConfigCatClient extends IProvidesHooks {
  getValueAsync<T>(key: string, defaultValue: T, user?: User): Promise<SettingTypeOf<T>>;
  getValueDetailsAsync<T>(
    key: string,
    defaultValue: T,
    user?: User,
  ): Promise<IEvaluationDetails<SettingTypeOf<T>>>;
  getAllKeysAsync(): Promise<string[]>;
  getAllValuesAsync(user?: User): Promise<SettingKeyValue[]>;
  getAllValueDetailsAsync(user?: User): Promise<IEvaluationDetails[]>;
  getKeyAndValueAsync(variationId: string): Promise<SettingKeyValue | null>;
  forceRefreshAsync(): Promise<RefreshResult>;
  waitForReady(): Promise<ClientCacheState>;
  snapshot(): IConfigCatClientSnapshot;
  setDefaultUser(user: User): void;
  clearDefaultUser(): void;
  readonly isOffline: boolean;
  setOnline(): void;
  setOffline(): void;
  dispose(): void;
}

/**
 * Per-process singleton table — calling `getClient(sdkKey, ...)` twice
 * with the same key returns the same instance (matches
 * `configcat-common`'s contract). `WeakRef` lets disposed clients fall
 * out of the table without us tracking listeners.
 */
const instances = new Map<string, WeakRef<ConfigCatClient>>();

/**
 * Public entry — drop-in equivalent of `configcat-common`'s
 * `getClient`. The polling mode is accepted for signature parity; v1
 * routes LazyLoad / ManualPoll to AutoPoll internally (logged at
 * construction).
 */
export function getClient<TMode extends PollingMode = typeof PollingMode.AutoPoll>(
  sdkKey: string,
  pollingMode?: TMode,
  options?: OptionsForPollingMode<TMode>,
): IConfigCatClient {
  return ConfigCatClient.getInstance(
    sdkKey,
    pollingMode ?? (PollingMode.AutoPoll as TMode),
    options as IOptions | undefined,
  );
}

/**
 * Dispose every active client. Matches `configcat-common`'s
 * `disposeAllClients`. Useful for tests + process-shutdown hooks.
 */
export function disposeAllClients(): void {
  for (const ref of instances.values()) {
    const client = ref.deref();
    if (client) {
      try {
        client.dispose();
      } catch {
        /* swallow — dispose must not throw */
      }
    }
  }
  instances.clear();
}

/**
 * Concrete client implementation. Every public async method body lives
 * inside a top-level try/catch — no exception ever escapes (FR-009).
 *
 * No caught error is ever forwarded, either: those catches hand the logger
 * (and so the `clientError` hook) a fixed message and nothing else. None of
 * them can receive an error quoting the keyed config URL today — they guard
 * cache reads, pure evaluation and local lifecycle calls — but each sits one
 * refactor away from it (ConfigCat's LazyLoad awaits the fetch on the
 * evaluation path), and the SDK key must reach no log line and no hook
 * payload (#841; #803 made the refresh path key-free the same way).
 */
export class ConfigCatClient implements IConfigCatClient {
  private readonly hooks = new Hooks();
  private readonly logger: LoggerWrapper;
  private readonly service: AutoPollConfigService;
  private readonly evaluator: RolloutEvaluator;
  private readonly resolved: ResolvedOptions;
  private defaultUser: User | undefined;
  private disposed = false;

  /**
   * Returns the shared instance for `sdkKey`, creating one on first
   * call. Mirrors `configcat-common`'s singleton-per-key behaviour.
   */
  static getInstance(
    sdkKey: string,
    pollingMode: PollingMode,
    options?: IOptions,
  ): ConfigCatClient {
    const existing = instances.get(sdkKey)?.deref();
    if (existing && !existing.disposed) return existing;
    const client = new ConfigCatClient(sdkKey, pollingMode, options, /* internal */ true);
    instances.set(sdkKey, new WeakRef(client));
    return client;
  }

  /**
   * Customers can `new ConfigCatClient(sdkKey)` for parity, but the
   * canonical entry is `getClient(...)`. The optional `_internal` flag
   * is used by `getInstance` to skip re-registering in the table.
   */
  constructor(
    private readonly sdkKey: string,
    pollingMode: PollingMode = PollingMode.AutoPoll,
    options?: IOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _internal = false,
  ) {
    const rawLogger: IConfigCatLogger = options?.logger ?? new NullLogger();
    this.logger = new LoggerWrapper(rawLogger, (msg, ex) =>
      this.hooks.emit("clientError", msg, ex),
    );

    // setupHooks is documented to run synchronously before initial
    // fetch — fire it now, before we spin up the service.
    if (options?.setupHooks) {
      try {
        options.setupHooks(this.hooks);
      } catch {
        // The caught error is dropped, never forwarded: see the class doc (#841).
        this.logger.evalError("setupHooks");
      }
    }

    this.resolved = resolveOptions(options as IOptions & IAutoPollOptions, (m) =>
      this.logger.configWarn(m),
    );
    this.defaultUser = this.resolved.defaultUser;

    if (!isValidConfeatureKeyFormat(sdkKey)) {
      this.logger.invalidSdkKey(sdkKey);
    }

    if (pollingMode !== PollingMode.AutoPoll) {
      const name = pollingMode === PollingMode.LazyLoad ? "LazyLoad" : "ManualPoll";
      this.logger.configWarn(
        `PollingMode.${name} is accepted but routed to AutoPoll in v1. See README.`,
      );
    }

    const fetcher: IConfigFetcher = new HttpConfigFetcher(this.resolved.baseUrl, this.logger);
    this.evaluator = new RolloutEvaluator(this.logger);
    this.service = new AutoPollConfigService(
      sdkKey,
      fetcher,
      this.resolved,
      this.logger,
      this.hooks,
    );
  }

  // ---- Hooks ----------------------------------------------------------

  on<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    this.hooks.on(event, listener);
    return this;
  }
  once<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    this.hooks.once(event, listener);
    return this;
  }
  off<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    this.hooks.off(event, listener);
    return this;
  }

  // ---- Eval -----------------------------------------------------------

  async getValueAsync<T>(key: string, defaultValue: T, user?: User): Promise<SettingTypeOf<T>> {
    try {
      if (this.disposed) return defaultValue as SettingTypeOf<T>;
      // Spec 135: a full-config override source resolves through the real
      // engine offline (targeting rules / segments / % options). The map
      // source keeps value-only resolution. Both honour the LocalOnly
      // no-fall-through contract; `undefined` means no override applies.
      const override = evaluateOverride(
        this.resolved.flagOverrides,
        key,
        defaultValue,
        user ?? this.defaultUser,
        this.evaluator,
      );
      if (override !== undefined) return override;
      const cfg = this.service.getCurrent();
      return this.evaluator.evaluate(cfg, key, defaultValue, user ?? this.defaultUser).value;
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError(key);
      return defaultValue as SettingTypeOf<T>;
    }
  }

  async getValueDetailsAsync<T>(
    key: string,
    defaultValue: T,
    user?: User,
  ): Promise<IEvaluationDetails<SettingTypeOf<T>>> {
    try {
      if (this.disposed) {
        return {
          key,
          value: defaultValue as SettingTypeOf<T>,
          isDefaultValue: true,
          errorMessage: "Client is disposed.",
        };
      }
      // Spec 135 / #395: a full-config override source resolves through the
      // real engine offline so the returned details carry `variationId`
      // (+ matchedTargetingRule / matchedPercentageOption); map sources keep
      // value-only resolution wrapped as details. Both honour the LocalOnly
      // no-fall-through contract; `undefined` means no override applies.
      const overrideDetails = evaluateOverrideDetails(
        this.resolved.flagOverrides,
        key,
        defaultValue,
        user ?? this.defaultUser,
        this.evaluator,
      );
      if (overrideDetails !== undefined) return overrideDetails;
      const cfg = this.service.getCurrent();
      return this.evaluator.evaluate(cfg, key, defaultValue, user ?? this.defaultUser);
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError(key);
      return {
        key,
        value: defaultValue as SettingTypeOf<T>,
        isDefaultValue: true,
        errorMessage: "Unexpected evaluation error.",
        // ConfigCat's shape keeps an errorException: a new key-free Error.
        errorException: new Error("Unexpected evaluation error."),
      };
    }
  }

  async getAllKeysAsync(): Promise<string[]> {
    try {
      if (this.disposed) return [];
      const cfg = this.service.getCurrent();
      return Object.keys(cfg.settings);
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("getAllKeysAsync");
      return [];
    }
  }

  async getAllValuesAsync(user?: User): Promise<SettingKeyValue[]> {
    try {
      if (this.disposed) return [];
      const cfg = this.service.getCurrent();
      const out: SettingKeyValue[] = [];
      for (const key of Object.keys(cfg.settings)) {
        // Default to `null` so non-boolean settings still surface a slot
        // with the configured default (`null` flags TYPE_MISMATCH for now).
        const value = this.evaluator.evaluate(cfg, key, null, user ?? this.defaultUser).value;
        out.push(new SettingKeyValue(key, value));
      }
      return out;
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("getAllValuesAsync");
      return [];
    }
  }

  async getAllValueDetailsAsync(user?: User): Promise<IEvaluationDetails[]> {
    try {
      if (this.disposed) return [];
      const cfg = this.service.getCurrent();
      const out: IEvaluationDetails[] = [];
      for (const key of Object.keys(cfg.settings)) {
        out.push(this.evaluator.evaluate(cfg, key, null, user ?? this.defaultUser));
      }
      return out;
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("getAllValueDetailsAsync");
      return [];
    }
  }

  async getKeyAndValueAsync(variationId: string): Promise<SettingKeyValue | null> {
    try {
      if (this.disposed) return null;
      const cfg = this.service.getCurrent();
      for (const [key, setting] of Object.entries(cfg.settings)) {
        if (setting.i === variationId && typeof setting.v?.b === "boolean") {
          return new SettingKeyValue(key, setting.v.b);
        }
      }
      return null;
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("getKeyAndValueAsync");
      return null;
    }
  }

  async forceRefreshAsync(): Promise<RefreshResult> {
    try {
      if (this.disposed) {
        return RefreshResult.failure("Client is disposed.");
      }
      return await this.service.forceRefreshAsync();
    } catch {
      // The caught error is dropped: it may quote the request URL, which
      // holds the SDK key (#803, FR-002). As on the poll path, a key-free
      // Error carrying the fixed text keeps ConfigCat's shape (an
      // errorException is present) without a library message.
      const message = "Unexpected refresh error.";
      this.logger.fetchFailed(this.sdkKey, "refresh-throw");
      return RefreshResult.failure(message, new Error(message));
    }
  }

  waitForReady(): Promise<ClientCacheState> {
    try {
      // A `LocalOnly` flag-overrides client is "ready" with local data
      // immediately — mirrors `configcat-common`'s `ConfigCatClient.waitForReady`
      // (returns `HasLocalOverrideFlagDataOnly` when no config service ran).
      if (this.resolved.flagOverrides?.behaviour === OverrideBehaviour.LocalOnly) {
        return Promise.resolve(ClientCacheState.HasLocalOverrideFlagDataOnly);
      }
      return this.service.waitForReady();
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("waitForReady");
      return Promise.resolve(ClientCacheState.NoFlagData);
    }
  }

  // ---- Snapshot -------------------------------------------------------

  snapshot(): IConfigCatClientSnapshot {
    const cfg = this.service.getCurrent();
    // Spec 076 / #271 D2: mirror `configcat-common`'s Snapshot.cacheState
    // logic — a `LocalOnly` flag-overrides client surfaces
    // `HasLocalOverrideFlagDataOnly`; otherwise the cache state reflects
    // whether a remote payload has been fetched.
    const isLocalOnly = this.resolved.flagOverrides?.behaviour === OverrideBehaviour.LocalOnly;
    const cacheState: ClientCacheState = isLocalOnly
      ? ClientCacheState.HasLocalOverrideFlagDataOnly
      : cfg.configJson === null
        ? ClientCacheState.NoFlagData
        : ClientCacheState.HasUpToDateFlagData;
    const evaluator = this.evaluator;
    const defaultUser = this.defaultUser;
    const flagOverrides = this.resolved.flagOverrides;
    return {
      cacheState,
      fetchedConfig: cfg,
      getAllKeys: () => Object.keys(cfg.settings),
      getValue<T>(key: string, defaultValue: T, user?: User): SettingTypeOf<T> {
        // Spec 135: full-config override sources resolve through the engine
        // (rules); map sources keep value-only resolution. Both honour
        // LocalOnly; `undefined` means no override applies.
        const override = evaluateOverride(
          flagOverrides,
          key,
          defaultValue,
          user ?? defaultUser,
          evaluator,
        );
        if (override !== undefined) return override;
        return evaluator.evaluate(cfg, key, defaultValue, user ?? defaultUser).value;
      },
      getValueDetails<T>(
        key: string,
        defaultValue: T,
        user?: User,
      ): IEvaluationDetails<SettingTypeOf<T>> {
        // Spec 135 / #395: full-config override sources resolve through the
        // engine so the details carry variationId; map sources wrap the
        // value-only override. `undefined` means no override applies.
        const overrideDetails = evaluateOverrideDetails(
          flagOverrides,
          key,
          defaultValue,
          user ?? defaultUser,
          evaluator,
        );
        if (overrideDetails !== undefined) return overrideDetails;
        return evaluator.evaluate(cfg, key, defaultValue, user ?? defaultUser);
      },
    };
  }

  // ---- Default user ---------------------------------------------------

  setDefaultUser(user: User): void {
    this.defaultUser = user;
  }
  clearDefaultUser(): void {
    this.defaultUser = undefined;
  }

  // ---- Online / offline ----------------------------------------------

  get isOffline(): boolean {
    return this.service.isOffline();
  }
  setOnline(): void {
    this.service.setOffline(false);
  }
  setOffline(): void {
    this.service.setOffline(true);
  }

  // ---- Lifecycle ------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.service.dispose();
    } catch {
      // The caught error is dropped, never forwarded: see the class doc (#841).
      this.logger.evalError("dispose");
    }
    this.hooks.clear();
    // Remove from singleton table — if a future getClient(sdkKey) is
    // made, a fresh instance will be constructed.
    const ref = instances.get(this.sdkKey);
    if (ref?.deref() === this) instances.delete(this.sdkKey);
  }
}
