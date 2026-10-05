// SPDX-License-Identifier: MIT

import type { operations } from "@confeature/contract/api";
import { ExitCode } from "../exit.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import { openReadSession, type ReadDeps, withSession } from "../read.ts";
import { type Column, renderTable } from "../table.ts";

/**
 * `org ls` — list the organizations the active session is a member of
 * (spec 181 / #655, US1). Confeature adds the `org` group on top of ConfigCat's
 * CLI surface because organizations are a first-class concept here.
 *
 * Calls `GET /v1/organizations` (the membership list — Option A) and renders a
 * table of `(id, name)`, or the raw typed array under `--json` (R7). Logged-out
 * short-circuits with "not logged in" and NO network call (R8).
 */

/** The 200 body of `GET /v1/organizations`, from the contract. */
type OrganizationList =
  operations["organizationsList"]["responses"][200]["content"]["application/json"];
type Organization = OrganizationList[number];

const ORG_COLUMNS: Column<Organization>[] = [
  { header: "ID", value: (o) => o.organizationId },
  { header: "NAME", value: (o) => o.name },
];

export async function runOrgLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const session = await openReadSession(ctx, deps);
  const orgs = await withSession(
    session,
    (client) => client.get<OrganizationList>("/v1/organizations"),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(orgs));
    return ExitCode.OK;
  }

  if (orgs.length === 0) {
    ctx.io.out("No organizations found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(ORG_COLUMNS, orgs));
  return ExitCode.OK;
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List organizations.",
  run: (ctx) => runOrgLs(ctx),
};

/** `org` group — Confeature's top-level organization concept (added vs ConfigCat). */
export const orgGroup: Group = {
  name: "org",
  summary: "Manage organizations.",
  commands: new Map([["ls", lsLeaf]]),
};
