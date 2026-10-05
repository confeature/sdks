// SPDX-License-Identifier: MIT

import {
  ClientCacheState,
  deriveCacheKeySync,
  evaluateOverride,
  HttpConfigFetcher,
  type IConfigCatLogger,
  type IConfigFetcher,
  type IEvaluationDetails,
  isValidConfeatureKeyFormat,
  LoggerWrapper,
  NullLogger,
  OverrideBehaviour,
  ProjectConfig,
  RefreshResult,
  RolloutEvaluator,
  type SettingTypeOf,
  User,
} from "@confeature/sdk-shared";

import { BunFileConfigCache } from "./bun-file-cache.ts";
import { Hooks, type HookEvents, type IProvidesHooks } from "./hooks.ts";
import {
  type IAutoPollOptions,
  type ILazyLoadingOptions,
  type IOptions,
  PollingMode,
  resolveOptions,
  type ResolvedOptions,
} from "./options.ts";
import { ConfigPollService } from "./poll-service.ts";
import type { OptionsForPollingMode } from "./types.ts";
import { CONFEATURE_SDK_VERSION } from "./version.ts";

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
 * the type compiles unchanged.
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
 * `configcat-common`'s contract).
 */
const instances = new Map<string, WeakRef<ConfeatureClient>>();

/**
 * Public entry — drop-in equivalent of `configcat-common`'s
 * `getClient`. Defaults to AutoPoll. Returns a shared instance per
 * SDK key (subsequent calls with the same key return the same client).
 */
export function getClient<TMode extends PollingMode = typeof PollingMode.AutoPoll>(
  sdkKey: string,
  pollingMode?: TMode,
  options?: OptionsForPollingMode<TMode>,
): IConfigCatClient {
  return ConfeatureClient.getInstance(
    sdkKey,
    pollingMode ?? (PollingMode.AutoPoll as TMode),
    options as IOptions | undefined,
  );
}

/**
 * Dispose every active client. Matches `configcat-common`'s
 * `disposeAllClients`. Useful for tests + process-exit hooks.
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
 * inside a top-level try/catch — no exception ever escapes.
 *
 * Class renamed `ConfigCatClient` → `ConfeatureClient` per the brand
 * (Principle II framing — method signatures stay byte-identical to
 * configcat-js). A `ConfigCatClient` alias is exported for migrating
 * customers who already reference the type by name.
 */
export class ConfeatureClient implements IConfigCatClient {
  private readonly hooks = new Hooks();
  private readonly logger: LoggerWrapper;
  private readonly service: ConfigPollService;
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
  ): ConfeatureClient {
    const existing = instances.get(sdkKey)?.deref();
    if (existing && !existing.disposed) return existing;
    const client = new ConfeatureClient(sdkKey, pollingMode, options, /* internal */ true);
    instances.set(sdkKey, new WeakRef(client));
    return client;
  }

  /**
   * Customers can `new ConfeatureClient(sdkKey)` for parity, but the
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
      } catch (err) {
        this.logger.evalError("setupHooks", err);
      }
    }

    this.resolved = resolveOptions(
      options as IOptions & IAutoPollOptions & ILazyLoadingOptions,
      (m) => this.logger.configWarn(m),
    );
    this.defaultUser = this.resolved.defaultUser;

    if (!isValidConfeatureKeyFormat(sdkKey)) {
      this.logger.invalidSdkKey(sdkKey);
    }

    // Derive the on-disk cache filename synchronously so the cache
    // hydrates before the first `getValueAsync` runs (research §R13).
    const cacheKey = deriveCacheKeySync(sdkKey);
    const cache = new BunFileConfigCache(cacheKey, this.resolved.cacheKind, this.logger);

    const fetcher: IConfigFetcher = new HttpConfigFetcher(
      this.resolved.baseUrl,
      sdkKey,
      CONFEATURE_SDK_VERSION,
      this.logger,
      this.resolved.requestTimeoutMs,
    );
    this.evaluator = new RolloutEvaluator(this.logger);
    this.service = new ConfigPollService(
      sdkKey,
      fetcher,
      cache,
      this.resolved,
      pollingMode,
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
      // engine (targeting rules / segments / % options); the flat-map source
      // keeps its byte-identical value-only resolution. Both honour LocalOnly.
      const override = evaluateOverride(
        this.resolved.flagOverrides,
        key,
        defaultValue,
        user ?? this.defaultUser,
        this.evaluator,
      );
      if (override !== undefined) return override;
      this.service.ensureFresh();
      const cfg = this.service.getCurrent();
      return this.evaluator.evaluate(cfg, key, defaultValue, user ?? this.defaultUser).value;
    } catch (err) {
      this.logger.evalError(key, err);
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
      this.service.ensureFresh();
      const cfg = this.service.getCurrent();
      return this.evaluator.evaluate(cfg, key, defaultValue, user ?? this.defaultUser);
    } catch (err) {
      this.logger.evalError(key, err);
      return {
        key,
        value: defaultValue as SettingTypeOf<T>,
        isDefaultValue: true,
        errorMessage: "Unexpected evaluation error.",
        errorException: err,
      };
    }
  }

  async getAllKeysAsync(): Promise<string[]> {
    try {
      if (this.disposed) return [];
      this.service.ensureFresh();
      const cfg = this.service.getCurrent();
      return Object.keys(cfg.settings);
    } catch (err) {
      this.logger.evalError("getAllKeysAsync", err);
      return [];
    }
  }

  async getAllValuesAsync(user?: User): Promise<SettingKeyValue[]> {
    try {
      if (this.disposed) return [];
      this.service.ensureFresh();
      const cfg = this.service.getCurrent();
      const out: SettingKeyValue[] = [];
      for (const key of Object.keys(cfg.settings)) {
        // Default to `null` so non-boolean settings still surface a slot
        // with the configured default (`null` flags TYPE_MISMATCH for now).
        const value = this.evaluator.evaluate(cfg, key, null, user ?? this.defaultUser).value;
        out.push(new SettingKeyValue(key, value));
      }
      return out;
    } catch (err) {
      this.logger.evalError("getAllValuesAsync", err);
      return [];
    }
  }

  async getAllValueDetailsAsync(user?: User): Promise<IEvaluationDetails[]> {
    try {
      if (this.disposed) return [];
      this.service.ensureFresh();
      const cfg = this.service.getCurrent();
      const out: IEvaluationDetails[] = [];
      for (const key of Object.keys(cfg.settings)) {
        out.push(this.evaluator.evaluate(cfg, key, null, user ?? this.defaultUser));
      }
      return out;
    } catch (err) {
      this.logger.evalError("getAllValueDetailsAsync", err);
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
    } catch (err) {
      this.logger.evalError("getKeyAndValueAsync", err);
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
      // The error is dropped: it may quote the URL, which holds the key
      // (#803, FR-002). A key-free Error carries the fixed reason instead.
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
    } catch (err) {
      this.logger.evalError("waitForReady", err);
      return Promise.resolve(ClientCacheState.NoFlagData);
    }
  }

  // ---- Snapshot -------------------------------------------------------

  snapshot(): IConfigCatClientSnapshot {
    const cfg = this.service.getCurrent();
    // Capture by value so the snapshot remains a stable read-side view
    // of the client at the moment `snapshot()` was called (spec 036 §R8).
    const flagOverrides = this.resolved.flagOverrides;
    // Spec 076 / #271 D2: mirror `configcat-common`'s Snapshot.cacheState
    // logic — a `LocalOnly` flag-overrides client surfaces
    // `HasLocalOverrideFlagDataOnly`; otherwise the cache state reflects
    // whether a remote payload has been fetched.
    const isLocalOnly = flagOverrides?.behaviour === OverrideBehaviour.LocalOnly;
    const cacheState: ClientCacheState = isLocalOnly
      ? ClientCacheState.HasLocalOverrideFlagDataOnly
      : cfg.configJson === null
        ? ClientCacheState.NoFlagData
        : ClientCacheState.HasUpToDateFlagData;
    const evaluator = this.evaluator;
    const defaultUser = this.defaultUser;
    return {
      cacheState,
      fetchedConfig: cfg,
      getAllKeys: () => Object.keys(cfg.settings),
      getValue<T>(key: string, defaultValue: T, user?: User): SettingTypeOf<T> {
        // Spec 036: snapshot now honours `flagOverrides` synchronously.
        // Spec 135: route full-config sources through the engine (rules);
        // flat-map sources keep value-only resolution. Both honour LocalOnly.
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
    } catch (err) {
      this.logger.evalError("dispose", err);
    }
    this.hooks.clear();
    // Remove from singleton table — if a future getClient(sdkKey) is
    // made, a fresh instance will be constructed.
    const ref = instances.get(this.sdkKey);
    if (ref?.deref() === this) instances.delete(this.sdkKey);
  }
}

/**
 * Migrating-customer alias — code that previously imported
 * `ConfigCatClient` keeps compiling under the Confeature namespace.
 */
export { ConfeatureClient as ConfigCatClient };
