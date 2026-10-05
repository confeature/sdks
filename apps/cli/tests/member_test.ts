// SPDX-License-Identifier: MIT

/*
 * `member` group tests (#684, epic #676 — CLI `member` + `invitation` parity;
 * no dedicated spec, built directly).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the network —
 * mirroring the #677 `flag_crud_test.ts` / #678 `structural_crud_test.ts` /
 * #683 `rename_sdkkey_test.ts` pattern (stub fetch, assert method + URL + body +
 * `Authorization: Bearer`).
 *
 * Coverage:
 *   member ls (organizationsMembersList · GET org/{id}/members):
 *     - success: GET path / bearer; renders all three role buckets.
 *     - --json: emits the raw OrganizationMembersModel.
 *     - logged-out: NotLoggedInError, NO network call.
 *     - missing --org-id: USAGE error naming it, NO network call.
 *     - never prints the bearer token.
 *   member invite (createInvite · POST /v1/users/invite):
 *     - success: POST path / { emails, permissionGroupId } body / bearer.
 *     - multiple --email: collected into the emails array.
 *     - --permission-group: threaded; a non-zero value is a USAGE error, NO net.
 *     - --json: emits the 201 InviteCreateResultEntry[] (incl. tokens).
 *     - logged-out: NotLoggedInError, NO network call.
 *     - missing --email: USAGE error naming it, NO network call.
 *     - never prints the bearer token.
 *   member invitation ls (listInvitations · GET org/{id}/invitations):
 *     - success / --json / logged-out / missing --org-id / no-bearer-leak.
 *     - dispatched via the `invitation` leaf (sub-command = first positional).
 *   member invitation rm (deleteInvitation · DELETE /v1/invitations/{id}):
 *     - --yes deletes (DELETE path / bearer) vs no-`--yes` aborts (exit 0) NO net.
 *     - logged-out: NotLoggedInError, NO network call (even with `--yes`).
 *     - missing --invitation-id: USAGE error naming it.
 *     - --json: stable success object.
 *     - never prints the bearer token.
 *   invitation dispatch: missing / unknown sub-command → USAGE.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runInvitation, runMemberInvite, runMemberLs } from "../src/cli/commands/member.ts";
import { CliError } from "../src/cli/errors.ts";
import { NotLoggedInError } from "../src/cli/read.ts";
import type { RunContext } from "../src/cli/commands/registry.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { Io } from "../src/cli/io.ts";
import { ExitCode } from "../src/cli/exit.ts";

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function globals(overrides: Partial<Globals> = {}): Globals {
  return { help: false, version: false, outputJson: false, ...overrides };
}

function ctx(io: Io, args: string[], overrides: Partial<Globals> = {}): RunContext {
  return { globals: globals({ apiUrl: "https://api.example", ...overrides }), args, io };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal OrganizationMembersModel as the members endpoint returns it. */
function members(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    admins: [
      { userId: "u-admin", fullName: "Ada Admin", email: "ada@acme.test", twoFactorEnabled: false },
    ],
    billingManagers: [
      {
        userId: "u-bill",
        fullName: "Bill Manager",
        email: "bill@acme.test",
        twoFactorEnabled: false,
      },
    ],
    members: [
      {
        userId: "u-member",
        fullName: "Mary Member",
        email: "mary@acme.test",
        twoFactorEnabled: false,
        permissions: [],
      },
    ],
    ...overrides,
  };
}

/** A minimal InvitationModel as the invitations endpoint returns it. */
function invitation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    invitationId: "inv-1",
    email: "invitee@acme.test",
    permissionGroupId: 0,
    createdAt: "2026-06-23T00:00:00.000Z",
    expired: false,
    ...overrides,
  };
}

/** A minimal InviteCreateResultEntry as the invite endpoint returns it. */
function inviteResult(email: string) {
  return {
    email,
    invite_token: `confeature_invite_${"x".repeat(48)}`,
    expires_at: 1_900_000_000,
  };
}

/** Record every request a command issues: method + URL + body + auth header. */
interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function recordingFetch(
  routes: (call: Call) => Response,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init.headers).get("Authorization");
    const call = { method, url, body, auth };
    calls.push(call);
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

// A fetch stub that flips a flag when called and otherwise 200s — used to prove
// a command NEVER reached the network on the offline / usage-error paths.
function trippingFetch(): { fetch: () => Promise<Response>; called: () => boolean } {
  let tripped = false;
  return {
    fetch: () => {
      tripped = true;
      return Promise.resolve(jsonResponse(200, {}));
    },
    called: () => tripped,
  };
}

const MEMBERS_PATH = "/v1/organizations/org-1/members";
const INVITATIONS_PATH = "/v1/organizations/org-1/invitations";
const INVITE_PATH = "/v1/users/invite";
const INVITATION_RM_PATH = "/v1/invitations/inv-1";

// ── member ls ────────────────────────────────────────────────────────────────

Deno.test("member ls: GETs organizationsMembersList + renders all roles + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(MEMBERS_PATH)) {
      return jsonResponse(200, members());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runMemberLs(
    ctx(io, ["--org-id", "org-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "GET");
  assertStringIncludes(calls[0]!.url, MEMBERS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");

  const text = out.join("\n");
  // All three role buckets are projected into the one roster.
  assertStringIncludes(text, "ADMIN");
  assertStringIncludes(text, "BILLING");
  assertStringIncludes(text, "MEMBER");
  assertStringIncludes(text, "ada@acme.test");
  assertStringIncludes(text, "bill@acme.test");
  assertStringIncludes(text, "mary@acme.test");
});

Deno.test("member ls: --json emits the raw OrganizationMembersModel", async () => {
  const { io, out } = captureIo();
  const model = members();
  const { fetch } = recordingFetch(() => jsonResponse(200, model));

  const code = await runMemberLs(
    ctx(io, ["--org-id", "org-1"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), model);
});

Deno.test("member ls: empty roster prints a friendly message, exit 0", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() =>
    jsonResponse(200, { admins: [], billingManagers: [], members: [] })
  );

  const code = await runMemberLs(
    ctx(io, ["--org-id", "org-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n"), "No members found.");
});

Deno.test("member ls: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberLs(ctx(io, ["--org-id", "org-1"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out ls must never touch the network");
});

Deno.test("member ls: missing --org-id → USAGE error naming it, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberLs(ctx(io, []), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--org-id");
  assertEquals(trip.called(), false, "a usage error must precede any network call");
});

Deno.test("member ls: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, members()));
  await runMemberLs(
    ctx(io, ["--org-id", "org-1"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── member invite ────────────────────────────────────────────────────────────

Deno.test("member invite: POSTs createInvite with { emails, permissionGroupId } + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(INVITE_PATH)) {
      return jsonResponse(201, [inviteResult("solo@acme.test")]);
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runMemberInvite(
    ctx(io, ["--email", "solo@acme.test"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, INVITE_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  const body = calls[0]!.body as { emails: string[]; permissionGroupId: number };
  assertEquals(body.emails, ["solo@acme.test"]);
  assertEquals(body.permissionGroupId, 0);

  assertStringIncludes(out.join("\n"), "solo@acme.test");
});

Deno.test("member invite: multiple --email are collected into the emails array", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse(201, [inviteResult("a@acme.test"), inviteResult("b@acme.test")])
  );

  const code = await runMemberInvite(
    ctx(io, ["--email", "a@acme.test", "--email", "b@acme.test"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const body = calls[0]!.body as { emails: string[] };
  assertEquals(body.emails, ["a@acme.test", "b@acme.test"]);
});

Deno.test("member invite: --permission-group 0 is accepted + threaded", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(201, [inviteResult("a@acme.test")]));

  const code = await runMemberInvite(
    ctx(io, ["--email", "a@acme.test", "--permission-group", "0"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals((calls[0]!.body as { permissionGroupId: number }).permissionGroupId, 0);
});

Deno.test("member invite: a non-zero --permission-group → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberInvite(ctx(io, ["--email", "a@acme.test", "--permission-group", "7"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--permission-group");
  assertEquals(trip.called(), false, "a bad permission group must not reach the network");
});

Deno.test("member invite: a non-integer --permission-group (1.5) → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberInvite(ctx(io, ["--email", "a@acme.test", "--permission-group", "1.5"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--permission-group");
  assertEquals(trip.called(), false, "a non-integer permission group must not reach the network");
});

Deno.test("member invite: --json emits the 201 InviteCreateResultEntry[] (incl. tokens)", async () => {
  const { io, out } = captureIo();
  const created = [inviteResult("a@acme.test"), inviteResult("b@acme.test")];
  const { fetch } = recordingFetch(() => jsonResponse(201, created));

  const code = await runMemberInvite(
    ctx(io, ["--email", "a@acme.test", "--email", "b@acme.test"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), created);
});

Deno.test("member invite: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberInvite(ctx(io, ["--email", "a@acme.test"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out invite must never touch the network");
});

Deno.test("member invite: missing --email → USAGE error naming it, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberInvite(ctx(io, ["--permission-group", "0"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--email");
  assertEquals(trip.called(), false, "a missing email must not reach the network");
});

Deno.test("member invite: a blank --email is dropped → USAGE error, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runMemberInvite(ctx(io, ["--email", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--email");
  assertEquals(trip.called(), false, "a blank email must not reach the network");
});

Deno.test("member invite: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(201, [inviteResult("a@acme.test")]));
  await runMemberInvite(
    ctx(io, ["--email", "a@acme.test"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── member invitation ls (via the dispatched `invitation` leaf) ────────────────

Deno.test("member invitation ls: GETs listInvitations + renders rows + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(INVITATIONS_PATH)) {
      return jsonResponse(200, [
        invitation(),
        invitation({ invitationId: "inv-2", expired: true }),
      ]);
    }
    return jsonResponse(404, { error: "not_found" });
  });

  // Dispatch through the sub-group leaf — `ls` is the first positional.
  const code = await runInvitation(
    ctx(io, ["ls", "--org-id", "org-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "GET");
  assertStringIncludes(calls[0]!.url, INVITATIONS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");

  const text = out.join("\n");
  assertStringIncludes(text, "inv-1");
  assertStringIncludes(text, "inv-2");
  assertStringIncludes(text, "invitee@acme.test");
});

Deno.test("member invitation ls: --json emits the raw InvitationModel[]", async () => {
  const { io, out } = captureIo();
  const list = [invitation()];
  const { fetch } = recordingFetch(() => jsonResponse(200, list));

  const code = await runInvitation(
    ctx(io, ["ls", "--org-id", "org-1"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), list);
});

Deno.test("member invitation ls: empty list prints a friendly message, exit 0", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, []));

  const code = await runInvitation(
    ctx(io, ["ls", "--org-id", "org-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n"), "No invitations found.");
});

Deno.test("member invitation ls: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["ls", "--org-id", "org-1"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out invitation ls must never touch the network");
});

Deno.test("member invitation ls: missing --org-id → USAGE error naming it, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["ls"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--org-id");
  assertEquals(trip.called(), false, "a usage error must precede any network call");
});

Deno.test("member invitation ls: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, [invitation()]));
  await runInvitation(
    ctx(io, ["ls", "--org-id", "org-1"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── member invitation rm (via the dispatched `invitation` leaf) ────────────────

Deno.test("member invitation rm: --yes DELETEs deleteInvitation with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "DELETE" && call.url.endsWith(INVITATION_RM_PATH)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runInvitation(
    ctx(io, ["rm", "--invitation-id", "inv-1", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "DELETE");
  assertStringIncludes(calls[0]!.url, INVITATION_RM_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertStringIncludes(out.join("\n").toLowerCase(), "revoked");
});

Deno.test("member invitation rm: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();

  const code = await runInvitation(
    ctx(io, ["rm", "--invitation-id", "inv-1"]),
    { readToken: () => Promise.resolve("tok"), fetch: trip.fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed revoke must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "inv-1");
  assertStringIncludes(text, "--yes");
});

Deno.test("member invitation rm: --json emits a stable success object", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));

  const code = await runInvitation(
    ctx(io, ["rm", "--invitation-id", "inv-1", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), { invitationId: "inv-1", deleted: true });
});

Deno.test("member invitation rm: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["rm", "--invitation-id", "inv-1", "--yes"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out revoke must never touch the network");
});

Deno.test("member invitation rm: missing --invitation-id → USAGE error naming it, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["rm", "--yes"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--invitation-id");
  assertEquals(trip.called(), false, "a usage error must precede any network call");
});

Deno.test("member invitation rm: missing --invitation-id WITHOUT --yes still USAGE-errors before any network", async () => {
  // The arg-presence check runs before the session/--yes gate: a missing id is a
  // USAGE error whether or not --yes is passed, and never touches the network.
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["rm"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--invitation-id");
  assertEquals(trip.called(), false, "a usage error must precede any network call");
});

Deno.test("member invitation rm: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  await runInvitation(
    ctx(io, ["rm", "--invitation-id", "inv-1", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── member invitation dispatch ─────────────────────────────────────────────────

Deno.test("member invitation: missing sub-command → USAGE error", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, []), { readToken: () => Promise.resolve("tok") });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "ls");
  assertStringIncludes((thrown as CliError).message, "rm");
});

Deno.test("member invitation: unknown sub-command → USAGE error naming it", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runInvitation(ctx(io, ["bogus"]), { readToken: () => Promise.resolve("tok") });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "bogus");
});
