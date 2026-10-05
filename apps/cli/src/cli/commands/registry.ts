// SPDX-License-Identifier: MIT

import type { ExitCode } from "../exit.ts";
import type { Globals } from "../globals.ts";
import type { Io } from "../io.ts";
import { orgGroup } from "./org.ts";
import { productGroup } from "./product.ts";
import { configGroup } from "./config.ts";
import { environmentGroup } from "./environment.ts";
import { flagGroup } from "./flag.ts";
import { sdkKeyGroup } from "./sdk-key.ts";
import { memberGroup } from "./member.ts";
import { whoamiCommand } from "./whoami.ts";
import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";

/**
 * The runtime context handed to every leaf's `run`. Holds the parsed global
 * flags plus the argv that remains after the group/leaf path was consumed.
 *
 * Later slices (#654/#655/#656) extend this with a resolved effective config
 * and an API client; the scaffold keeps it minimal and offline.
 */
export interface RunContext {
  /** Parsed global flags (`--json`, `--profile`, `--api-url`, …). */
  globals: Globals;
  /** Argv remaining after the matched group + leaf names were consumed. */
  args: string[];
  /** Output sinks — leaves write through these so output is captured in tests. */
  io: Io;
}

/** A terminal command — the thing that does work. */
export interface Leaf {
  name: string;
  summary: string;
  run(ctx: RunContext): Promise<ExitCode>;
}

/** A command group (e.g. `flag`) holding one or more leaf commands. */
export interface Group {
  name: string;
  summary: string;
  commands: Map<string, Leaf>;
}

/**
 * The full command registry: the named groups plus top-level leaf commands
 * (currently only `whoami`). Populated by `buildRegistry()` so the unit tests
 * can construct it deterministically.
 */
export interface Registry {
  groups: Map<string, Group>;
  topLevel: Map<string, Leaf>;
}

/**
 * Build the command registry: the ConfigCat-mirrored groups (`org` added for
 * Confeature) plus the top-level `login` / `logout` / `whoami` commands. The
 * group leaves are the real read commands (the per-group `ls`, spec 181 /
 * #655) and the `flag value` show/update pair (spec 182 / #656); the auth
 * commands are real (spec 180 / #654).
 */
export function buildRegistry(): Registry {
  const groups = new Map<string, Group>(
    [orgGroup, productGroup, configGroup, environmentGroup, flagGroup, sdkKeyGroup, memberGroup]
      .map((g) => [g.name, g]),
  );
  const topLevel = new Map<string, Leaf>(
    [loginCommand, logoutCommand, whoamiCommand].map((c) => [c.name, c]),
  );
  return { groups, topLevel };
}
