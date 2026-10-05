// SPDX-License-Identifier: MIT

/**
 * Tests for `*cfFlag` structural directive — T027 / FR-011 / SC-003.
 *
 * Coverage:
 *   1. Plain shape: `<div *cfFlag="'k'">A</div>` renders A iff truthy.
 *   2. `else` shape: `<div *cfFlag="'k'; else: alt">A</div>` falls
 *      through to the alt template when value is falsy.
 *   3. Toggling the underlying flag (via a subject push) re-renders.
 *   4. Default value is honoured when the key is missing from cache.
 */

import { Component, inject } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-browser-js";
import { BehaviorSubject } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureFlagDirective } from "../src/confeature-flag.directive";
import { ConfeatureService } from "../src/confeature.service";
import { provideConfeature } from "../src/provider";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

@Component({
  standalone: true,
  imports: [ConfeatureFlagDirective],
  template: `
    <div data-testid="host" *cfFlag="'flag-key'">A</div>
    <ng-template #alt><div data-testid="alt">B</div></ng-template>
    <div data-testid="hostElse" *cfFlag="'flag-key'; else alt">A</div>
  `,
})
class DirectiveHost {
  readonly service = inject(ConfeatureService);
}

describe("ConfeatureFlagDirective (T027 / FR-011)", () => {
  test("renders host template when flag is truthy; alt template when falsy (via toggle)", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap(
            { "flag-key": true },
            OverrideBehaviour.LocalOnly,
          ),
        }),
      ],
    });
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.detectChanges();

    // Truthy → both branches render the "A" host template.
    expect(fixture.nativeElement.querySelector('[data-testid="host"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="hostElse"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="alt"]')).toBeNull();

    // Flip the value through the subject — simulates configChanged.
    const service = fixture.componentInstance.service;
    const subjects = (service as unknown as { subjects: Map<string, BehaviorSubject<unknown>> })
      .subjects;
    subjects.get("flag-key")!.next(false);
    fixture.detectChanges();

    // Falsy: plain shape clears the embedded view; `else` shape
    // renders the alt template.
    expect(fixture.nativeElement.querySelector('[data-testid="host"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="alt"]')).not.toBeNull();

    // Flip back to true — both branches restore the "A" host template.
    subjects.get("flag-key")!.next(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="host"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="hostElse"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="alt"]')).toBeNull();
  });

  test("missing key falls back to default (false → falsy branch)", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          // No override for "flag-key" → default applies.
          flagOverrides: createFlagOverridesFromMap(
            { unrelated: true },
            OverrideBehaviour.LocalOnly,
          ),
        }),
      ],
    });
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.detectChanges();

    // Default for `*cfFlag="'flag-key'"` (no cfFlagDefault) is false →
    // both shapes treat falsy: plain clears, `else` renders alt.
    expect(fixture.nativeElement.querySelector('[data-testid="host"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="alt"]')).not.toBeNull();
  });
});
