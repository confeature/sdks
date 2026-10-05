// SPDX-License-Identifier: MIT

import { buildRegistry } from "./cli/commands/registry.ts";
import { route } from "./cli/router.ts";

/**
 * Entrypoint: read `Deno.args`, dispatch through the router against the command
 * registry, and exit with the returned code (data-model exit-code table).
 */
async function main(): Promise<void> {
  const registry = buildRegistry();
  const code = await route(Deno.args, registry);
  Deno.exit(code);
}

if (import.meta.main) {
  await main();
}
