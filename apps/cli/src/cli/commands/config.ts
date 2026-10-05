// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";
import type { operations } from "@confeature/contract/api";
import { ExitCode } from "../exit.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import {
  openReadSession,
  type ReadDeps,
  requireName,
  requireOption,
  withSession,
} from "../read.ts";
import { type Column, renderTable } from "../table.ts";
import { renderPairs } from "../pairs.ts";

/**
 * `config ls --product-id <id>` — list the configs of a product (spec 181 /
 * #655, US2). Mirrors ConfigCat's CLI `config ls`.
 *
 * Calls `GET /v1/products/{productId}/configs` and renders `(id, name)`, or the
 * raw typed array under `--json` (R7). A missing `--product-id` is a clear
 * USAGE error naming the option (R9); an empty result prints "no configs" and
 * exits 0 (R10); logged-out short-circuits with NO network call (R8).
 *
 * `config create` / `config delete` (#678) add the structural CRUD leaves,
 * mirroring `configcat-cli`'s `config` group.
 */

type ConfigList = operations["listConfigs"]["responses"][200]["content"]["application/json"];
type Config = ConfigList[number];

// The create / update bodies, threaded from the generated `operations` types so
// the write shapes are build-verified against the contract.
type CreateConfigBody = operations["createConfig"]["requestBody"]["content"]["application/json"];
type CreatedConfig = operations["createConfig"]["responses"][201]["content"]["application/json"];
type UpdateConfigBody = operations["updateConfig"]["requestBody"]["content"]["application/json"];
type UpdatedConfig = operations["updateConfig"]["responses"][200]["content"]["application/json"];

const CONFIG_COLUMNS: Column<Config>[] = [
  { header: "ID", value: (c) => c.configId },
  { header: "NAME", value: (c) => c.name },
];

export async function runConfigLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id"] });
  const productId = requireOption(flags["product-id"], "--product-id", "config ls");

  const session = await openReadSession(ctx, deps);
  const configs = await withSession(
    session,
    (client) => client.get<ConfigList>(`/v1/products/${encodeURIComponent(productId)}/configs`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(configs));
    return ExitCode.OK;
  }

  if (configs.length === 0) {
    ctx.io.out("No configs found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(CONFIG_COLUMNS, configs));
  return ExitCode.OK;
}

/**
 * `config create --product-id <id> --name <name>` — create a config in a
 * product (#678). Mirrors `configcat-cli`'s `config create`.
 *
 * Calls `POST /v1/products/{productId}/configs` with `{ name }`. `--name` is
 * stored TRIMMED and an empty-after-trim name is a USAGE error with NO network
 * call. `--json` prints the created `ConfigModel`; the human surface is a
 * confirmation + (id, name). A missing required option is a USAGE error naming
 * it; logged-out short-circuits with NO network call.
 */
export async function runConfigCreate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id", "name"] });
  const productId = requireOption(flags["product-id"], "--product-id", "config create");
  const name = requireName(flags.name, "config create");

  const session = await openReadSession(ctx, deps);

  const body: CreateConfigBody = { name };
  const created = await withSession(
    session,
    (client) =>
      client.post<CreatedConfig>(
        `/v1/products/${encodeURIComponent(productId)}/configs`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  ctx.io.out(`Created config '${created.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", created.configId],
      ["NAME", created.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `config update --config-id <id> --name <name>` — rename a config (#683).
 * Mirrors `configcat-cli`'s `config update`.
 *
 * Calls `PATCH /v1/configs/{configId}` with `{ name }` — the same PATCH-metadata
 * pattern `flag update` uses (#677). `--name` is required and stored TRIMMED; an
 * empty-after-trim name is a USAGE error with NO network call. `--json` prints
 * the updated `ConfigModel`; the human surface is a confirmation + (id, name). A
 * missing required option is a USAGE error naming it (R9); logged-out
 * short-circuits with NO network call (R8).
 */
export async function runConfigUpdate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "name"] });
  const configId = requireOption(flags["config-id"], "--config-id", "config update");
  const name = requireName(flags.name, "config update");

  const session = await openReadSession(ctx, deps);

  const body: UpdateConfigBody = { name };
  const updated = await withSession(
    session,
    (client) => client.patch<UpdatedConfig>(`/v1/configs/${encodeURIComponent(configId)}`, body),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(updated));
    return ExitCode.OK;
  }

  ctx.io.out(`Updated config '${updated.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", updated.configId],
      ["NAME", updated.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `config delete --config-id <id> [--yes]` — delete a config (#678). Mirrors
 * `configcat-cli`'s `config` group.
 *
 * DESTRUCTIVE: this permanently removes the config and everything under it
 * (settings, sdk-keys). It MUST be confirmed: without `--yes` the command
 * prints a confirmation line and ABORTS (exit 0, NO network call) — the gate is
 * purely the `--yes` flag, so the command stays non-interactive +
 * test-friendly. Calls `DELETE /v1/configs/{configId}`. `--json` prints a small
 * success object. A missing `--config-id` is a USAGE error naming it;
 * logged-out short-circuits with NO network call.
 */
export async function runConfigDelete(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id"], boolean: ["yes"] });
  const configId = requireOption(flags["config-id"], "--config-id", "config delete");

  // Resolve the session FIRST so logged-out still short-circuits with NO network
  // call BEFORE the confirmation gate.
  const session = await openReadSession(ctx, deps);

  if (flags.yes !== true) {
    ctx.io.out(
      `Delete config '${configId}'? This cannot be undone. Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  await withSession(
    session,
    (client) => client.delete<unknown>(`/v1/configs/${encodeURIComponent(configId)}`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify({ configId, deleted: true }));
    return ExitCode.OK;
  }

  ctx.io.out(`Deleted config '${configId}'.`);
  return ExitCode.OK;
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List configs.",
  run: (ctx) => runConfigLs(ctx),
};

const createLeaf: Leaf = {
  name: "create",
  summary: "Create a config (--product-id, --name).",
  run: (ctx) => runConfigCreate(ctx),
};

const updateLeaf: Leaf = {
  name: "update",
  summary: "Rename a config (--config-id, --name).",
  run: (ctx) => runConfigUpdate(ctx),
};

const deleteLeaf: Leaf = {
  name: "delete",
  summary: "Delete a config (requires --yes to confirm).",
  run: (ctx) => runConfigDelete(ctx),
};

/** `config` group — mirrors ConfigCat's CLI `config` group. */
export const configGroup: Group = {
  name: "config",
  summary: "Manage configs.",
  commands: new Map([
    ["ls", lsLeaf],
    ["create", createLeaf],
    ["update", updateLeaf],
    ["delete", deleteLeaf],
  ]),
};
