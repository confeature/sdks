// SPDX-License-Identifier: MIT

import type { ISetting, ISettingValue } from "./config-json.ts";
import {
  FlagOverrides,
  type IOverrideDataSource,
  type OverrideBehaviour,
  settingFromValue,
} from "./flag-overrides.ts";
import { keyedRecord } from "./own-key.ts";

/**
 * URL query-string flag-override source. Port of `configcat-react@4.9.0`'s
 * `createFlagOverridesFromQueryParams` — same prefix, same parsing rules,
 * same SSR semantics. Letting customers flip flags from a URL is the
 * canonical "debug a built-in production page without rebuilding" path.
 *
 * Spec 078 / closes #271 D5 (last open divergence on the JS family
 * conformance audit).
 */

const DEFAULT_PARAM_PREFIX = "cc-";
const FORCE_STRING_VALUE_SUFFIX = ";str";

/**
 * Abstraction over `window.location.search` so the helper is testable
 * outside a browser. Customers may pass a custom provider to drive the
 * overrides from any string source (e.g. a Next.js server-side router).
 */
export interface IQueryStringProvider {
  readonly currentValue: string | undefined;
}

class DefaultQueryStringProvider implements IQueryStringProvider {
  get currentValue(): string | undefined {
    // `globalThis.window` keeps sdk-shared DOM-lib-free (its tsconfig
    // doesn't include "dom"). In a browser, `globalThis.window === window`;
    // in Node / SSR, it's `undefined`.
    const win = (globalThis as { window?: { location?: { search?: string } } }).window;
    return win?.location?.search;
  }
}

class QueryParamsOverrideDataSource implements IOverrideDataSource {
  private settings: Record<string, ISettingValue>;
  private queryString: string;

  constructor(
    private readonly watchChanges: boolean,
    private readonly paramPrefix: string,
    private readonly queryStringProvider: IQueryStringProvider,
  ) {
    const current = queryStringProvider.currentValue;
    this.settings = extractSettings(current, paramPrefix);
    this.queryString = current ?? "";
  }

  getOverrides(): Promise<Record<string, ISetting>> {
    return Promise.resolve(this.getOverridesSync());
  }

  getOverridesSync(): Record<string, ISetting> {
    if (this.watchChanges) {
      const current = this.queryStringProvider.currentValue;
      const currentString = current ?? "";
      if (currentString !== this.queryString) {
        this.settings = extractSettings(current, this.paramPrefix);
        this.queryString = currentString;
      }
    }
    // Wrap each value envelope as a trivial value-only `ISetting` so the
    // source satisfies the widened, rule-capable `IOverrideDataSource`
    // (spec 135 §R2). Resolution stays value-only — no rules are introduced.
    const wrapped = keyedRecord<ISetting>();
    for (const [key, value] of Object.entries(this.settings)) {
      wrapped[key] = settingFromValue(value);
    }
    return wrapped;
  }
}

function extractSettings(
  queryString: string | undefined,
  paramPrefix: string,
): Record<string, ISettingValue> {
  const settings = keyedRecord<ISettingValue>();
  if (!queryString || queryString.lastIndexOf("?", 0) < 0) {
    return settings;
  }
  for (const raw of queryString.substring(1).split("&")) {
    const part = raw.replace(/\+/g, " ");
    const idx = part.indexOf("=");
    const key = decodeURIComponent(idx >= 0 ? part.substring(0, idx) : part);
    const value = idx >= 0 ? decodeURIComponent(part.substring(idx + 1)) : "";
    extractSetting(key, value, paramPrefix, settings);
  }
  return settings;
}

function extractSetting(
  key: string,
  value: string,
  paramPrefix: string,
  settings: Record<string, ISettingValue>,
): void {
  if (!key || key.length <= paramPrefix.length || key.lastIndexOf(paramPrefix, 0) < 0) {
    return;
  }
  let trimmed = key.substring(paramPrefix.length);
  const forceString =
    trimmed.length > FORCE_STRING_VALUE_SUFFIX.length &&
    trimmed.indexOf(FORCE_STRING_VALUE_SUFFIX, trimmed.length - FORCE_STRING_VALUE_SUFFIX.length) >=
      0;
  if (forceString) {
    trimmed = trimmed.substring(0, trimmed.length - FORCE_STRING_VALUE_SUFFIX.length);
    settings[trimmed] = { s: value };
    return;
  }
  settings[trimmed] = parseSettingValue(value);
}

function parseSettingValue(value: string): ISettingValue {
  const lower = value.toLowerCase();
  if (lower === "true") return { b: true };
  if (lower === "false") return { b: false };
  const n = parseFloatStrict(value);
  if (!Number.isNaN(n)) return { d: n };
  return { s: value };
}

/**
 * Mirrors upstream's `parseFloatStrict`: JS's `+value` is too forgiving
 * (whitespace → 0, hex / octal accepted). We reject those manually and
 * delegate to `Number(value)` for the rest.
 */
function parseFloatStrict(value: string): number {
  if (!value.length || /^\s*$|^\s*0[^\d.e]/.test(value)) {
    return Number.NaN;
  }
  return Number(value);
}

/**
 * Build a `FlagOverrides` whose settings come from the current URL's
 * query string. Matches `configcat-react`'s helper of the same name 1:1.
 *
 * Examples (default prefix `cc-`):
 *   `?cc-flag-x=true`         → `flag-x` = `true`
 *   `?cc-port=8080`           → `port`   = `8080` (number)
 *   `?cc-greeting=hello`      → `greeting` = `"hello"`
 *   `?cc-id;str=42`           → `id`     = `"42"` (forced-string suffix)
 *
 * @param behaviour            How overrides merge with remote config.
 * @param watchChanges         When `true`, re-extract settings on every
 *                             `getOverridesSync()` call if the URL
 *                             changed. Default `false`.
 * @param paramPrefix          Optional override of the default `cc-`
 *                             prefix.
 * @param queryStringProvider  Optional injection point — the default
 *                             reads `window.location.search` and is
 *                             safe in SSR (returns `undefined`).
 */
export function createFlagOverridesFromQueryParams(
  behaviour: OverrideBehaviour,
  watchChanges = false,
  paramPrefix = DEFAULT_PARAM_PREFIX,
  queryStringProvider: IQueryStringProvider = new DefaultQueryStringProvider(),
): FlagOverrides {
  return new FlagOverrides(
    new QueryParamsOverrideDataSource(watchChanges, paramPrefix, queryStringProvider),
    behaviour,
  );
}
