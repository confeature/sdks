// SPDX-License-Identifier: MIT

/**
 * src/wire-case-rules.ts — the cross-file rules scripts/validate-wire-cases.ts
 * runs on wire-cases.json (#803). The real corpus must be clean, and every
 * branch of the malformed-key exception (and of the rules around it) must
 * reject the corpus it exists to reject: a guard that cannot fail is no guard.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { crossFileErrors, MALFORMED_KEY_CASES, type WireCaseLike } from "../src/wire-case-rules.ts";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), "utf-8"));

const corpus = (readJson("wire-cases.json") as { cases: WireCaseLike[] }).cases;
const validKeys: ReadonlySet<string> = new Set(
  (readJson("sdk-key-shapes.json") as { valid: Array<{ key: string }> }).valid.map((e) => e.key),
);

const MALFORMED_ID = "request-path-malformed-key";
const CONFIGCAT_KEY = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";
const CONFIGCAT_PATH = `/configuration-files/${CONFIGCAT_KEY}/config_v6.json`;
const MALFORMED_KEY = "bad key$&+:=@,;!'()*~/x?y#z%é€😀..";
const MALFORMED_PATH =
  "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80../config_v6.json";

const wireCase = (id: string, sdkKey?: string, requestPath?: string): WireCaseLike => ({
  id,
  given: sdkKey === undefined ? {} : { sdkKey },
  expected: requestPath === undefined ? {} : { requestPath },
});
/** A minimal clean corpus: one valid-key case plus the malformed-key case. */
const cleanCorpus = (
  malformed: WireCaseLike = wireCase(MALFORMED_ID, MALFORMED_KEY, MALFORMED_PATH),
) => [wireCase("request-path-configcat-key", CONFIGCAT_KEY, CONFIGCAT_PATH), malformed];

describe("crossFileErrors — the real corpus", () => {
  it("is clean", () => {
    expect(crossFileErrors(corpus, validKeys)).toEqual([]);
  });

  it("names exactly one malformed-key case, and it pins the re-pinned key and path", () => {
    expect([...MALFORMED_KEY_CASES]).toEqual([MALFORMED_ID]);
    const pinned = corpus.find((c) => c.id === MALFORMED_ID);
    expect(pinned?.given.sdkKey).toBe(MALFORMED_KEY);
    expect(pinned?.expected.requestPath).toBe(MALFORMED_PATH);
  });
});

describe("crossFileErrors — the malformed-key exception", () => {
  it("accepts the minimal clean corpus", () => {
    expect(crossFileErrors(cleanCorpus(), validKeys)).toEqual([]);
  });

  it("rejects a malformed-key case that pins no requestPath", () => {
    expect(crossFileErrors(cleanCorpus(wireCase(MALFORMED_ID, MALFORMED_KEY)), validKeys)).toEqual([
      `${MALFORMED_ID}: a malformed-key case must pin both given.sdkKey and expected.requestPath`,
    ]);
  });

  it("rejects a malformed-key case that pins no sdkKey", () => {
    expect(
      crossFileErrors(cleanCorpus(wireCase(MALFORMED_ID, undefined, MALFORMED_PATH)), validKeys),
    ).toEqual([
      `${MALFORMED_ID}: a malformed-key case must pin both given.sdkKey and expected.requestPath`,
    ]);
  });

  it("rejects a well-shaped key smuggled in through the exception", () => {
    const errors = crossFileErrors(
      cleanCorpus(wireCase(MALFORMED_ID, CONFIGCAT_KEY, CONFIGCAT_PATH)),
      validKeys,
    );
    expect(errors).toEqual([
      `${MALFORMED_ID}: given.sdkKey ${JSON.stringify(CONFIGCAT_KEY)} is well-shaped — a valid key belongs in sdk-key-shapes.json, not inline`,
    ]);
  });

  it("rejects a key that is in the valid list even when it misses the shape regex", () => {
    const listed = "listed-but-not-shaped";
    const errors = crossFileErrors(
      cleanCorpus(wireCase(MALFORMED_ID, listed, `/configuration-files/${listed}/config_v6.json`)),
      new Set([...validKeys, listed]),
    );
    expect(errors).toEqual([
      `${MALFORMED_ID}: given.sdkKey "${listed}" is well-shaped — a valid key belongs in sdk-key-shapes.json, not inline`,
    ]);
  });

  it.each(["", ".", ".."])("rejects the path-less key %j without throwing", (key) => {
    const errors = crossFileErrors(
      cleanCorpus(wireCase(MALFORMED_ID, key, "/configuration-files//config_v6.json")),
      validKeys,
    );
    expect(errors).toEqual([
      `${MALFORMED_ID}: given.sdkKey ${JSON.stringify(key)} has no FR-001 path (the SDK refuses to fetch)`,
    ]);
  });

  it("rejects a malformed key whose pinned path is not FR-001's", () => {
    // encodeURIComponent's bytes — the escaper the case exists to catch.
    const wrong = `/configuration-files/${encodeURIComponent(MALFORMED_KEY)}/config_v6.json`;
    const errors = crossFileErrors(
      cleanCorpus(wireCase(MALFORMED_ID, MALFORMED_KEY, wrong)),
      validKeys,
    );
    expect(errors).toEqual([
      `${MALFORMED_ID}: expected.requestPath ${JSON.stringify(wrong)} is not FR-001's path ${JSON.stringify(MALFORMED_PATH)}`,
    ]);
  });

  it("reports a lone-surrogate key against the case instead of crashing the gate", () => {
    const errors = crossFileErrors(
      cleanCorpus(wireCase(MALFORMED_ID, "bad\ud800key", "/configuration-files/x/config_v6.json")),
      validKeys,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^${MALFORMED_ID}: .*lone surrogate`));
  });

  it("fails when the named case disappears from the corpus", () => {
    const withoutIt = cleanCorpus().filter((c) => c.id !== MALFORMED_ID);
    expect(crossFileErrors(withoutIt, validKeys)).toEqual([
      `${MALFORMED_ID}: listed in MALFORMED_KEY_CASES but not in the corpus`,
    ]);
  });

  it("fails when the named case is renamed (the exception does not follow it)", () => {
    const renamed = cleanCorpus(
      wireCase("request-path-malformed-key-v2", MALFORMED_KEY, MALFORMED_PATH),
    );
    expect(crossFileErrors(renamed, validKeys)).toEqual([
      `request-path-malformed-key-v2: given.sdkKey ${JSON.stringify(MALFORMED_KEY)} is not a valid key in sdk-key-shapes.json`,
      `${MALFORMED_ID}: listed in MALFORMED_KEY_CASES but not in the corpus`,
    ]);
  });
});

describe("crossFileErrors — every other case", () => {
  it("rejects an inline malformed key on a case the exception does not name", () => {
    const corpusWithInline = [
      ...cleanCorpus(),
      wireCase("request-path-configcat-key-copy", MALFORMED_KEY, MALFORMED_PATH),
    ];
    expect(crossFileErrors(corpusWithInline, validKeys)).toEqual([
      `request-path-configcat-key-copy: given.sdkKey ${JSON.stringify(MALFORMED_KEY)} is not a valid key in sdk-key-shapes.json`,
    ]);
  });

  it("rejects an inline well-shaped key that is not in the valid list", () => {
    const unlisted = "configcat-sdk-1/zzzzzzzzzzzzzzzzzzzzzz/zzzzzzzzzzzzzzzzzzzzzz";
    const corpusWithUnlisted = [...cleanCorpus(), wireCase("unlisted", unlisted)];
    expect(crossFileErrors(corpusWithUnlisted, validKeys)).toEqual([
      `unlisted: given.sdkKey ${JSON.stringify(unlisted)} is not a valid key in sdk-key-shapes.json`,
    ]);
  });

  it("rejects an inline '' key with a pinned path without throwing", () => {
    const errors = crossFileErrors(
      [...cleanCorpus(), wireCase("empty", "", "/configuration-files//config_v6.json")],
      validKeys,
    );
    expect(errors).toEqual([
      `empty: given.sdkKey "" is not a valid key in sdk-key-shapes.json`,
      `empty: fr001Path: "" has no path — the SDK must not fetch`,
    ]);
  });

  it("rejects a valid key whose pinned path is not FR-001's (a %2F-escaped ConfigCat key)", () => {
    const escaped = `/configuration-files/${CONFIGCAT_KEY.replaceAll("/", "%2F")}/config_v6.json`;
    const errors = crossFileErrors(
      [wireCase("request-path-configcat-key", CONFIGCAT_KEY, escaped), cleanCorpus()[1]!],
      validKeys,
    );
    expect(errors).toEqual([
      `request-path-configcat-key: expected.requestPath ${JSON.stringify(escaped)} is not FR-001's path ${JSON.stringify(CONFIGCAT_PATH)}`,
    ]);
  });

  // Rule 3: a pinned path with no pinned key is malformed. Each path below is
  // what SOME consumer would request for the case — the hermetic suites'
  // shared default, the sdk-node live runner's case id — so a rule that
  // judged the case against any one default would accept it and leave the
  // other consumer red. Neither may pass; nor may an outright wrong path.
  const HERMETIC_DEFAULT_KEY =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  it.each([
    [
      "the hermetic default key's path",
      `/configuration-files/${HERMETIC_DEFAULT_KEY}/config_v6.json`,
    ],
    ["the live runner's case-id path", "/configuration-files/keyless/config_v6.json"],
    ["a path for no key at all", "/configuration-files/not-a-key/config_v6.json"],
  ])("rejects a requestPath pinned without given.sdkKey (%s)", (_label, path) => {
    expect(
      crossFileErrors([...cleanCorpus(), wireCase("keyless", undefined, path)], validKeys),
    ).toEqual([
      "keyless: expected.requestPath is pinned without given.sdkKey — the path is a function of the key, and a consumer's default key is its own (the live runner uses the case id), so pin the key",
    ]);
  });

  it("accepts a case that pins no key and no path", () => {
    expect(crossFileErrors([...cleanCorpus(), wireCase("plain-200")], validKeys)).toEqual([]);
  });
});
