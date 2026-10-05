// SPDX-License-Identifier: MIT

/**
 * Tests for `| cfFlag` pipe — T028 / FR-012 / SC-004.
 *
 * Coverage:
 *   1. Basic render: `{{ 'k' | cfFlag : 0 | async }}` renders the
 *      cached integer.
 *   2. Toggling the underlying flag re-renders without rebuilding the
 *      subscription (cache hit on identical inputs).
 *   3. The pipe returns the same Observable instance when called with
 *      the same key/default/user triple (cache contract).
 */

import { Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { TestBed } from "@angular/core/testing";
import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-browser-js";
import { BehaviorSubject } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureFlagPipe } from "../src/confeature-flag.pipe";
import { ConfeatureService } from "../src/confeature.service";
import { provideConfeature } from "../src/provider";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

@Component({
  standalone: true,
  imports: [CommonModule, ConfeatureFlagPipe],
  template: `<span data-testid="out">{{ "count" | cfFlag: 0 | async }}</span>`,
})
class PipeHost {
  readonly service = inject(ConfeatureService);
}

describe("ConfeatureFlagPipe (T028 / FR-012)", () => {
  test("renders the flag value piped through `| cfFlag : default | async`", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap({ count: 42 }, OverrideBehaviour.LocalOnly),
        }),
      ],
    });
    const fixture = TestBed.createComponent(PipeHost);
    fixture.detectChanges();
    const out = fixture.nativeElement.querySelector('[data-testid="out"]') as HTMLElement;
    expect(out.textContent).toBe("42");

    // Push a new value through the underlying subject — the async pipe
    // observes the emission and the rendered text updates.
    const service = fixture.componentInstance.service;
    const subjects = (service as unknown as { subjects: Map<string, BehaviorSubject<unknown>> })
      .subjects;
    subjects.get("count")!.next(99);
    fixture.detectChanges();
    expect(out.textContent).toBe("99");
  });

  test("transform() returns the same Observable when called with identical (key, default, user)", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap({ k: 1 }, OverrideBehaviour.LocalOnly),
        }),
        ConfeatureFlagPipe,
      ],
    });
    const pipe = TestBed.inject(ConfeatureFlagPipe);
    const a = pipe.transform("k", 0);
    const b = pipe.transform("k", 0);
    expect(a).toBe(b);

    // Changing the default invalidates the cache → new Observable.
    const c = pipe.transform("k", 99);
    expect(c).not.toBe(a);
  });
});
