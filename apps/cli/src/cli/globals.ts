// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";

/**
 * The global flags recognised at every level of the command tree, parsed
 * before group/leaf dispatch (contract: "Global flags").
 *
 * `--help`/`--version` short-circuit in the router; `--json`/`--profile`/
 * `--api-url` flow into the leaf via the run context.
 */
export interface Globals {
  /** `--help` / `-h`. */
  help: boolean;
  /** `--version` / `-V`. */
  version: boolean;
  /** `--json` — emit machine-readable output where a command emits data. */
  outputJson: boolean;
  /** `--profile <name>` — select a named profile (undefined name → usage error). */
  profile?: string;
  /** `--api-url <url>` — override the management API base URL (highest precedence). */
  apiUrl?: string;
}

/** Result of parsing argv: the resolved {@link Globals} plus the positional path. */
export interface ParsedArgs {
  globals: Globals;
  /** Positional argv (the `<group> <leaf> …` path) with global flags removed. */
  positionals: string[];
}

/**
 * Parse global flags out of `argv`, returning the resolved globals and the
 * remaining positional path. Global flags are recognised wherever they appear
 * (C16) — `parseArgs` collects them regardless of position — and take
 * precedence over leaf args at parse time.
 *
 * Unknown flags are tolerated here (collected, ignored): the router decides
 * usage errors based on the positional path, and later slices own per-leaf
 * flag validation.
 */
export function parseGlobals(argv: string[]): ParsedArgs {
  const parsed = parseArgs(argv, {
    boolean: ["help", "version", "json"],
    string: ["profile", "api-url"],
    alias: { h: "help", V: "version" },
  });

  const positionals = parsed._.map((value) => String(value));

  const globals: Globals = {
    help: parsed.help === true,
    version: parsed.version === true,
    outputJson: parsed.json === true,
  };

  if (typeof parsed.profile === "string") {
    globals.profile = parsed.profile;
  }
  if (typeof parsed["api-url"] === "string") {
    globals.apiUrl = parsed["api-url"];
  }

  return { globals, positionals };
}
