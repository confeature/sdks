// SPDX-License-Identifier: MIT

/**
 * `ConfeatureFlagPipe` — stateful pipe `| cfFlag` (FR-012).
 *
 * Template usage (mirrors ConfigCat's `| configCat` pipe):
 *
 *   {{ 'feature-flag' | cfFlag : false : user | async }}
 *
 * The pipe returns `Observable<T>`; the consumer chains `| async` to
 * unwrap into the rendered template.
 *
 * Caching: the pipe is `pure: false` (Angular re-evaluates on every
 * change-detection cycle), so we cache the last-returned Observable
 * per `(key, default, user)` triple. Without the cache, every CD
 * cycle would tear down + rebuild the subscription, which would
 * defeat the BehaviorSubject sharing (FR-014).
 */

import { DestroyRef, inject, Pipe, type PipeTransform } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import type { User } from "@confeature/sdk-browser-js";
import type { Observable } from "rxjs";

import { ConfeatureService } from "./confeature.service";

@Pipe({
  name: "cfFlag",
  pure: false,
  standalone: true,
})
export class ConfeatureFlagPipe implements PipeTransform {
  private readonly service = inject(ConfeatureService);
  private readonly destroyRef = inject(DestroyRef);

  private lastKey: string | undefined;
  private lastDefault: unknown;
  private lastUser: User | undefined;
  private lastObservable: Observable<unknown> | undefined;

  transform<T>(key: string, defaultValue: T, user?: User): Observable<T> {
    // Cache hit if all three inputs match the previous call.
    if (
      this.lastObservable !== undefined &&
      this.lastKey === key &&
      this.lastDefault === defaultValue &&
      this.lastUser === user
    ) {
      return this.lastObservable as Observable<T>;
    }
    const obs = this.service
      .getValue<T>(key, defaultValue, user)
      .pipe(takeUntilDestroyed(this.destroyRef));
    this.lastKey = key;
    this.lastDefault = defaultValue;
    this.lastUser = user;
    this.lastObservable = obs as Observable<unknown>;
    return obs;
  }
}
