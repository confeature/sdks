// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import { checkedFixtureOrigin, guardedFetch } from "./fixture.ts";

describe("fixture transport", () => {
  it.each([
    undefined,
    "",
    "https://127.0.0.1:41000",
    "http://localhost:41000",
    "http://127.0.0.1:41000/config",
    "http://127.0.0.1:41000@other.invalid:41000",
    "http://127.0.0.1:65536",
  ])("refuses unsafe or missing fixture input %s", (base) => {
    expect(() => checkedFixtureOrigin(base)).toThrow();
  });

  it("blocks a nonfixture origin before transport", async () => {
    const transport = vi.fn<typeof fetch>();
    const fetchFixture = guardedFetch(checkedFixtureOrigin("http://127.0.0.1:41000"), transport);
    await expect(fetchFixture("http://127.0.0.1:41001/config")).rejects.toThrow(
      "Fixture request refused outside the bound origin.",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("forces a manual request and rejects a redirect before following it", async () => {
    const location = "https://other.invalid/config";
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.redirect(location));
    const fetchFixture = guardedFetch(checkedFixtureOrigin("http://127.0.0.1:41000"), transport);
    const input = new Request("http://127.0.0.1:41000/config", { redirect: "follow" });
    await expect(fetchFixture(input, { redirect: "follow" })).rejects.toThrow(
      "Fixture redirect refused.",
    );
    expect(transport).toHaveBeenCalledExactlyOnceWith(input, { redirect: "manual" });
  });
});
