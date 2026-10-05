// SPDX-License-Identifier: MIT

/**
 * `ConfeatureFlagDirective` — structural directive `*cfFlag` (FR-011).
 *
 * Template binding shapes supported (mirrors ConfigCat's `*ccFlag`):
 *
 *   <div *cfFlag="'key'">A</div>
 *     → renders A iff the flag value is truthy
 *
 *   <div *cfFlag="'key'; else: tpl">A</div>
 *   <ng-template #tpl>B</ng-template>
 *     → renders A iff truthy, else `tpl`
 *
 *   <div *cfFlag="'key'; default: false">A</div>
 *     → custom default + still renders A iff truthy
 *
 *   <div *cfFlag="'key'; user: u">A</div>
 *     → custom user context for evaluation
 *
 * Angular's structural-directive desugaring requires the inputs that
 * share the host selector to be named with the selector as prefix:
 *   *cfFlag="<key>; default: <d>; user: <u>; else: <tpl>"
 * desugars to:
 *   [cfFlag]="<key>" [cfFlagDefault]="<d>" [cfFlagUser]="<u>" [cfFlagElse]="<tpl>"
 *
 * Subscription is held under `takeUntilDestroyed(destroyRef)` so the
 * directive cleans itself up automatically when its host is destroyed
 * (FR-019).
 */

import {
  DestroyRef,
  Directive,
  inject,
  Input,
  type OnChanges,
  type OnInit,
  type SimpleChanges,
  TemplateRef,
  ViewContainerRef,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import type { User } from "@confeature/sdk-browser-js";
import { type Subscription } from "rxjs";

import { ConfeatureService } from "./confeature.service";

@Directive({
  selector: "[cfFlag]",
  standalone: true,
})
export class ConfeatureFlagDirective implements OnInit, OnChanges {
  /** Flag key. Required. */
  @Input("cfFlag") cfFlag!: string;

  /**
   * Default value used when the cache has no entry / no override.
   * Also doubles as the truthiness baseline — i.e. if the consumer
   * supplies a number default (`0`), the directive treats any falsy
   * value the same way `Boolean(value)` does.
   */
  @Input("cfFlagDefault") cfFlagDefault: unknown = false;

  /** Optional user context. */
  @Input("cfFlagUser") cfFlagUser?: User;

  /**
   * Template to render when the flag value is falsy. If omitted, the
   * directive simply clears its embedded view in the falsy branch.
   */
  @Input("cfFlagElse") cfFlagElse?: TemplateRef<unknown>;

  private readonly service = inject(ConfeatureService);
  private readonly hostTemplate = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Active subscription on the current key's Observable. */
  private subscription: Subscription | undefined;
  /** Tracks whether the host template is currently rendered. */
  private currentBranch: "host" | "else" | "empty" = "empty";

  ngOnInit(): void {
    this.subscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Re-subscribe whenever the key, default, or user changes — the
    // BehaviorSubject + default + user form the recipe; we have to
    // tear down and rebuild when any of them shift.
    if (changes["cfFlag"] || changes["cfFlagDefault"] || changes["cfFlagUser"]) {
      this.subscribe();
    } else if (changes["cfFlagElse"]) {
      // `else` template swap doesn't need a new subscription; just
      // re-render the current branch.
      this.render(this.lastValue);
    }
  }

  private lastValue: unknown = undefined;

  private subscribe(): void {
    // Tear down any prior subscription before swapping.
    this.subscription?.unsubscribe();
    if (!this.cfFlag) {
      // No key yet (Angular sets inputs in two passes for some
      // bindings); render the falsy branch defensively.
      this.render(false);
      return;
    }
    this.subscription = this.service
      .getValue<unknown>(this.cfFlag, this.cfFlagDefault, this.cfFlagUser)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        this.lastValue = value;
        this.render(value);
      });
  }

  private render(value: unknown): void {
    const truthy = Boolean(value);
    if (truthy) {
      if (this.currentBranch !== "host") {
        this.viewContainer.clear();
        this.viewContainer.createEmbeddedView(this.hostTemplate, { $implicit: value });
        this.currentBranch = "host";
      }
    } else if (this.cfFlagElse) {
      if (this.currentBranch !== "else") {
        this.viewContainer.clear();
        this.viewContainer.createEmbeddedView(this.cfFlagElse);
        this.currentBranch = "else";
      }
    } else if (this.currentBranch !== "empty") {
      this.viewContainer.clear();
      this.currentBranch = "empty";
    }
  }
}
