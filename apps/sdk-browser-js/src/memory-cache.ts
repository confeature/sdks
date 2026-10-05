// SPDX-License-Identifier: MIT

import { ProjectConfig } from "@confeature/sdk-shared";

/**
 * In-memory `ConfigCache` impl. Used by default when `localStorage`
 * isn't available (SSR, private-mode Safari, embedded WebViews) or when
 * the customer explicitly sets `cache: "memory"`.
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
