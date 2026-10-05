// SPDX-License-Identifier: MIT

import { ProjectConfig } from "@confeature/sdk-shared";

/**
 * In-memory `ConfigCache` impl. Used as the fallback path when
 * `Deno.writeTextFile` writes fail (no `--allow-write`, read-only FS,
 * quota) or when `options.cache === "memory"` is set explicitly.
 *
 * Single-reference swap; concurrent readers either see the old or the
 * new config — JavaScript's single-threaded nature precludes torn reads.
 */
export class InMemoryConfigCache {
  private current: ProjectConfig = ProjectConfig.empty();

  /** Returns the currently held config. Never null — `empty()` until first set. */
  getCurrent(): ProjectConfig {
    return this.current;
  }

  /** Atomic swap. */
  set(next: ProjectConfig): void {
    this.current = next;
  }
}
