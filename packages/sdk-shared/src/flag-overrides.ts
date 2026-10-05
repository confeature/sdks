// SPDX-License-Identifier: MIT

import { type IConfig, type ISetting, type ISettingValue, SettingType } from "./config-json.ts";

/**
 * How `FlagOverrides` interacts with the remote config — mirrors
 * `configcat-common`'s `OverrideBehaviour`. Accepted in `IOptions`,
 * never consumed by the v1 evaluator (eval always reads the remote
 * payload).
 */
export const OverrideBehaviour = {
  LocalOnly: 0,
  LocalOverRemote: 1,
  RemoteOverLocal: 2,
} as const;
export type OverrideBehaviour = (typeof OverrideBehaviour)[keyof typeof OverrideBehaviour];

/**
 * Read interface for a flag-override data source. Matches
 * `configcat-common`'s `IOverrideDataSource` — which is `{ name: Setting }`-
 * typed, NOT a flat value map (research §R2). An `ISetting` carries the
 * value envelope (`v`) **plus** targeting rules (`r`) / percentage options
 * (`p`), so a single override-source contract serves both the value-only
 * map source and the rule-bearing full-config source.
 *
 * The value-only special case (a `MapOverrideDataSource` / the query-param
 * source) emits a trivial `ISetting` (`{ t, v, i: "", r: [] }`) per value
 * — flat-path resolution stays byte-identical because `evaluateOverrideSync`
 * still reads the value envelope, just one `.v` deeper (FR-004 / INV-2).
 */
export interface IOverrideDataSource {
  /** Returns the override settings, possibly async (matches configcat-common). */
  getOverrides(): Promise<Record<string, ISetting>>;

  /**
   * Returns the override settings synchronously when available, OR `null`
   * when no synchronous view exists.
   *
   * OPTIONAL: customer-supplied implementations without this method
   * keep working — `evaluateOverrideSync` falls through (the snapshot
   * path returns the default value; `getValueAsync` uses the async
   * `getOverrides()`).
   *
   * Added by spec 036 to enable synchronous `snapshot()` + overrides.
   */
  getOverridesSync?(): Record<string, ISetting> | null;
}

/**
 * Wrap a value-only envelope as a trivial (rule-less) `ISetting` so a flat
 * value map satisfies the rule-capable {@link IOverrideDataSource} contract
 * (research §R2 / §R5; mirrors common-js `Setting.fromValue`). The `t`
 * discriminator is recovered from which envelope key is present — the same
 * `b`/`s`/`i`/`d` → `Boolean`/`String`/`Int`/`Double` mapping the rest of the
 * engine uses. `i` (variation id) is `""` and `r` (rules) is empty, exactly
 * as ConfigCat's map source builds them.
 */
export function settingFromValue(value: ISettingValue): ISetting {
  let t: SettingType;
  if (value.b !== undefined) t = SettingType.Boolean;
  else if (value.s !== undefined) t = SettingType.String;
  else if (value.i !== undefined) t = SettingType.Int;
  else if (value.d !== undefined) t = SettingType.Double;
  // An empty envelope (`{}`) has no type; default to Boolean — the value
  // selection downstream still yields `undefined`, so the LocalOnly contract
  // returns the default either way (override-eval branch 5 / 6).
  else t = SettingType.Boolean;
  return { t, v: value, i: "", r: [] };
}

/**
 * In-memory override source built from a plain JS object of value
 * envelopes. The values are already resident in memory at construction
 * time; both accessors wrap each value as a trivial value-only `ISetting`
 * (research §R2) so the source satisfies the widened, rule-capable
 * {@link IOverrideDataSource}. Flat-path resolution is unchanged — the
 * stored value envelopes are not mutated, only wrapped on read.
 */
export class MapOverrideDataSource implements IOverrideDataSource {
  constructor(private readonly map: Record<string, ISettingValue>) {}
  getOverrides(): Promise<Record<string, ISetting>> {
    return Promise.resolve(this.getOverridesSync());
  }
  /**
   * Synchronous variant — wraps each stored value envelope as a value-only
   * `ISetting` (spec 036 §R2; widened by spec 135 to the rule-capable
   * contract).
   */
  getOverridesSync(): Record<string, ISetting> {
    const settings: Record<string, ISetting> = {};
    for (const [key, value] of Object.entries(this.map)) {
      settings[key] = settingFromValue(value);
    }
    return settings;
  }
}

/**
 * Full-config override source (spec 135 — additive, Principle II). Holds a
 * complete parsed `config_v6` blob (`IConfig` = `{ p, f, s }`) and exposes
 * its `f` settings — **rules / segments / percentage options intact** —
 * through the same {@link IOverrideDataSource} contract the map source uses.
 * Mirrors how ConfigCat's file source feeds rule-bearing Settings to the
 * evaluator (research §R2 / §R3).
 *
 * The whole `IConfig` is retained (not just `f`) so the full-config eval
 * path can reconstruct a `ProjectConfig` carrying the salt (`p.s`) and
 * segments (`s`) — never just `f` (INV-4; the spec-129 dropped-salt lesson).
 */
export class ConfigOverrideDataSource implements IOverrideDataSource {
  constructor(readonly config: IConfig) {}
  getOverrides(): Promise<Record<string, ISetting>> {
    return Promise.resolve(this.config.f);
  }
  getOverridesSync(): Record<string, ISetting> {
    return this.config.f;
  }
}

/**
 * Bundle of override source + behaviour. Stored on `IOptions.flagOverrides`.
 * The constructor is intentionally permissive — anything implementing
 * `getOverrides` will fit.
 */
export class FlagOverrides {
  constructor(
    public readonly dataSource: IOverrideDataSource,
    public readonly behaviour: OverrideBehaviour,
  ) {}
}

/**
 * Convenience factory that wraps a plain object in
 * `MapOverrideDataSource` + `FlagOverrides`. Matches configcat-common's
 * `createFlagOverridesFromMap`.
 *
 * @param watchChanges accepted for signature compat; ignored in v1.
 */
export function createFlagOverridesFromMap(
  map: Record<string, boolean | string | number>,
  behaviour: OverrideBehaviour,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  watchChanges?: boolean,
): FlagOverrides {
  const settingValues: Record<string, ISettingValue> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "boolean") settingValues[key] = { b: value };
    else if (typeof value === "string") settingValues[key] = { s: value };
    else if (typeof value === "number") {
      // configcat-common uses `i` for ints and `d` for doubles; we pick
      // `d` for any number — matches configcat-js's behaviour.
      settingValues[key] = { d: value };
    }
  }
  return new FlagOverrides(new MapOverrideDataSource(settingValues), behaviour);
}

/**
 * Build a `FlagOverrides` from a complete, rule-bearing `config_v6` blob
 * evaluated offline through the real `RolloutEvaluator` (spec 135 — additive,
 * Principle II). This is the runtime-agnostic, in-memory equivalent of
 * ConfigCat's file-based full-config override: ConfigCat's only full-config
 * entry point is the (Node/Deno-only) file source, so this in-memory factory
 * is a justified additive extension — the underlying shape (a full-`Setting`
 * `IOverrideDataSource`) is byte-faithful to ConfigCat's internal architecture
 * (research §R2 / §R3). Works on every runtime, including browser / edge,
 * where the corpus and a file source cannot.
 *
 * With `OverrideBehaviour.LocalOnly`, `getValue(key, default, user)` resolves
 * targeting rules, segments, prerequisites and percentage options purely from
 * the supplied config — no network fetch.
 *
 * @param watchChanges accepted for signature compat; ignored (the config is
 *   already resident in memory).
 */
export function createFlagOverridesFromConfig(
  config: IConfig,
  behaviour: OverrideBehaviour,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  watchChanges?: boolean,
): FlagOverrides {
  return new FlagOverrides(new ConfigOverrideDataSource(config), behaviour);
}
