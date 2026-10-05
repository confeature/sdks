// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";
import type { operations } from "@confeature/contract/api";
import { ApiError } from "../../api/client.ts";
import { CliError } from "../errors.ts";
import { ExitCode } from "../exit.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import { openReadSession, type ReadDeps, requireOption, withSession } from "../read.ts";
import { type Column, renderTable } from "../table.ts";

/**
 * `sdk-key` group (#683) — read, generate and delete the SDK keys of a
 * config-in-environment. Mirrors `configcat-cli`'s `sdk-key` group; `rotate` and
 * `delete` are additive extensions — ConfigCat's Management API only reads keys,
 * and generating or deleting one is a dashboard action there (#786).
 *
 * Every leaf is scoped to a (config, environment) pair, which is how ConfigCat
 * keys an SDK key: each Config in each Environment has its own primary +
 * optional secondary key. Rotating is ConfigCat's three steps: generate a
 * secondary (`rotate`), move the apps to it, then `delete` the old key.
 */

// The SDK-keys model — `primary` (string) + `secondary` (string | null) — and the
// 200 bodies, threaded from the generated `operations` types so the read/write
// shapes are build-verified against the contract.
type SdkKeys = operations["getSdkKeys"]["responses"][200]["content"]["application/json"];
type RotatedSdkKeys = operations["rotateSdkKeys"]["responses"][200]["content"]["application/json"];

/** A (slot, key) row for the human table — `secondary` may be empty. */
interface SdkKeyRow {
  slot: string;
  key: string;
}

const SDK_KEY_COLUMNS: Column<SdkKeyRow>[] = [
  { header: "SLOT", value: (r) => r.slot },
  { header: "KEY", value: (r) => r.key },
];

/** Project a {@link SdkKeys} model into the (slot, key) rows the table renders. */
function sdkKeyRows(keys: SdkKeys): SdkKeyRow[] {
  const rows: SdkKeyRow[] = [{ slot: "PRIMARY", key: keys.primary }];
  if (keys.secondary !== null) {
    rows.push({ slot: "SECONDARY", key: keys.secondary });
  }
  return rows;
}

/**
 * `sdk-key ls --config-id <id> --environment-id <id>` — list the SDK keys
 * (primary + optional secondary) for a config in an environment (#683). Mirrors
 * `configcat-cli`'s `sdk-key` listing.
 *
 * Calls `GET /v1/configs/{configId}/environments/{environmentId}` (the parity
 * `getSdkKeys` route — NO `/sdk-keys` suffix) and renders a (slot, key) table,
 * or the raw typed `SdkKeysModel` under `--json` (R7). A missing required option
 * is a clear USAGE error naming it (R9); logged-out short-circuits with NO
 * network call (R8).
 */
export async function runSdkKeyLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "environment-id"] });
  const configId = requireOption(flags["config-id"], "--config-id", "sdk-key ls");
  const environmentId = requireOption(flags["environment-id"], "--environment-id", "sdk-key ls");

  const session = await openReadSession(ctx, deps);
  const keys = await withSession(
    session,
    (client) =>
      client.get<SdkKeys>(
        `/v1/configs/${encodeURIComponent(configId)}/environments/${
          encodeURIComponent(environmentId)
        }`,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(keys));
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(SDK_KEY_COLUMNS, sdkKeyRows(keys)));
  return ExitCode.OK;
}

/**
 * `sdk-key rotate --config-id <id> --environment-id <id> [--yes]` — generate the
 * secondary SDK key for a config in an environment, the first step of a
 * rotation (#683, #786). Confeature extension — `configcat-cli` has no such
 * command (ConfigCat generates keys in its dashboard).
 *
 * The primary keeps working; nothing is invalidated. While a secondary exists
 * the API refuses (409 `secondary_exists`) — as in ConfigCat there is no third
 * key — and the command says to `sdk-key delete` one first. It keeps the
 * confirm discipline of #677/#678: without `--yes` it prints a confirmation
 * line and ABORTS (exit 0, NO network call) — the gate is purely the flag, so
 * the command never blocks on stdin. Calls
 * `POST /v1/configs/{configId}/environments/{environmentId}/sdk-keys/rotate`
 * (a bodiless POST). `--json` prints the new `SdkKeysModel`. A missing required
 * option is a USAGE error naming it (R9); logged-out short-circuits with NO
 * network call (R8) — the session is resolved BEFORE the confirmation gate.
 */
export async function runSdkKeyRotate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, {
    string: ["config-id", "environment-id"],
    boolean: ["yes"],
  });
  const configId = requireOption(flags["config-id"], "--config-id", "sdk-key rotate");
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "sdk-key rotate",
  );

  // Resolve the session FIRST so logged-out still short-circuits with NO network
  // call BEFORE the confirmation gate (R8) — a logged-out rotate must never even
  // print the "would rotate" line.
  const session = await openReadSession(ctx, deps);

  // Confirmation gate: without `--yes`, abort with a clear instruction and make
  // NO network call. Exit 0 — an unconfirmed rotate is not an error, just a no-op
  // the operator chose by omitting the flag.
  if (flags.yes !== true) {
    ctx.io.out(
      `Generate a secondary SDK key for config '${configId}' in environment ` +
        `'${environmentId}'? The primary key keeps working until you delete it. ` +
        `Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  const rotated = await withSession(
    session,
    (client) =>
      client.post<RotatedSdkKeys>(
        `/v1/configs/${encodeURIComponent(configId)}/environments/${
          encodeURIComponent(environmentId)
        }/sdk-keys/rotate`,
      ),
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      throw new CliError(
        "A secondary SDK key already exists, and there is no third key. Delete one first: " +
          `confeature sdk-key delete <primary|secondary> --config-id ${configId} ` +
          `--environment-id ${environmentId} --yes`,
        ExitCode.RUNTIME,
      );
    }
    throw error;
  });

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(rotated));
    return ExitCode.OK;
  }

  ctx.io.out("Generated a secondary SDK key. Move your apps to it, then delete the old key.");
  ctx.io.out(renderTable(SDK_KEY_COLUMNS, sdkKeyRows(rotated)));
  return ExitCode.OK;
}

const SLOTS = ["primary", "secondary"] as const;
type Slot = (typeof SLOTS)[number];

/**
 * `sdk-key delete <primary|secondary> --config-id <id> --environment-id <id>
 * [--yes]` — delete an SDK key, the last step of a rotation (#786). Confeature
 * extension — ConfigCat deletes keys in its dashboard.
 *
 * DESTRUCTIVE: the deleted key stops working — the CDN answers 403 within about
 * 60 s, and no later publish brings it back. Deleting the primary promotes the
 * secondary. The only key cannot be deleted (409 `only_key`). Same confirm
 * discipline as `rotate`: without `--yes` it aborts (exit 0, NO network call).
 * Calls `DELETE .../sdk-keys/{slot}`; `--json` prints the remaining
 * `SdkKeysModel`.
 */
export async function runSdkKeyDelete(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, {
    string: ["config-id", "environment-id"],
    boolean: ["yes"],
  });
  const slot = String(flags._[0] ?? "");
  if (!(SLOTS as readonly string[]).includes(slot)) {
    throw new CliError(
      `sdk-key delete: name the key to delete — primary or secondary (got '${slot}').`,
      ExitCode.USAGE,
    );
  }
  const configId = requireOption(flags["config-id"], "--config-id", "sdk-key delete");
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "sdk-key delete",
  );

  // Session first: logged-out short-circuits before the gate, with no network (R8).
  const session = await openReadSession(ctx, deps);

  if (flags.yes !== true) {
    ctx.io.out(
      `Delete the ${slot} SDK key of config '${configId}' in environment '${environmentId}'? ` +
        `Apps still using it stop receiving the config within about 60 s. ` +
        `Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  const remaining = await withSession(
    session,
    (client) =>
      client.delete<SdkKeys>(
        `/v1/configs/${encodeURIComponent(configId)}/environments/${
          encodeURIComponent(environmentId)
        }/sdk-keys/${slot as Slot}`,
      ),
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      throw new CliError(
        "This is the only SDK key, and it cannot be deleted. Generate a secondary first: " +
          `confeature sdk-key rotate --config-id ${configId} --environment-id ${environmentId} --yes`,
        ExitCode.RUNTIME,
      );
    }
    throw error;
  });

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(remaining));
    return ExitCode.OK;
  }

  ctx.io.out(`Deleted the ${slot} SDK key.`);
  ctx.io.out(renderTable(SDK_KEY_COLUMNS, sdkKeyRows(remaining)));
  return ExitCode.OK;
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List SDK keys for a config-in-environment (--config-id, --environment-id).",
  run: (ctx) => runSdkKeyLs(ctx),
};

const rotateLeaf: Leaf = {
  name: "rotate",
  summary: "Generate the secondary SDK key of a config-in-environment (requires --yes).",
  run: (ctx) => runSdkKeyRotate(ctx),
};

const deleteLeaf: Leaf = {
  name: "delete",
  summary: "Delete the primary or secondary SDK key of a config-in-environment (requires --yes).",
  run: (ctx) => runSdkKeyDelete(ctx),
};

/** `sdk-key` group — mirrors ConfigCat's CLI `sdk-key` group. */
export const sdkKeyGroup: Group = {
  name: "sdk-key",
  summary: "Manage SDK keys.",
  commands: new Map([
    ["ls", lsLeaf],
    ["rotate", rotateLeaf],
    ["delete", deleteLeaf],
  ]),
};
