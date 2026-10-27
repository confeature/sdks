// SPDX-License-Identifier: MIT

/**
 * Synchronous override evaluation, shared by every WHATWG-fetch SDK
 * (`sdk-browser-js`, `sdk-bun`, `sdk-deno`).
 *
 * Returns:
 *   - the typed override value when overrides + LocalOnly + key match;
 *   - the supplied `defaultValue` on TYPE_MISMATCH / missing key / null
 *     override value (LocalOnly contract: don't fall through to the cache);
 *   - `undefined` when overrides are absent, behaviour is non-LocalOnly,
 *     or no synchronous data source is available (caller falls through
 *     to the normal cache-driven eval).
 *
 * Used from two call sites per SDK:
 *   - `getValueAsync` — synchronous now (previously awaited the async
 *     `getOverrides()`; the production `MapOverrideDataSource` returns the
 *     map directly, so async was incidental).
 *   - `snapshot().getValue` — NEW path: snapshot now honours overrides
 *     synchronously. Pre-spec-036 the snapshot returned the cached/default
 *     value and ignored `flagOverrides` entirely.
 *
 * NOT used for `OverrideBehaviour.LocalOverRemote` / `RemoteOverLocal` —
 * those behaviours remain stubbed (spec 031 §R8).
 *
 * The helper is intentionally pure: no logger access, no SDK-key access,
 * no I/O. Pure data in → typed override or undefined out.
 *
 * Spec 036's research (§R4) records the branch decision tree.
 */

import type { IEvaluationDetails, RolloutEvaluator, SettingTypeOf } from "./evaluator.ts";
import {
  ConfigOverrideDataSource,
  type FlagOverrides,
  OverrideBehaviour,
} from "./flag-overrides.ts";
import { ownValue } from "./own-key.ts";
import { ProjectConfig } from "./project-config.ts";
import type { User } from "./user.ts";

export function evaluateOverrideSync<T>(
  flagOverrides: FlagOverrides | undefined,
  key: string,
  defaultValue: T,
): SettingTypeOf<T> | undefined {
  // Branch 1: no overrides configured → caller falls through.
  if (!flagOverrides) return undefined;

  // Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
  if (flagOverrides.behaviour !== OverrideBehaviour.LocalOnly) return undefined;

  // Branch 3: no synchronous data source available → fall through. This
  // handles customer impls that didn't implement the optional sync method.
  // Call through the data source (never a detached reference) so a method
  // relying on `this` keeps its binding.
  const { dataSource } = flagOverrides;
  if (typeof dataSource.getOverridesSync !== "function") return undefined;
  const map = dataSource.getOverridesSync();
  if (map === null) return undefined;

  // From here we are committed to the LocalOnly contract: NEVER fall
  // through to the cache — return either the typed override or the
  // supplied default.

  // Branch 4: key absent → return default (don't consult the cache).
  const setting = ownValue(map, key);
  if (setting === undefined) return defaultValue as SettingTypeOf<T>;

  // Branch 5: override slot empty → return default.
  // The override is a value-only `ISetting`; its `v` envelope is
  // `{ b?: boolean; s?: string; i?: number; d?: number }`. (Spec 135 widened
  // the source contract to `ISetting`; the map / query-param sources wrap each
  // value as a trivial value-only setting, so resolution is byte-identical —
  // it just reads one `.v` deeper.)
  const raw = setting.v;
  const candidate = raw.b ?? raw.s ?? raw.i ?? raw.d;
  if (candidate === undefined) return defaultValue as SettingTypeOf<T>;

  // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
  // `null` defaultValue intentionally bypasses the check (matches
  // configcat-js semantics).
  if (defaultValue !== null && typeof candidate !== typeof defaultValue) {
    return defaultValue as SettingTypeOf<T>;
  }

  // Branch 7: happy path — typed override value.
  return candidate as SettingTypeOf<T>;
}

/**
 * Full-config override resolution (spec 135 §R5). When the override source is
 * a {@link ConfigOverrideDataSource}, resolve `key` through the real
 * `RolloutEvaluator` so targeting rules / segments / prerequisites /
 * percentage options apply offline — the rule-bearing sibling of
 * {@link evaluateOverrideSync}'s flat lookup.
 *
 * Returns:
 *   - the rule-resolved typed value, when overrides + LocalOnly + a
 *     `ConfigOverrideDataSource` apply (LocalOnly: never fall through to the
 *     cache — the evaluator already returns `defaultValue` for any non-clean
 *     resolution, so this preserves the contract);
 *   - `undefined` when overrides are absent, behaviour is non-LocalOnly, or
 *     the source is NOT a full-config source (caller falls through to the
 *     flat-map helper / normal eval).
 *
 * INV-4: the evaluator receives a `ProjectConfig` reconstructed from the FULL
 * `IConfig` (`{ p, f, s }`) — salt (`p.s`) + segments (`s`), never just `f`
 * (the spec-129 dropped-salt regression class).
 */
export function evaluateFullConfigOverrideSync<T>(
  flagOverrides: FlagOverrides | undefined,
  key: string,
  defaultValue: T,
  user: User | undefined,
  evaluator: RolloutEvaluator,
): SettingTypeOf<T> | undefined {
  if (!flagOverrides) return undefined;
  if (flagOverrides.behaviour !== OverrideBehaviour.LocalOnly) return undefined;

  const { dataSource } = flagOverrides;
  if (!(dataSource instanceof ConfigOverrideDataSource)) return undefined;

  // Reconstruct a ProjectConfig from the FULL IConfig (salt + segments + f),
  // never just `f` (INV-4). fetchTime is irrelevant to value resolution.
  const projectConfig = new ProjectConfig(dataSource.config, null, Date.now());
  return evaluator.evaluate(projectConfig, key, defaultValue, user).value;
}

/**
 * Details-returning sibling of {@link evaluateFullConfigOverrideSync} (#395 /
 * #150 variationId parity). Resolves `key` through the real
 * {@link RolloutEvaluator} against the full-config override and returns the
 * COMPLETE {@link IEvaluationDetails} — value + `variationId` +
 * `matchedTargetingRule` + `matchedPercentageOption` — so `getValueDetails`
 * through an override carries the resolved option's variationId (the seam the
 * full-config corpus surfaced as `undefined`).
 *
 * Returns `undefined` when overrides are absent, behaviour is non-LocalOnly, or
 * the source is NOT a full-config source (caller falls through). INV-4: the
 * evaluator receives a ProjectConfig reconstructed from the FULL `IConfig`
 * (`{ p, f, s }`), same as the value path.
 */
export function evaluateFullConfigOverrideDetailsSync<T>(
  flagOverrides: FlagOverrides | undefined,
  key: string,
  defaultValue: T,
  user: User | undefined,
  evaluator: RolloutEvaluator,
): IEvaluationDetails<SettingTypeOf<T>> | undefined {
  if (!flagOverrides) return undefined;
  if (flagOverrides.behaviour !== OverrideBehaviour.LocalOnly) return undefined;

  const { dataSource } = flagOverrides;
  if (!(dataSource instanceof ConfigOverrideDataSource)) return undefined;

  const projectConfig = new ProjectConfig(dataSource.config, null, Date.now());
  return evaluator.evaluate(projectConfig, key, defaultValue, user);
}

/**
 * Shared override router (spec 135 §R5 / T011). Dispatches between the flat
 * map path and the full-config path so per-SDK call sites change minimally:
 * a `ConfigOverrideDataSource` source routes through the real evaluator; every
 * other source (map / query-param / custom) keeps the existing byte-identical
 * flat-map resolution.
 *
 * Returns the resolved override value, or `undefined` when no override applies
 * (the caller then falls through to the normal cache-driven eval). Preserves
 * the LocalOnly no-fall-through contract on both paths.
 *
 * The `evaluator` is only consulted on the full-config path; callers on the
 * flat path may still use {@link evaluateOverrideSync} directly if they have no
 * evaluator at the call site.
 */
export function evaluateOverride<T>(
  flagOverrides: FlagOverrides | undefined,
  key: string,
  defaultValue: T,
  user: User | undefined,
  evaluator: RolloutEvaluator,
): SettingTypeOf<T> | undefined {
  // Full-config source → ALWAYS resolve through the evaluator; NEVER fall
  // through to the flat-map path (which would mis-read rule-bearing settings
  // as value-only — INV-3 in spirit). Dispatch on the source type, not on the
  // resolved value, so a full-config source whose evaluator returns the
  // default (`undefined` default value, etc.) still stays on the rule path.
  if (
    flagOverrides &&
    flagOverrides.behaviour === OverrideBehaviour.LocalOnly &&
    flagOverrides.dataSource instanceof ConfigOverrideDataSource
  ) {
    return evaluateFullConfigOverrideSync(flagOverrides, key, defaultValue, user, evaluator);
  }
  // Every other source (map / query-param / custom) keeps the byte-identical
  // flat-map resolution.
  return evaluateOverrideSync(flagOverrides, key, defaultValue);
}

/**
 * Details-returning sibling of {@link evaluateOverride} (#395 / #150). Mirrors
 * the value-only router's dispatch, but returns the FULL
 * {@link IEvaluationDetails} (value + variationId + matchedTargetingRule +
 * matchedPercentageOption) so `getValueDetails` through an override carries the
 * resolved option's variationId.
 *
 * Returns `undefined` when no override applies (the caller falls through to the
 * normal cache-driven `getValueDetails`).
 *
 * Full-config source → resolve through the real evaluator
 * ({@link evaluateFullConfigOverrideDetailsSync}). Flat-map / query-param /
 * custom source → resolve the value via {@link evaluateOverrideSync}, then wrap
 * it as details, carrying `variationId` from the override setting's `i` slot
 * when present (mirrors how a non-override getValueDetails builds its
 * EvaluationDetails). The flat-map override is value-only, so it has no matched
 * rule / option.
 */
export function evaluateOverrideDetails<T>(
  flagOverrides: FlagOverrides | undefined,
  key: string,
  defaultValue: T,
  user: User | undefined,
  evaluator: RolloutEvaluator,
): IEvaluationDetails<SettingTypeOf<T>> | undefined {
  // Full-config source → ALWAYS resolve through the evaluator (rule path).
  if (
    flagOverrides &&
    flagOverrides.behaviour === OverrideBehaviour.LocalOnly &&
    flagOverrides.dataSource instanceof ConfigOverrideDataSource
  ) {
    return evaluateFullConfigOverrideDetailsSync(flagOverrides, key, defaultValue, user, evaluator);
  }

  // Flat-map / query-param / custom source → value-only resolution.
  const value = evaluateOverrideSync(flagOverrides, key, defaultValue);
  if (value === undefined) return undefined;

  // Carry the override setting's variationId (`i`) when the source exposes one
  // synchronously; value-only overrides have no matched rule / option.
  let variationId: string | undefined;
  const dataSource = flagOverrides?.dataSource;
  if (dataSource && typeof dataSource.getOverridesSync === "function") {
    const map = dataSource.getOverridesSync();
    variationId = ownValue(map, key)?.i;
  }

  // `isDefaultValue` is false: an override DID resolve to a concrete value
  // (LocalOnly returns the override value or the supplied default; either way
  // it's the contract-resolved value, not an eval error fallback).
  return {
    key,
    value,
    variationId,
    isDefaultValue: false,
    user,
  };
}
