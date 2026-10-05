// SPDX-License-Identifier: MIT

/**
 * Vitest setup file — bootstraps Angular's `TestBed` so component /
 * directive / pipe tests can drive change detection.
 *
 * Import order matters:
 *   1. `@analogjs/vitest-angular/setup-zone` — installs zone.js, the
 *      `SyncTestZoneSpec` + `ProxyZoneSpec` plugins, and patches
 *      Vitest's `describe` / `test` / `beforeEach` / `afterEach` so
 *      every test body runs inside a `ProxyZone`. Without this patch,
 *      Angular's `core/testing` boot path throws "Expected to be
 *      running in 'ProxyZone'" the first time a fakeAsync reset runs.
 *   2. `getTestBed().initTestEnvironment(...)` registers the browser
 *      dynamic test environment exactly once per worker.
 *
 * The `@analogjs/vite-plugin-angular` plugin compiles Angular sources
 * via the partial-ivy compiler before Vitest hands them off — this
 * file only handles the runtime bootstrap, not the build step.
 */

import "@analogjs/vitest-angular/setup-zone";

import { getTestBed } from "@angular/core/testing";
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from "@angular/platform-browser-dynamic/testing";

// Guard against double-init when Vitest reloads the setup file in
// parallel workers — TestBed.initTestEnvironment can only be called
// once per worker; subsequent invocations throw "Cannot set base
// providers because it has already been called".
const testBed = getTestBed();
if (!(testBed as unknown as { platform?: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}
