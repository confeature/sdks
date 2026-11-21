// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";

import { checkedFixtureOrigin, configPath, guardedFetch } from "./fixture.ts";

const origin = "http://127.0.0.1:4133";
const expected = `${origin}${configPath}`;

it.each([undefined, "", "https://127.0.0.1:4133", "http://localhost:4133", `${origin}/`])(
  "rejects missing or noncanonical fixture origins (%s)",
  (base) => {
    expect(() => checkedFixtureOrigin(base)).toThrow();
    expect(checkedFixtureOrigin(origin)).toBe(origin);
  },
);

it("blocks another host, a changed path, credentials, and a changed query before fetch", async () => {
  const transport = vi.fn<typeof fetch>();
  const fetchConfig = guardedFetch(expected, transport);
  for (const url of [
    `http://127.0.0.1:4134${configPath}`,
    `${origin}/different`,
    `http://name:password@127.0.0.1:4133${configPath}`,
    `${expected}&extra=1`,
  ]) {
    await expect(fetchConfig(url)).rejects.toThrow("Unexpected fixture request URL.");
  }
  expect(transport).not.toHaveBeenCalled();
});

it("refuses to follow even a same-origin redirect", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response("redirect", { status: 302, headers: { Location: `${origin}/different` } }),
    );
  await expect(guardedFetch(expected, transport)(expected, { redirect: "follow" })).rejects.toThrow(
    "Fixture redirect refused.",
  );
  expect(transport).toHaveBeenCalledExactlyOnceWith(expected, { redirect: "manual" });
});
