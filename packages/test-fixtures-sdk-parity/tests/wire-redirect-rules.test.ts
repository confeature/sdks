// SPDX-License-Identifier: MIT

/**
 * The 1.4 rules (#994): redirect cases and the pending list. Each rule must
 * reject the corpus it exists to reject — a guard that cannot fail is no guard.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  pendingErrors,
  type PendingManifest,
  type RedirectCaseLike,
  redirectErrors,
  type WireConsumer,
} from "../src/wire-case-rules.ts";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), "utf-8"));
const corpus = (readJson("wire-cases.json") as { cases: RedirectCaseLike[] }).cases;
const byId = (id: string): RedirectCaseLike =>
  structuredClone(corpus.find((c) => c.id === id)!) as RedirectCaseLike;
const REFUSED = "redirect-https-to-http-refused";
const FOLLOWED = "redirect-https-to-https-followed";

describe("redirectErrors", () => {
  it("the real corpus is clean and carries both redirect cases", () => {
    expect(redirectErrors(corpus)).toEqual([]);
    expect(corpus.filter((c) => c.server.redirect).map((c) => c.id)).toEqual([REFUSED, FOLLOWED]);
  });

  it("rejects a downgrade that does not expect zero target requests", () => {
    const c = byId(REFUSED);
    c.expected.downgradeTargetRequests = 1;
    expect(redirectErrors([c])).toEqual([
      `${REFUSED}: an https→http redirect must expect downgradeTargetRequests 0`,
    ]);
  });

  it("rejects a downgrade without the insecure_redirect reason", () => {
    const c = byId(REFUSED);
    delete c.expected.failureReason;
    expect(redirectErrors([c])).toHaveLength(1);
  });

  it("rejects a downgrade whose target would not betray a follower", () => {
    const c = byId(REFUSED);
    c.server.status = 503;
    expect(redirectErrors([c])).toHaveLength(1);
  });

  it("rejects a followed hop that does not expect fetched, or pins a downgrade", () => {
    const c = byId(FOLLOWED);
    c.expected.downgradeTargetRequests = 0;
    expect(redirectErrors([c])).toHaveLength(1);
  });

  it("rejects originScheme without a redirect, and a redirect without originScheme", () => {
    const a = byId("fresh-fetch-200");
    a.given.originScheme = "https";
    const b = byId(FOLLOWED);
    delete b.given.originScheme;
    expect(redirectErrors([a, b])).toHaveLength(2);
  });
});

describe("pendingErrors", () => {
  const manifest = readJson("wire-cases-pending.json") as PendingManifest;
  const consumers: WireConsumer[] = Object.keys(manifest.pending).map((name) => ({
    name,
    readsPending: true,
  }));
  const withEntry = (entry: PendingManifest["pending"][string]): PendingManifest => ({
    pending: { "sdk-go": entry },
  });

  it("the real manifest is clean against its consumers", () => {
    expect(pendingErrors(manifest, corpus, consumers)).toEqual([]);
  });

  it("rejects an entry for a consumer that does not exist", () => {
    expect(
      pendingErrors(
        { pending: { "sdk-gopher": { ticket: "#997", cases: [REFUSED] } } },
        corpus,
        consumers,
      ),
    ).toHaveLength(1);
  });

  it("rejects an entry for a consumer that never reads the pending file", () => {
    const blind = consumers.map((c) => (c.name === "sdk-go" ? { ...c, readsPending: false } : c));
    expect(
      pendingErrors(withEntry({ ticket: "#997", cases: [REFUSED] }), corpus, blind),
    ).toHaveLength(1);
  });

  it("rejects a non-redirect case, an unknown case, a duplicate, an empty entry, a bad ticket", () => {
    for (const entry of [
      { ticket: "#997", cases: ["fresh-fetch-200"] },
      { ticket: "#997", cases: ["no-such-case"] },
      { ticket: "#997", cases: [REFUSED, REFUSED] },
      { ticket: "#997", cases: [] },
      { ticket: "997", cases: [REFUSED] },
    ]) {
      expect(
        pendingErrors(withEntry(entry), corpus, consumers),
        JSON.stringify(entry),
      ).toHaveLength(1);
    }
  });
});
