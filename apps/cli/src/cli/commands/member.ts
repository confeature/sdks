// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";
import type { operations } from "@confeature/contract/api";
import { ExitCode } from "../exit.ts";
import { CliError } from "../errors.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import { openReadSession, type ReadDeps, requireOption, withSession } from "../read.ts";
import { type Column, renderTable } from "../table.ts";
import { renderPairs } from "../pairs.ts";

/**
 * `member` group (#684, epic #676) — list organization members + manage member
 * invitations, at `configcat-cli` `member` parity. PURE CLI wiring over endpoints
 * that already exist (`organizationsMembersList`, `createInvite`,
 * `listInvitations`, `deleteInvitation`); no contract/API change.
 *
 * The group has one `invitation` SUB-group (dispatched leaf), mirroring the
 * `flag value <show|update>` two-level pattern: the `invitation` leaf consumes
 * the first positional as the sub-command (`ls` / `rm`) and forwards the rest.
 *
 * PARITY DEVIATION (documented): `member invite` maps to `createInvite` =
 * `POST /v1/users/invite`, which takes NO org parameter (its generated
 * `operations` type is `path?: never; query?: never`) — invitations are scoped
 * to the caller's session organization server-side. So `member invite` does NOT
 * expose `--org-id` (a phantom flag that went nowhere would mislead operators).
 * `member ls` / `member invitation ls` keep `--org-id` because their endpoints
 * are genuinely org-path-scoped.
 */

// ── members ──────────────────────────────────────────────────────────────────

type OrganizationMembers =
  operations["organizationsMembersList"]["responses"][200]["content"]["application/json"];
type OrganizationAdmin = OrganizationMembers["admins"][number];
type OrganizationMember = OrganizationMembers["members"][number];

// ── invitations ──────────────────────────────────────────────────────────────

type InvitationList =
  operations["listInvitations"]["responses"][200]["content"]["application/json"];
type Invitation = InvitationList[number];

// The invite request body + 201 entries, threaded from the generated
// `operations` types so the write shape is build-verified against the contract.
type InviteMembersBody = operations["createInvite"]["requestBody"]["content"]["application/json"];
type InviteResult = operations["createInvite"]["responses"][201]["content"]["application/json"];

/**
 * A flattened (role, id, name, email) member row for the human table. The three
 * server buckets (`admins`, `billingManagers`, `members`) are projected into one
 * list labelled with their role so `member ls` reads as a single roster.
 */
interface MemberRow {
  role: string;
  userId: string;
  fullName: string;
  email: string;
}

const MEMBER_COLUMNS: Column<MemberRow>[] = [
  { header: "ROLE", value: (r) => r.role },
  { header: "USER ID", value: (r) => r.userId },
  { header: "NAME", value: (r) => r.fullName },
  { header: "EMAIL", value: (r) => r.email },
];

/** Project the three role buckets into one flat, role-labelled roster. */
function memberRows(members: OrganizationMembers): MemberRow[] {
  // All three buckets share the same row fields (an `OrganizationMember` carries
  // an extra `permissions`, structurally assignable here) — one helper covers all.
  const toRow =
    (role: string) => (m: { userId: string; fullName: string; email: string }): MemberRow => ({
      role,
      userId: m.userId,
      fullName: m.fullName,
      email: m.email,
    });
  return [
    ...members.admins.map(toRow("ADMIN")),
    ...members.billingManagers.map(toRow("BILLING")),
    ...members.members.map(toRow("MEMBER")),
  ];
}

const INVITATION_COLUMNS: Column<Invitation>[] = [
  { header: "INVITATION ID", value: (i) => i.invitationId },
  { header: "EMAIL", value: (i) => i.email },
  { header: "CREATED", value: (i) => i.createdAt },
  { header: "EXPIRED", value: (i) => (i.expired ? "yes" : "no") },
];

/**
 * `member ls --org-id <id>` — list the members (admins + billing managers +
 * members) of an organization (#684). Mirrors `configcat-cli`'s `member ls`.
 *
 * Calls `GET /v1/organizations/{organizationId}/members` (the `OrganizationMembersModel`
 * three-bucket shape) and renders a role-labelled `(role, user id, name, email)`
 * table, or the raw typed model under `--json` (R7). A missing `--org-id` is a
 * clear USAGE error naming it (R9); logged-out short-circuits with NO network
 * call (R8).
 */
export async function runMemberLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["org-id"] });
  const organizationId = requireOption(flags["org-id"], "--org-id", "member ls");

  const session = await openReadSession(ctx, deps);
  const members = await withSession(
    session,
    (client) =>
      client.get<OrganizationMembers>(
        `/v1/organizations/${encodeURIComponent(organizationId)}/members`,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(members));
    return ExitCode.OK;
  }

  const rows = memberRows(members);
  if (rows.length === 0) {
    ctx.io.out("No members found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(MEMBER_COLUMNS, rows));
  return ExitCode.OK;
}

/**
 * `member invite --email <e> [--email <e2> …] [--permission-group <id>]` —
 * invite one or more members in a single call (#684). Mirrors `configcat-cli`'s
 * `member invite`.
 *
 * Calls `POST /v1/users/invite` with `{ emails, permissionGroupId }`. `--email`
 * is REPEATABLE — every occurrence is collected into the `emails` array the body
 * expects (`InviteMembersRequest`). `--permission-group` is OPTIONAL (the only
 * value Confeature v1 accepts is `0`, a placeholder; omitting it defaults to 0).
 *
 * PARITY: this endpoint takes NO org-id (the invitation is scoped to the
 * session's organization server-side), so — unlike `member ls` — there is no
 * `--org-id` flag here. At least one `--email` is required (else a USAGE error
 * with NO network call). `--json` prints the 201 array of `{ email, invite_token,
 * expires_at }` entries; logged-out short-circuits with NO network call (R8).
 *
 * SECURITY: the per-email `invite_token` is sensitive — but it is the WHOLE point
 * of the command's output (Confeature has no server-side email delivery, so the
 * operator relays each token), so it IS printed by design, exactly like the back
 * office shows it once. The bearer token is NEVER printed.
 */
export async function runMemberInvite(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, {
    // `email` is declared a `string` flag AND `collect`ed so a repeated flag
    // yields a string[] and an ABSENT flag defaults to `[]` (collect-without-
    // string would leave it `undefined`).
    string: ["email", "permission-group"],
    collect: ["email"],
  });

  // `--email` is repeatable; `collect` yields a string[] (empty when the flag is
  // absent). Trim + drop blanks so `--email "  "` never reaches the wire.
  const emails = (flags.email as string[])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (emails.length === 0) {
    throw new CliError(
      "member invite: missing required option `--email`. " +
        "Usage: confeature member invite --email <addr> [--email <addr> …] " +
        "[--permission-group <id>]",
      ExitCode.USAGE,
    );
  }

  // `--permission-group` is optional. Confeature v1 accepts only `0`; a
  // non-integer or non-zero value is a USAGE error BEFORE any network call (the
  // server re-validates as defence in depth → 400).
  const permissionGroupId = parsePermissionGroup(flags["permission-group"]);

  const session = await openReadSession(ctx, deps);

  const body: InviteMembersBody = { emails, permissionGroupId };
  const created = await withSession(
    session,
    (client) => client.post<InviteResult>("/v1/users/invite", body),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  ctx.io.out(`Invited ${created.length} member${created.length === 1 ? "" : "s"}.`);
  // One (email, token, expires) trio per invitee — the token is shown once here
  // for the operator to relay (no server-side email delivery in Confeature).
  for (const entry of created) {
    ctx.io.out(
      renderPairs([
        ["EMAIL", entry.email],
        ["INVITE TOKEN", entry.invite_token],
        ["EXPIRES AT", String(entry.expires_at)],
      ]),
    );
  }
  return ExitCode.OK;
}

/** Narrow `--permission-group` to the v1-accepted `0`, or USAGE-reject it. */
function parsePermissionGroup(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return 0;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new CliError(
      `member invite: '${trimmed}' is not a valid --permission-group (expected an integer).`,
      ExitCode.USAGE,
    );
  }
  if (parsed !== 0) {
    throw new CliError(
      "member invite: --permission-group must be 0 — Confeature v1 has no " +
        "permission-groups feature yet (the value is a placeholder).",
      ExitCode.USAGE,
    );
  }
  return 0;
}

/**
 * `member invitation ls --org-id <id>` — list the pending invitations of an
 * organization (#684). Mirrors `configcat-cli`'s invitation listing.
 *
 * Calls `GET /v1/organizations/{organizationId}/invitations` (a bare array of
 * `InvitationModel`) and renders `(invitation id, email, created, expired)`, or
 * the raw typed array under `--json` (R7). A missing `--org-id` is a clear USAGE
 * error naming it (R9); logged-out short-circuits with NO network call (R8).
 */
export async function runInvitationLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["org-id"] });
  const organizationId = requireOption(flags["org-id"], "--org-id", "member invitation ls");

  const session = await openReadSession(ctx, deps);
  const invitations = await withSession(
    session,
    (client) =>
      client.get<InvitationList>(
        `/v1/organizations/${encodeURIComponent(organizationId)}/invitations`,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(invitations));
    return ExitCode.OK;
  }

  if (invitations.length === 0) {
    ctx.io.out("No invitations found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(INVITATION_COLUMNS, invitations));
  return ExitCode.OK;
}

/**
 * `member invitation rm --invitation-id <id> [--yes]` — revoke a pending
 * invitation (#684). Mirrors `configcat-cli`'s invitation removal.
 *
 * DESTRUCTIVE: this permanently revokes the invitation; its token can no longer
 * be redeemed. It MUST be confirmed: without `--yes` the command prints a
 * confirmation line and ABORTS (exit 0, NO network call) — the gate is purely the
 * `--yes` flag, so the command stays non-interactive + test-friendly (it never
 * blocks on stdin). Calls `DELETE /v1/invitations/{invitationId}` (204 no
 * content). `--json` prints a small success object. A missing `--invitation-id`
 * is a USAGE error naming it (R9); logged-out short-circuits with NO network call
 * (R8). Ordering: the cheap `--invitation-id` presence check runs first, then the
 * session is resolved BEFORE the `--yes` confirmation gate — neither path makes a
 * network call, so a logged-out or unconfirmed revoke is always a clean no-op.
 */
export async function runInvitationRm(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["invitation-id"], boolean: ["yes"] });
  const invitationId = requireOption(
    flags["invitation-id"],
    "--invitation-id",
    "member invitation rm",
  );

  // Resolve the session before the `--yes` gate so a logged-out caller
  // short-circuits (NotLoggedInError) with NO network call BEFORE the prompt —
  // never printing the "would revoke" line. (The `--invitation-id` presence
  // check above already ran; neither it nor this resolution hits the network.)
  const session = await openReadSession(ctx, deps);

  // Confirmation gate: without `--yes`, abort with a clear instruction and make
  // NO network call. Exit 0 — an unconfirmed revoke is not an error, just a no-op
  // the operator chose by omitting the flag.
  if (flags.yes !== true) {
    ctx.io.out(
      `Revoke invitation '${invitationId}'? This cannot be undone. ` +
        `Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  await withSession(
    session,
    (client) => client.delete<unknown>(`/v1/invitations/${encodeURIComponent(invitationId)}`),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify({ invitationId, deleted: true }));
    return ExitCode.OK;
  }

  ctx.io.out(`Revoked invitation '${invitationId}'.`);
  return ExitCode.OK;
}

/**
 * `member invitation <ls|rm>` — dispatch the invitation sub-command. The router
 * hands the `invitation` leaf the remaining argv (`<ls|rm> …`); this leaf
 * consumes the first positional as the sub-command and forwards the rest
 * (mirroring `flag value <show|update>`). A missing or unknown sub-command is a
 * USAGE error naming `ls` / `rm`.
 */
export async function runInvitation(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const [sub, ...rest] = ctx.args;
  const subCtx: RunContext = { ...ctx, args: rest };

  switch (sub) {
    case "ls":
      return await runInvitationLs(subCtx, deps);
    case "rm":
      return await runInvitationRm(subCtx, deps);
    default:
      throw new CliError(
        sub === undefined
          ? "member invitation: missing sub-command. " +
            "Usage: confeature member invitation <ls|rm> …"
          : `member invitation: unknown sub-command '${sub}'. ` +
            "Usage: confeature member invitation <ls|rm> …",
        ExitCode.USAGE,
      );
  }
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List organization members (--org-id).",
  run: (ctx) => runMemberLs(ctx),
};

const inviteLeaf: Leaf = {
  name: "invite",
  summary: "Invite one or more members (repeatable --email, optional --permission-group).",
  run: (ctx) => runMemberInvite(ctx),
};

const invitationLeaf: Leaf = {
  name: "invitation",
  summary: "List or revoke pending member invitations (ls / rm).",
  run: (ctx) => runInvitation(ctx),
};

/** `member` group — mirrors ConfigCat's CLI `member` group (incl. `invitation`). */
export const memberGroup: Group = {
  name: "member",
  summary: "Manage organization members and invitations.",
  commands: new Map([
    ["ls", lsLeaf],
    ["invite", inviteLeaf],
    ["invitation", invitationLeaf],
  ]),
};
