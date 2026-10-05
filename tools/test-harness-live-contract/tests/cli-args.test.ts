// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BadArgs, parseArgs } from "../src/cli-args.js";

describe("CLI arguments (#783)", () => {
  it("--corpus-seed is a flag, and --seed with it is refused", () => {
    expect(parseArgs(["--corpus-seed"]).corpusSeed).toBe(true);
    expect(() => parseArgs(["--seed", "x.json", "--corpus-seed"])).toThrow(BadArgs);
    expect(() => parseArgs(["--corpus-seed", "--seed", "x.json"])).toThrow(/mutually exclusive/);
  });

  it("--exec takes everything after -- as the command", () => {
    const args = parseArgs(["--corpus-seed", "--exec", "--", "uv", "run", "pytest", "--seed", "1"]);
    expect(args.exec).toEqual(["uv", "run", "pytest", "--seed", "1"]);
    expect(args.seed).toBeUndefined(); // the command's own flags are not ours
  });

  it.each([[["--exec"]], [["--exec", "pytest"]], [["--exec", "--"]]])(
    "refuses a malformed --exec: %j",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(BadArgs);
    },
  );

  it.each([
    [["--nope"], /unknown argument/],
    [["--port", "70000"], /--port/],
    [["--port", "1.5"], /--port/],
    [["--bind", "0.0.0.0"], /--bind/],
    [["--shutdown-grace", "0"], /--shutdown-grace/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
