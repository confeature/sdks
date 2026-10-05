# @confeature/test-fixtures-sdk-parity

The shared **parity-test corpus** consumed by every Confeature SDK's
parity tier. Two pieces:

- `src/fixtures.ts` — the `(key, user, expected)` tuples.
- `src/configs.ts` — canonical `config_v6.json` blobs the tuples
  reference.

Pinned `configcat-js@^9.4.0` (research.md §R2) as the parity reference.
The package is `"private": true` — it is never published to npm; it
lives only inside the monorepo as a workspace dependency.

## The `SettingType × value` extension matrix

The corpus ships as **two separate tiers** — two distinct arrays and
two distinct JSON files. They are never merged: a boolean-only SDK
must never have to parse a string / int / double tuple.

1. **The 58-tuple boolean corpus** — `CORPUS`, built by `fixtures.ts`'s
   `build()`: simple boolean settings, missing-key fallback, and
   `TYPE_MISMATCH` on a type-disagreeing default. These 58 tuples are
   **byte-stable** — never reordered, never reshaped (spec 066,
   FR-011). Exported to `fixtures/parity-corpus.json` (+
   `fixtures/parity-configs.json`). **Every one of the 21 SDKs runs
   this corpus.**

2. **The `SettingType × value` extension corpus** — `CORPUS_TYPED`,
   built by `fixtures.ts`'s `buildTyped()` (spec 066 / #253). A
   **separate** 13-tuple corpus, exported to its own files
   `fixtures/parity-corpus-typed.json` (+
   `fixtures/parity-configs-typed.json`). It covers the three
   non-boolean ConfigCat `SettingType`s:

   | `SettingType` | `t` | `v` key | canonical config |
   | ------------- | --- | ------- | ---------------- |
   | `String`      | `1` | `v.s`   | `typed-basic`    |
   | `Int`         | `2` | `v.i`   | `typed-basic`    |
   | `Double`      | `3` | `v.d`   | `typed-basic`    |

   Each `SettingType` carries a representative value plus the
   documented edge cases — an empty-string `string` (`""`), a zero
   `int` / `double` (`0`), a negative number, and a precision-sensitive
   `double`. Typed `TYPE_MISMATCH` tuples assert that a default whose
   JS primitive type disagrees with the setting's type falls back to
   the default.

   The typed canonical config blob is `fixtures/config-v6.typed.json`,
   exposed via the `typed-basic` `CanonicalConfig` in `src/configs.ts`.
   `CanonicalConfig.overridesMap` is `Record<string, boolean | string |
number>` so a typed config feeds both `confeature` and
   `configcat-js` through `createFlagOverridesFromMap`.

   **#253 is a foundation only.** It delivers `CORPUS_TYPED` and its
   JSON files without touching any SDK. The 21 SDKs are all still
   boolean-only; wiring each SDK family onto the typed corpus is the
   work of children #254-#261, which opt their SDK in as they
   implement typed values.

### How a per-SDK-family child (#254-#261) consumes the typed tuples

The typed tuples use the **same `ParityTuple` shape** as the boolean
tuples — `{ description, configId, key, defaultValue, user, expected }`,
with `defaultValue` / `expected` typed `boolean | string | number |
null`. A per-SDK-family child's parity tier iterates `getCorpusTyped()`
and resolves configs via `getConfig()` exactly as the boolean tuples
are consumed today; no new consumption API is introduced. Non-TS SDKs
read `fixtures/parity-corpus-typed.json` and
`fixtures/parity-configs-typed.json`.

## How an SDK consumes the corpus

```ts
// apps/sdk-browser-js/tests/parity/parity-corpus.test.ts (example)
import { getCorpus, getConfig } from "@confeature/test-fixtures-sdk-parity";

for (const tuple of getCorpus()) {
  const expected = configcatClient.getValueAsync(tuple.key, tuple.defaultValue, tuple.user);
  const actual = confeatureClient.getValueAsync(tuple.key, tuple.defaultValue, tuple.user);
  expect(actual).toStrictEqual(expected);
}
```

## Adding a new corpus tuple

1. If a new canonical config is needed, add a blob in
   `src/configs.ts` and export it.
2. Add a tuple in `src/fixtures.ts` describing
   `{ description, configId, key, defaultValue, user, expected }`.
3. Re-run every SDK's parity tier:
   ```bash
   vp run -F "@confeature/sdk-*" test:parity
   ```

## Upgrading `configcat-js`

When ConfigCat ships a new minor / patch (range `^9.4.0` tolerates
patch bumps automatically; a minor bump may require a manual update):

```bash
cd packages/test-fixtures-sdk-parity
pnpm up configcat-js@latest

# Re-run every SDK's parity tier:
vp run -F "@confeature/sdk-*" test:parity
```

If any tier fails, the SDK has drifted from configcat-js or vice
versa. Triage: (a) update the Confeature SDK to match, or
(b) document the divergence as a new `research.md §R-N` rationale on
the spec that introduced the SDK.

For a **major** configcat-js bump, open a dedicated PR and run the
constitution Governance amendment process if the breakage is
material (Principle II is NON-NEGOTIABLE — every divergence is a
deliberate choice, not a regression).
