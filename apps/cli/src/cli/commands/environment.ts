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
 * `environment ls --product-id <id>` — list the environments of a product
 * (spec 181 / #655, US2). Mirrors ConfigCat's CLI `environment ls`.
 *
 * Calls `GET /v1/products/{productId}/environments` and renders `(id, name)`, or
 * the raw typed array under `--json` (R7). A missing `--product-id` is a clear
 * USAGE error naming the option (R9); an empty result prints "no environments"
 * and exits 0 (R10); logged-out short-circuits with NO network call (R8).
 *
 * `environment create` / `environment delete` (#678) add the structural CRUD
 * leaves, mirroring `configcat-cli`'s `environment` group.
 */

type EnvironmentList =
  operations["listEnvironments"]["responses"][200]["content"]["application/json"];
type Environment = EnvironmentList[number];

// The create / update bodies, threaded from the generated `operations` types so
// the write shapes are build-verified against the contract.
type CreateEnvironmentBody =
  operations["createEnvironment"]["requestBody"]["content"]["application/json"];
type CreatedEnvironment =
  operations["createEnvironment"]["responses"][201]["content"]["application/json"];
type UpdateEnvironmentBody =
  operations["updateEnvironment"]["requestBody"]["content"]["application/json"];
type UpdatedEnvironment =
  operations["updateEnvironment"]["responses"][200]["content"]["application/json"];

const ENVIRONMENT_COLUMNS: Column<Environment>[] = [
  { header: "ID", value: (e) => e.environmentId },
  { header: "NAME", value: (e) => e.name },
];

export async function runEnvironmentLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id"] });
  const productId = requireOption(flags["product-id"], "--product-id", "environment ls");

  const session = await openReadSession(ctx, deps);
  const environments = await withSession(
    session,
    (client) =>
      client.get<EnvironmentList>(`/v1/products/${encodeURIComponent(productId)}/environments`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(environments));
    return ExitCode.OK;
  }

  if (environments.length === 0) {
    ctx.io.out("No environments found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(ENVIRONMENT_COLUMNS, environments));
  return ExitCode.OK;
}

/**
 * `environment create --product-id <id> --name <name>` — create an environment
 * in a product (#678). Mirrors `configcat-cli`'s `environment create`.
 *
 * Calls `POST /v1/products/{productId}/environments` with `{ name }`. `--name`
 * is stored TRIMMED and an empty-after-trim name is a USAGE error with NO
 * network call. `--json` prints the created `EnvironmentModel`; the human
 * surface is a confirmation + (id, name). A missing required option is a USAGE
 * error naming it; logged-out short-circuits with NO network call.
 */
export async function runEnvironmentCreate(
  ctx: RunContext,
  deps: ReadDeps = {},
): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id", "name"] });
  const productId = requireOption(flags["product-id"], "--product-id", "environment create");
  const name = requireName(flags.name, "environment create");

  const session = await openReadSession(ctx, deps);

  const body: CreateEnvironmentBody = { name };
  const created = await withSession(
    session,
    (client) =>
      client.post<CreatedEnvironment>(
        `/v1/products/${encodeURIComponent(productId)}/environments`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  ctx.io.out(`Created environment '${created.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", created.environmentId],
      ["NAME", created.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `environment update --environment-id <id> --name <name>` — rename an
 * environment (#683). Mirrors `configcat-cli`'s `environment update`.
 *
 * Calls `PATCH /v1/environments/{environmentId}` with `{ name }` — the same
 * PATCH-metadata pattern `flag update` uses (#677). `--name` is required and
 * stored TRIMMED; an empty-after-trim name is a USAGE error with NO network
 * call. `--json` prints the updated `EnvironmentModel`; the human surface is a
 * confirmation + (id, name). A missing required option is a USAGE error naming
 * it (R9); logged-out short-circuits with NO network call (R8).
 */
export async function runEnvironmentUpdate(
  ctx: RunContext,
  deps: ReadDeps = {},
): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["environment-id", "name"] });
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "environment update",
  );
  const name = requireName(flags.name, "environment update");

  const session = await openReadSession(ctx, deps);

  const body: UpdateEnvironmentBody = { name };
  const updated = await withSession(
    session,
    (client) =>
      client.patch<UpdatedEnvironment>(
        `/v1/environments/${encodeURIComponent(environmentId)}`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(updated));
    return ExitCode.OK;
  }

  ctx.io.out(`Updated environment '${updated.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", updated.environmentId],
      ["NAME", updated.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `environment delete --environment-id <id> [--yes]` — delete an environment
 * (#678). Mirrors `configcat-cli`'s `environment` group.
 *
 * DESTRUCTIVE: this permanently removes the environment and cascades to its
 * setting-values and sdk-keys. It MUST be confirmed: without `--yes` the
 * command prints a confirmation line and ABORTS (exit 0, NO network call) — the
 * gate is purely the `--yes` flag, so the command stays non-interactive +
 * test-friendly. Calls `DELETE /v1/environments/{environmentId}`. `--json`
 * prints a small success object. A missing `--environment-id` is a USAGE error
 * naming it; logged-out short-circuits with NO network call.
 */
export async function runEnvironmentDelete(
  ctx: RunContext,
  deps: ReadDeps = {},
): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["environment-id"], boolean: ["yes"] });
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "environment delete",
  );

  // Resolve the session FIRST so logged-out still short-circuits with NO network
  // call BEFORE the confirmation gate.
  const session = await openReadSession(ctx, deps);

  if (flags.yes !== true) {
    ctx.io.out(
      `Delete environment '${environmentId}'? This cannot be undone. Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  await withSession(
    session,
    (client) => client.delete<unknown>(`/v1/environments/${encodeURIComponent(environmentId)}`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify({ environmentId, deleted: true }));
    return ExitCode.OK;
  }

  ctx.io.out(`Deleted environment '${environmentId}'.`);
  return ExitCode.OK;
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List environments.",
  run: (ctx) => runEnvironmentLs(ctx),
};

const createLeaf: Leaf = {
  name: "create",
  summary: "Create an environment (--product-id, --name).",
  run: (ctx) => runEnvironmentCreate(ctx),
};

const updateLeaf: Leaf = {
  name: "update",
  summary: "Rename an environment (--environment-id, --name).",
  run: (ctx) => runEnvironmentUpdate(ctx),
};

const deleteLeaf: Leaf = {
  name: "delete",
  summary: "Delete an environment (requires --yes to confirm).",
  run: (ctx) => runEnvironmentDelete(ctx),
};

/** `environment` group — mirrors ConfigCat's CLI `environment` group. */
export const environmentGroup: Group = {
  name: "environment",
  summary: "Manage environments.",
  commands: new Map([
    ["ls", lsLeaf],
    ["create", createLeaf],
    ["update", updateLeaf],
    ["delete", deleteLeaf],
  ]),
};
