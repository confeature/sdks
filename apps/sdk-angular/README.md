# `@confeature/sdk-angular`

Confeature Angular SDK — an Angular-idiomatic facade (Service +
Provider + Module + Directive + Pipe) on top of
[`@confeature/sdk-browser-js`](../sdk-browser-js/) for Angular 17 / 18
applications. Drop-in compatible with
[`@configcat/ng-client`](https://www.npmjs.com/package/@configcat/ng-client)
at the public surface level (constitution Principle II): rename two
imports and you ship.

**License**: MIT.

---

## Install

```bash
pnpm add @confeature/sdk-angular @confeature/sdk-browser-js
# or
npm install @confeature/sdk-angular @confeature/sdk-browser-js
```

`@angular/core`, `@angular/common`, and `rxjs` are peer dependencies —
bring your own to avoid the duplicate-Angular footgun.

---

## Quickstart — standalone (Angular 17+)

```ts
import { bootstrapApplication } from "@angular/platform-browser";
import { provideConfeature } from "@confeature/sdk-angular";

import { AppComponent } from "./app.component";

bootstrapApplication(AppComponent, {
  providers: [
    provideConfeature({
      sdkKey: "configcat-sdk-1/<your-22-char>/<your-22-char>",
      pollingMode: "autoPoll",
      pollIntervalSeconds: 60,
    }),
  ],
});
```

```ts
// app.component.ts
import { AsyncPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { ConfeatureService } from "@confeature/sdk-angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [AsyncPipe],
  template: ` <p>Dark mode is {{ darkMode$ | async }}</p> `,
})
export class AppComponent {
  private readonly confeature = inject(ConfeatureService);
  readonly darkMode$ = this.confeature.getValue("feature.dark-mode", false);
}
```

The Observable re-emits on every underlying `configChanged` event, so
`| async` keeps the view in sync without manual `markForCheck` calls.

---

## Quickstart — NgModule (Angular 14+ legacy)

```ts
import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { ConfeatureModule } from "@confeature/sdk-angular";

import { AppComponent } from "./app.component";

@NgModule({
  imports: [
    BrowserModule,
    ConfeatureModule.forRoot({
      sdkKey: "configcat-sdk-1/<your-22-char>/<your-22-char>",
      pollingMode: "autoPoll",
    }),
  ],
  declarations: [AppComponent],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

`provideConfeature` and `ConfeatureModule.forRoot` resolve to the same
`ConfeatureService` singleton — pick the path that matches your app's
DI style.

---

## `*cfFlag` directive

```html
<!-- truthy branch -->
<div *cfFlag="'feature.dark-mode'">Dark mode is ON</div>

<!-- truthy / falsy with an else template -->
<div *cfFlag="'feature.dark-mode'; else: classic">Dark mode is ON</div>
<ng-template #classic>
  <div>Dark mode is OFF</div>
</ng-template>

<!-- custom default + user context -->
<div *cfFlag="'feature.dark-mode'; default: false; user: currentUser">Dark mode is ON</div>
```

```ts
import { ConfeatureFlagDirective } from "@confeature/sdk-angular";

@Component({
  standalone: true,
  imports: [ConfeatureFlagDirective],
  templateUrl: "./dashboard.component.html",
})
export class DashboardComponent {
  /* … */
}
```

The directive owns its subscription via `takeUntilDestroyed(destroyRef)`
— no manual cleanup needed when the host destroys.

---

## `| cfFlag` pipe

```html
<p>Dark mode: {{ 'feature.dark-mode' | cfFlag : false : currentUser | async }}</p>

<p>Banner: {{ 'banner.text' | cfFlag : 'Welcome' | async }}</p>
```

```ts
import { AsyncPipe } from "@angular/common";
import { ConfeatureFlagPipe } from "@confeature/sdk-angular";

@Component({
  standalone: true,
  imports: [AsyncPipe, ConfeatureFlagPipe],
  templateUrl: "./banner.component.html",
})
export class BannerComponent {
  /* … */
}
```

The pipe is impure (`pure: false`) but caches its inner Observable per
`(key, default, user)` triple, so it does NOT create a new Observable
on every change-detection cycle.

---

## Local flag overrides (offline / tests)

```ts
import {
  provideConfeature,
  createFlagOverridesFromMap,
  OverrideBehaviour,
} from "@confeature/sdk-angular";

bootstrapApplication(AppComponent, {
  providers: [
    provideConfeature({
      sdkKey: "configcat-sdk-1/<your-22-char>/<your-22-char>",
      pollingMode: "manualPoll",
      flagOverrides: createFlagOverridesFromMap(
        { "feature.dark-mode": true, "banner.text": "Hello from overrides" },
        OverrideBehaviour.LocalOnly, // never hits the CDN
      ),
    }),
  ],
});
```

`LocalOnly` is the fastest path for component tests — `manualPoll` +
`LocalOnly` resolves every flag synchronously from the in-memory map.

`LocalOverRemote` / `RemoteOverLocal` mix overrides with the live CDN
config — see [`@confeature/sdk-browser-js`'s
overrides](../sdk-browser-js/) for the full matrix.

---

## Migrating from `@configcat/ng-client`

Three-line swap:

```diff
- import { provideConfigCat, ConfigCatModule, ConfigCatService } from "@configcat/ng-client";
+ import { provideConfeature, ConfeatureModule, ConfeatureService } from "@confeature/sdk-angular";

  bootstrapApplication(AppComponent, {
    providers: [
-     provideConfigCat({ sdkKey: "<YOUR_CONFIGCAT_KEY>" }),
+     provideConfeature({ sdkKey: "<YOUR_CONFEATURE_KEY>", baseUrl: "https://cdn.confeature.io" }),
    ],
  });
```

Every `getValue(key, default, user?)` / `getValueSync(...)` /
`forceRefresh()` / `snapshot()` / `close()` call site continues to work
unchanged. The `*ccFlag` directive's call site translates to `*cfFlag`
(same desugared shape; the selector is the only delta).

---

## Configuration matrix

| Option                        | Type                                       | Default                       | Notes                                                                                                                         |
| ----------------------------- | ------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sdkKey`                      | `string`                                   | — (required)                  | NEVER logged. Shape `configcat-sdk-1/<22-char>/<22-char>`; legacy `confeature-sdk-1-<32-char>-<32-char>` keys still accepted. |
| `pollingMode`                 | `"autoPoll" \| "lazyLoad" \| "manualPoll"` | `"autoPoll"`                  | Routed to the runtime SDK's `PollingMode` enum.                                                                               |
| `pollIntervalSeconds`         | `number`                                   | `60`                          | AutoPoll cadence (seconds).                                                                                                   |
| `cacheRefreshIntervalSeconds` | `number`                                   | `60`                          | LazyLoad TTL (seconds).                                                                                                       |
| `baseUrl`                     | `string`                                   | sdk-browser-js default        | Override CDN host. Use `https://cdn.confeature.io` for hosted Confeature.                                                     |
| `flagOverrides`               | `FlagOverrides`                            | —                             | Local override data source.                                                                                                   |
| `logger`                      | `IConfeatureLogger`                        | sdk-browser-js console logger | Custom logger.                                                                                                                |
| `logLevel`                    | `LogLevel`                                 | `LogLevel.Warn`               | Documentation hook — wire the threshold into your custom logger.                                                              |

---

## Peer-dependency matrix

| Angular | Supported | Notes                                                                            |
| ------- | --------- | -------------------------------------------------------------------------------- |
| 18.x    | yes       | Standalone-first, zoneless-ready (`provideExperimentalZonelessChangeDetection`). |
| 17.x    | yes       | Minimum supported (standalone components, `inject()`, `takeUntilDestroyed`).     |
| ≤ 16.x  | no        | Lacks `takeUntilDestroyed` + standalone-first APIs.                              |

Pinned via `peerDependencies`:

- `@angular/core`: `>=17.0.0 <19.0.0`
- `@angular/common`: `>=17.0.0 <19.0.0`
- `rxjs`: `>=7.0.0`

---

## Zone vs zoneless

The service emits via `BehaviorSubject` outside any zone wrapper.
Angular's `async` pipe and `takeUntilDestroyed(destroyRef)` pull values
back into the change-detection cycle, so both modes work without
configuration:

- **Zone.js (default)**: Subscriptions inside a component re-render on
  emit through standard NgZone tick.
- **Zoneless (Angular 18+)**: `provideExperimentalZonelessChangeDetection`
  works unchanged — the SDK does not depend on `NgZone.runOutsideAngular`
  or any zone-specific scheduling.

---

## Public exports

The package re-exports the wire / domain types from
`@confeature/sdk-browser-js`, so a consumer doesn't need a second
import:

```ts
import {
  // Angular-flavoured
  ConfeatureService,
  ConfeatureFlagDirective,
  ConfeatureFlagPipe,
  ConfeatureModule,
  CONFEATURE_CONFIG,
  provideConfeature,
  type ConfeatureConfig,
  type ConfeatureSnapshot,
  // Re-exported from sdk-browser-js
  ConfeatureClient,
  createFlagOverridesFromMap,
  FlagOverrides,
  type IEvaluationDetails,
  type IConfeatureLogger,
  LogLevel,
  MapOverrideDataSource,
  OverrideBehaviour,
  PollingMode,
  User,
} from "@confeature/sdk-angular";
```

---

## License

[`MIT`](./LICENSE).
