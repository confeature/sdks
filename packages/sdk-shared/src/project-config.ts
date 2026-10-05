// SPDX-License-Identifier: MIT

import type { IConfig, ISetting } from "./config-json.ts";

/**
 * Wrapper around a parsed `config_v6.json` payload — the SDK's unit of
 * cache content. Holds the parsed JSON, the server's ETag (used for
 * `If-None-Match` on the next poll), and the fetch wall-clock time.
 *
 * Reference: `configcat-common/src/ProjectConfig.ts`.
 */
export class ProjectConfig {
  constructor(
    public readonly configJson: IConfig | null,
    public readonly eTag: string | null,
    public readonly fetchTime: number,
  ) {}

  /** Initial / cleared cache state. */
  static empty(): ProjectConfig {
    return new ProjectConfig(null, null, 0);
  }

  /** Settings map; empty object if no config yet. */
  get settings(): Record<string, ISetting> {
    return this.configJson?.f ?? {};
  }

  /** Has this config grown stale relative to a max-age window? */
  isExpired(maxAgeMs: number): boolean {
    return Date.now() - this.fetchTime > maxAgeMs;
  }

  /**
   * Return a copy with a refreshed `fetchTime` — used on 304 Not Modified
   * to update freshness without re-parsing.
   */
  withFreshFetchTime(now: number): ProjectConfig {
    return new ProjectConfig(this.configJson, this.eTag, now);
  }
}
