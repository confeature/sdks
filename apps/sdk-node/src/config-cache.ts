// SPDX-License-Identifier: MIT

import { ProjectConfig } from "@confeature/sdk-shared";

/**
 * Single-reference in-memory cache holding the current {@link ProjectConfig}.
 *
 * The swap is a single assignment — JavaScript is single-threaded so
 * concurrent `getCurrent()` calls observe either the old or the new
 * reference, never a torn read. Used by `AutoPollConfigService` as the
 * primary source for eval-time reads.
 *
 * Reference: data-model.md `InMemoryConfigCache`.
 */
export class InMemoryConfigCache {
  private current: ProjectConfig = ProjectConfig.empty();

  /** Returns the currently held config. Never null — `empty()` until first fetch. */
  getCurrent(): ProjectConfig {
    return this.current;
  }

  /**
   * Atomic swap. JS single-threaded → safe even if a reader is mid-call;
   * the reader either sees `next` or the previous value, never a partial.
   */
  set(next: ProjectConfig): void {
    this.current = next;
  }
}
