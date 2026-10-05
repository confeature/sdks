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
 * `product ls` — list products across ALL of the user's organizations
 * (spec 181 / #655, US1, Option A). Mirrors ConfigCat's CLI `product ls`, plus a
 * cross-org **ORG** column.
 *
 * It first reads the membership list (`GET /v1/organizations`), then fetches
 * `GET /v1/products?organizationId=<id>` for each org and concatenates the
 * results — one call per org, bounded by the user's membership count. There is
 * NO active-org selection: every product the user can reach appears, each row
 * labelled with its owning org. `--json` emits the aggregated array (R7);
 * logged-out short-circuits with "not logged in", NO network call (R8).
 *
 * `product create` / `product delete` (#678) add the structural CRUD leaves,
 * mirroring `configcat-cli`'s `product` group.
 */

type OrganizationList =
  operations["organizationsList"]["responses"][200]["content"]["application/json"];
type ProductList = operations["listProducts"]["responses"][200]["content"]["application/json"];
type Product = ProductList[number];

// The create / update bodies, threaded from the generated `operations` types so
// the write shapes are build-verified against the contract.
type CreateProductBody = operations["createProduct"]["requestBody"]["content"]["application/json"];
type CreatedProduct = operations["createProduct"]["responses"][201]["content"]["application/json"];
type UpdateProductBody = operations["updateProduct"]["requestBody"]["content"]["application/json"];
type UpdatedProduct = operations["updateProduct"]["responses"][200]["content"]["application/json"];

const PRODUCT_COLUMNS: Column<Product>[] = [
  { header: "ID", value: (p) => p.productId },
  { header: "NAME", value: (p) => p.name },
  { header: "ORG", value: (p) => p.organization.name },
];

export async function runProductLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const session = await openReadSession(ctx, deps);

  const products = await withSession(session, async (client) => {
    const orgs = await client.get<OrganizationList>("/v1/organizations");
    const aggregated: Product[] = [];
    // Sequential (not Promise.all) by design: the management API is token-keyed
    // rate-limited (spec 180), and a user's membership count is small (1–a
    // handful) in v1, so serialising the per-org fetches avoids a burst against
    // the limiter at negligible latency cost. Revisit if membership counts grow
    // large enough that wall-time dominates.
    for (const org of orgs) {
      const query = `?organizationId=${encodeURIComponent(org.organizationId)}`;
      const owned = await client.get<ProductList>(`/v1/products${query}`);
      aggregated.push(...owned);
    }
    return aggregated;
  });

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(products));
    return ExitCode.OK;
  }

  if (products.length === 0) {
    ctx.io.out("No products found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(PRODUCT_COLUMNS, products));
  return ExitCode.OK;
}

/**
 * `product create --name <name>` — create a product in the caller's active
 * organization (#678). Mirrors `configcat-cli`'s `product create`.
 *
 * Calls `POST /v1/products` with `{ name }`. `--name` is stored TRIMMED and an
 * empty-after-trim name is a USAGE error with NO network call (the same
 * trimming discipline `flag create` uses). `--json` prints the created
 * `ProductModel`; the human surface is a confirmation + (id, name). A missing
 * `--name` is a USAGE error naming it; logged-out short-circuits with NO
 * network call.
 */
export async function runProductCreate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["name"] });
  const name = requireName(flags.name, "product create");

  const session = await openReadSession(ctx, deps);

  const body: CreateProductBody = { name };
  const created = await withSession(
    session,
    (client) => client.post<CreatedProduct>("/v1/products", body),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  ctx.io.out(`Created product '${created.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", created.productId],
      ["NAME", created.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `product update --product-id <id> --name <name>` — rename a product (#683).
 * Mirrors `configcat-cli`'s `product update`.
 *
 * Calls `PATCH /v1/products/{productId}` with `{ name }` — the same
 * PATCH-metadata pattern `flag update` uses (#677). `--name` is required and
 * stored TRIMMED; an empty-after-trim name is a USAGE error with NO network call
 * (a blank name never reaches the server). `--json` prints the updated
 * `ProductModel`; the human surface is a confirmation + (id, name). A missing
 * `--product-id` / `--name` is a USAGE error naming it (R9); logged-out
 * short-circuits with NO network call (R8).
 */
export async function runProductUpdate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id", "name"] });
  const productId = requireOption(flags["product-id"], "--product-id", "product update");
  const name = requireName(flags.name, "product update");

  const session = await openReadSession(ctx, deps);

  const body: UpdateProductBody = { name };
  const updated = await withSession(
    session,
    (client) => client.patch<UpdatedProduct>(`/v1/products/${encodeURIComponent(productId)}`, body),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(updated));
    return ExitCode.OK;
  }

  ctx.io.out(`Updated product '${updated.name}'.`);
  ctx.io.out(
    renderPairs([
      ["ID", updated.productId],
      ["NAME", updated.name],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `product delete --product-id <id> [--yes]` — delete a product (#678).
 * Mirrors `configcat-cli`'s `product` group.
 *
 * DESTRUCTIVE: this permanently removes the product and everything under it
 * (configs, environments, flags). It MUST be confirmed: without `--yes` the
 * command prints a confirmation line and ABORTS (exit 0, NO network call) — the
 * gate is purely the `--yes` flag, so the command stays non-interactive +
 * test-friendly (it never blocks on stdin). Calls `DELETE
 * /v1/products/{productId}`. `--json` prints a small success object. A missing
 * `--product-id` is a USAGE error naming it; logged-out short-circuits with NO
 * network call.
 */
export async function runProductDelete(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["product-id"], boolean: ["yes"] });
  const productId = requireOption(flags["product-id"], "--product-id", "product delete");

  // Resolve the session FIRST so logged-out still short-circuits with NO network
  // call BEFORE the confirmation gate — a logged-out delete must never even
  // print the "would delete" line.
  const session = await openReadSession(ctx, deps);

  // Confirmation gate: without `--yes`, abort with a clear instruction and make
  // NO network call. Exit 0 — an unconfirmed delete is not an error, just a
  // no-op the operator chose by omitting the flag.
  if (flags.yes !== true) {
    ctx.io.out(
      `Delete product '${productId}'? This cannot be undone. Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  await withSession(
    session,
    (client) => client.delete<unknown>(`/v1/products/${encodeURIComponent(productId)}`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify({ productId, deleted: true }));
    return ExitCode.OK;
  }

  ctx.io.out(`Deleted product '${productId}'.`);
  return ExitCode.OK;
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List products.",
  run: (ctx) => runProductLs(ctx),
};

const createLeaf: Leaf = {
  name: "create",
  summary: "Create a product (--name).",
  run: (ctx) => runProductCreate(ctx),
};

const updateLeaf: Leaf = {
  name: "update",
  summary: "Rename a product (--product-id, --name).",
  run: (ctx) => runProductUpdate(ctx),
};

const deleteLeaf: Leaf = {
  name: "delete",
  summary: "Delete a product (requires --yes to confirm).",
  run: (ctx) => runProductDelete(ctx),
};

/** `product` group — mirrors ConfigCat's CLI `product` group. */
export const productGroup: Group = {
  name: "product",
  summary: "Manage products.",
  commands: new Map([
    ["ls", lsLeaf],
    ["create", createLeaf],
    ["update", updateLeaf],
    ["delete", deleteLeaf],
  ]),
};
