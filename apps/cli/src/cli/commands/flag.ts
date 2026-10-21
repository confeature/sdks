// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";
import type { components, operations } from "@confeature/contract/api";
import { ExitCode } from "../exit.ts";
import { CliError } from "../errors.ts";
import { ApiError } from "../../api/client.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import { openReadSession, type ReadDeps, requireOption, withSession } from "../read.ts";
import { type Column, renderTable } from "../table.ts";
import { coerceValue } from "../value.ts";

/**
 * `flag ls --config-id <id>` — list the feature flags (settings) of a config
 * (spec 181 / #655, US2). Mirrors ConfigCat's CLI `flag ls`.
 *
 * Calls `GET /v1/configs/{configId}/settings` and renders `(key, name, type)`,
 * or the list itself under `--json` (R7). The api answers ConfigCat's bare
 * `SettingModel[]` since #880, and a `{ settings }` envelope before it; this
 * command reads both, so it works on either side of the api release. A missing `--config-id` is a clear USAGE error naming the
 * option (R9); an empty result prints "no flags" and exits 0 (R10); logged-out
 * short-circuits with NO network call (R8).
 *
 * `flag value show` / `flag value update` (spec 182 / #656) reads + sets a
 * flag's per-environment value through the same read seam. A value write is
 * live in its environment once it succeeds (#879), so `update` writes and
 * stops, like ConfigCat's CLI (#933).
 */

/** A row of `flag ls`: the fields both list shapes carry (#880 D-14). */
interface FlagRow {
  key: string;
  name: string;
  type: string;
}

/**
 * A config's settings list in either shape (#880 D-14): ConfigCat's
 * `SettingModel[]`, or the pre-#880 `{ settings }` envelope. `items` is the list
 * as the api sent it (what `--json` prints); `rows` is what the table shows.
 */
export function readSettingList(body: unknown): { items: unknown[]; rows: FlagRow[] } {
  const items: unknown[] | null = Array.isArray(body)
    ? body
    : Array.isArray((body as { settings?: unknown } | null)?.settings)
    ? (body as { settings: unknown[] }).settings
    : null;
  // A body that is neither shape is an error, never an empty list.
  if (items === null) {
    throw new CliError(
      "flag ls: the api answered a settings list this CLI cannot read.",
      ExitCode.RUNTIME,
    );
  }
  const rows = items.map((raw) => {
    const s = raw as Record<string, unknown>;
    // `settingType` is ConfigCat's name; `type` is the pre-#880 one.
    return { key: String(s.key), name: String(s.name), type: String(s.settingType ?? s.type) };
  });
  return { items, rows };
}

// The create / metadata-update bodies, threaded from the generated `operations`
// types so the write shapes are build-verified against the contract.
type CreateSettingBody =
  & operations["createSetting"]["requestBody"]["content"]["application/json"]
  & { reason?: string };
type CreatedSetting = operations["createSetting"]["responses"][201]["content"]["application/json"];
type UpdateSettingBody =
  & operations["updateSetting"]["requestBody"]["content"]["application/json"]
  & { reason?: string };
type UpdatedSetting = operations["updateSetting"]["responses"][200]["content"]["application/json"];

/**
 * ConfigCat's four-member `SettingType` — threaded from the contract (same
 * source `value.ts` uses) so a contract change can't silently drift. The runtime
 * list `--type` is validated against is tied to that type via `satisfies`, so a
 * rename/removal in the contract is a compile error here.
 */
type SettingType = components["schemas"]["SettingType"];
const SETTING_TYPES = [
  "boolean",
  "string",
  "int",
  "double",
] as const satisfies readonly SettingType[];

/** Narrow a raw `--type` string to a `SettingType`, or USAGE-reject it. */
function requireSettingType(raw: string | undefined, command: string): SettingType {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new CliError(
      `${command}: missing required option \`--type\`. ` +
        `Usage: confeature ${command} --type <${SETTING_TYPES.join("|")}>`,
      ExitCode.USAGE,
    );
  }
  if (!(SETTING_TYPES as readonly string[]).includes(trimmed)) {
    throw new CliError(
      `${command}: '${trimmed}' is not a valid --type — ` +
        `expected one of ${SETTING_TYPES.join(", ")}.`,
      ExitCode.USAGE,
    );
  }
  return trimmed as SettingType;
}

// The per-environment value envelope (shared by GET value / PUT value). The PUT
// body additionally carries an optional `reason` (the mandatory-notes gate);
// the generated `SettingValue` schema omits it (additive — a ConfigCat client
// never sends it), so the write body extends the GET shape with it.
type SettingValue = operations["getSettingValue"]["responses"][200]["content"]["application/json"];
type SettingValuePutBody =
  & operations["setSettingValue"]["requestBody"]["content"]["application/json"]
  & { reason?: string };
/** The api's constant body for a value saved but not live yet (#879). */
type ValueNotLive = components["schemas"]["ValueNotLive"];

/**
 * Whether a failed value PUT is the api's "saved, not live yet" answer: a `503`
 * whose body is the contract's `ValueNotLive`. Only that answer proves the
 * value was saved; every other failure (another 503 included) says nothing
 * about the save, so the command must not claim one (#933).
 */
function isValueNotLive(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 503 &&
    (error.body as Partial<ValueNotLive> | null)?.error === "not_live";
}

/**
 * The wait a `Retry-After` header gives, in whole seconds, or `null` when it is
 * absent or not a non-negative integer. An HTTP-date is valid HTTP but not
 * what the api sends, so the CLI reports no number rather than guess one.
 */
function retryAfterSeconds(header: string | null): number | null {
  const trimmed = header?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

const FLAG_COLUMNS: Column<FlagRow>[] = [
  { header: "KEY", value: (s) => s.key },
  { header: "NAME", value: (s) => s.name },
  { header: "TYPE", value: (s) => s.type },
];

export async function runFlagLs(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id"] });
  const configId = requireOption(flags["config-id"], "--config-id", "flag ls");

  const session = await openReadSession(ctx, deps);
  const body = await withSession(
    session,
    (client) => client.get<unknown>(`/v1/configs/${encodeURIComponent(configId)}/settings`),
  );
  const { items, rows } = readSettingList(body);

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(items));
    return ExitCode.OK;
  }

  if (rows.length === 0) {
    ctx.io.out("No flags found.");
    return ExitCode.OK;
  }

  ctx.io.out(renderTable(FLAG_COLUMNS, rows));
  return ExitCode.OK;
}

/** Build the per-environment value path the GET/PUT value endpoints share. */
function valuePath(environmentId: string, configId: string, key: string): string {
  return (
    `/v1/environments/${encodeURIComponent(environmentId)}` +
    `/configs/${encodeURIComponent(configId)}` +
    `/settings/${encodeURIComponent(key)}/value`
  );
}

/** Render a (label, value) pair table — the show / update human surface. */
function renderPairs(pairs: [string, string][]): string {
  const columns: Column<[string, string]>[] = [
    { header: "FIELD", value: (row) => row[0] },
    { header: "VALUE", value: (row) => row[1] },
  ];
  return renderTable(columns, pairs);
}

/**
 * `flag value show --config-id <id> --key <key> --environment-id <id>` — report
 * a flag's current value (and declared type) for one environment (spec 182 /
 * #656, US3). Calls `GET …/settings/{key}/value` and renders `(env, type,
 * value)`, or the raw typed `SettingValue` under `--json` (R2/R13). A missing
 * required option is a USAGE error naming it (R11); logged-out short-circuits
 * with NO network call (R10).
 */
export async function runFlagValueShow(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "key", "environment-id"] });
  const configId = requireOption(flags["config-id"], "--config-id", "flag value show");
  const key = requireOption(flags.key, "--key", "flag value show");
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "flag value show",
  );

  const session = await openReadSession(ctx, deps);
  const value = await withSession(
    session,
    (client) => client.get<SettingValue>(valuePath(environmentId, configId, key)),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(value));
    return ExitCode.OK;
  }

  ctx.io.out(
    renderPairs([
      ["KEY", key],
      ["ENVIRONMENT", environmentId],
      ["TYPE", value.settingType],
      ["VALUE", String(value.value)],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `flag value update --config-id <id> --key <key> --environment-id <id>
 * --value <v> [--reason <note>]` — set a flag's value in one environment
 * (spec 182 / #656, US1/US2/US4). The value is live in that environment once
 * the write succeeds (#879), the same as ConfigCat's CLI, which writes and
 * stops.
 *
 * Flow (research §R4): GET the value (to learn the declared `settingType`, the
 * before-value, AND the existing targeting), coerce `--value` to that type
 * BEFORE any write (a wrong-type value is a USAGE error with no PUT — R4), then
 * PUT the typed `SettingValue` body overriding ONLY `value` and PRESERVING the
 * existing `rolloutRules` / `rolloutPercentageItems` (#669; read-modify-write —
 * never blind-overwrite). Nothing follows the PUT: a config publish would ship
 * every other pending draft of the config, in every environment (#933).
 *
 * A `503 not_live` from the PUT means the value is saved but its projection did
 * not land; the command says so and asks for the same command again, which the
 * api makes live (#879). Any other failure is the plain api error.
 *
 * SECURITY: the bearer token and the `--reason` note are NEVER printed — only
 * the key / env / old→new value / live flag reach the output (R14).
 */
export async function runFlagValueUpdate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, {
    string: ["config-id", "key", "environment-id", "value", "reason"],
  });
  const configId = requireOption(flags["config-id"], "--config-id", "flag value update");
  const key = requireOption(flags.key, "--key", "flag value update");
  const environmentId = requireOption(
    flags["environment-id"],
    "--environment-id",
    "flag value update",
  );
  // `--value` is required but may legitimately be the empty string for a string
  // flag, so it is validated for PRESENCE (not non-emptiness) — `requireOption`
  // would reject `--value ""`. An omitted flag is `undefined` → usage error.
  if (flags.value === undefined) {
    throw new CliError(
      "flag value update: missing required option `--value`. " +
        "Usage: confeature flag value update --value <v>",
      ExitCode.USAGE,
    );
  }
  const rawValue = flags.value;
  // `--reason` is optional; an empty / whitespace note is treated as absent so
  // the server's mandatory-notes gate fires rather than recording a blank note.
  const reason = flags.reason?.trim() ? flags.reason : undefined;

  const session = await openReadSession(ctx, deps);

  // GET the current value to learn the declared type + the before-value. This
  // is the SAME resolver-gated endpoint as `show`, so the whole flow stays on
  // the one cross-org gate this slice widens (research §R4).
  const current = await withSession(
    session,
    (client) => client.get<SettingValue>(valuePath(environmentId, configId, key)),
  );

  // Coerce `--value` to the flag's declared type. A non-parsing value throws a
  // type-naming USAGE error HERE — before the PUT — so a wrong-type input never
  // reaches the server (R4); the server re-validates as defence in depth.
  const coerced = coerceValue(rawValue, current.settingType);

  // Read-modify-write (#669): override ONLY `value` and PRESERVE the flag's
  // existing `rolloutRules` / `rolloutPercentageItems` read back from the GET
  // above. `PUT …/value` is a FULL replace, so sending empty arrays here would
  // silently wipe a flag's targeting / percentage-rollout on a plain value
  // change. ConfigCat's clients read-modify-write the whole `SettingValue`
  // envelope; we never blind-overwrite.
  //
  // Phase-1 boundary: server-side targeting is not implemented yet — the
  // contract pins these arrays `maxItems: 0` and the api rejects non-empty
  // rollouts, so the GET currently always returns empty arrays. This
  // preservation is therefore a no-op against today's api and becomes
  // load-bearing the moment segments / targeting lands (correct-by-construction).
  const putBody: SettingValuePutBody = {
    value: coerced,
    settingType: current.settingType,
    rolloutRules: current.rolloutRules,
    rolloutPercentageItems: current.rolloutPercentageItems,
  };
  if (reason !== undefined) putBody.reason = reason;

  try {
    await withSession(
      session,
      (client) => client.put<SettingValue>(valuePath(environmentId, configId, key), putBody),
    );
  } catch (error) {
    // Only the api's not_live answer proves a save; anything else (401 → AUTH
    // included) propagates untouched, so no other failure claims one.
    if (!isValueNotLive(error)) throw error;
    const seconds = retryAfterSeconds(error.headers.get("Retry-After"));
    const when = seconds === null ? "" : ` after ${seconds} second${seconds === 1 ? "" : "s"}`;
    throw new CliError(
      `flag value update: the value for '${key}' was SAVED but is NOT live yet. ` +
        `Retry the same command${when} to make it live.`,
      ExitCode.RUNTIME,
    );
  }

  if (session.outputJson) {
    ctx.io.out(
      JSON.stringify({
        key,
        environmentId,
        settingType: current.settingType,
        before: current.value,
        after: coerced,
        live: true,
      }),
    );
    return ExitCode.OK;
  }

  ctx.io.out(
    renderPairs([
      ["KEY", key],
      ["ENVIRONMENT", environmentId],
      ["TYPE", current.settingType],
      ["OLD", String(current.value)],
      ["NEW", String(coerced)],
      ["LIVE", "yes"],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `flag create --config-id <id> --key <key> --name <name>
 * --type <boolean|string|int|double> [--hint <h>]` — create a feature flag
 * (setting) in a config (#677). Mirrors `configcat-cli`'s `flag create`.
 *
 * Calls `POST /v1/configs/{configId}/settings` (the SAME endpoint the MCP
 * `create_flag` tool uses). `--type` is validated against the four ConfigCat
 * `SettingType` members BEFORE any write (a bad type is a USAGE error with no
 * network call). `--json` prints the created `Setting`; the human surface is a
 * confirmation + (key, name, type). A missing required option is a USAGE error
 * naming it (R9); logged-out short-circuits with NO network call (R8).
 *
 * The new flag is seeded with its type's zero value in every environment; set a
 * value with `flag value update`, which is live in its environment once it
 * succeeds.
 */
export async function runFlagCreate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "key", "name", "type", "hint"] });
  const configId = requireOption(flags["config-id"], "--config-id", "flag create");
  const key = requireOption(flags.key, "--key", "flag create");
  const name = requireOption(flags.name, "--name", "flag create");
  // `--type` is validated against the four SettingTypes here — a bad / missing
  // type is a USAGE error with NO network call.
  const type = requireSettingType(flags.type, "flag create");
  // `--hint` is optional; an empty / whitespace hint is treated as absent. Store
  // the TRIMMED value (the `flag update` path trims too — keep them consistent).
  const hint = flags.hint?.trim() || undefined;

  const session = await openReadSession(ctx, deps);

  const body: CreateSettingBody = { key, name, type };
  if (hint !== undefined) body.hint = hint;

  const created = await withSession(
    session,
    (client) =>
      client.post<CreatedSetting>(
        `/v1/configs/${encodeURIComponent(configId)}/settings`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  ctx.io.out(`Created flag '${created.key}'.`);
  ctx.io.out(
    renderPairs([
      ["KEY", created.key],
      ["NAME", created.name],
      ["TYPE", created.type],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `flag update --config-id <id> --key <key> [--name <n>] [--hint <h>]` — edit a
 * flag's METADATA (name / hint), NOT its value (#677). Mirrors `configcat-cli`'s
 * `flag update`.
 *
 * This is DISTINCT from `flag value update`: this command edits the flag's
 * name/hint via `PATCH /v1/configs/{configId}/settings/{key}`; to change the
 * served VALUE use `flag value update`. At least one of `--name` / `--hint` is
 * required (else a USAGE error). `--json` prints the updated `Setting`. A
 * missing required option is a USAGE error naming it (R9); logged-out
 * short-circuits with NO network call (R8).
 */
export async function runFlagUpdate(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "key", "name", "hint"] });
  const configId = requireOption(flags["config-id"], "--config-id", "flag update");
  const key = requireOption(flags.key, "--key", "flag update");

  // METADATA-only patch: at least one of `--name` / `--hint` must be present
  // (an `--hint ""` clears the hint, so `--hint` is checked for PRESENCE, not
  // non-emptiness). With neither, there is nothing to update → USAGE error.
  const hasName = flags.name !== undefined;
  const hasHint = flags.hint !== undefined;
  if (!hasName && !hasHint) {
    throw new CliError(
      "flag update: nothing to update — pass at least one of `--name` / `--hint`. " +
        "(To change a flag's VALUE, use `confeature flag value update`.)",
      ExitCode.USAGE,
    );
  }

  const body: UpdateSettingBody = {};
  if (hasName) {
    // `--name` is required to be non-empty after trim (the server rejects an
    // empty name); reject it client-side as a clear USAGE error.
    const name = flags.name?.trim();
    if (!name) {
      throw new CliError(
        "flag update: `--name` must not be empty.",
        ExitCode.USAGE,
      );
    }
    body.name = name;
  }
  if (hasHint) {
    // An explicit `--hint ""` clears the hint (→ null); a non-empty hint sets it.
    const trimmed = flags.hint?.trim();
    body.hint = trimmed ? trimmed : null;
  }

  const session = await openReadSession(ctx, deps);

  const updated = await withSession(
    session,
    (client) =>
      client.patch<UpdatedSetting>(
        `/v1/configs/${encodeURIComponent(configId)}/settings/${encodeURIComponent(key)}`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(updated));
    return ExitCode.OK;
  }

  ctx.io.out(`Updated flag '${updated.key}'.`);
  ctx.io.out(
    renderPairs([
      ["KEY", updated.key],
      ["NAME", updated.name],
      ["HINT", updated.hint ?? ""],
      ["TYPE", updated.type],
    ]),
  );
  return ExitCode.OK;
}

/**
 * `flag delete --config-id <id> --key <key> [--yes]` — delete a flag (setting)
 * by key (#677). Mirrors `configcat-cli`'s `flag delete`.
 *
 * DESTRUCTIVE: this permanently removes the flag and its per-environment values.
 * It MUST be confirmed: without `--yes` the command prints a confirmation line
 * and ABORTS (exit 0, NO network call) — the gate is purely the `--yes` flag, so
 * the command stays non-interactive + test-friendly (it never blocks on stdin).
 * Calls `DELETE /v1/configs/{configId}/settings/{key}` (the SAME endpoint the
 * MCP `delete_flag` tool uses). `--json` prints a small success object. A
 * missing required option is a USAGE error naming it (R9); logged-out
 * short-circuits with NO network call (R8).
 */
export async function runFlagDelete(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const flags = parseArgs(ctx.args, { string: ["config-id", "key"], boolean: ["yes"] });
  const configId = requireOption(flags["config-id"], "--config-id", "flag delete");
  const key = requireOption(flags.key, "--key", "flag delete");

  // Resolve the session FIRST so logged-out still short-circuits with NO network
  // call BEFORE the confirmation gate (R8) — a logged-out delete must never even
  // print the "would delete" line.
  const session = await openReadSession(ctx, deps);

  // Confirmation gate: without `--yes`, abort with a clear instruction and make
  // NO network call. Exit 0 — an unconfirmed delete is not an error, just a
  // no-op the operator chose by omitting the flag.
  if (flags.yes !== true) {
    ctx.io.out(
      `Delete flag '${key}'? This cannot be undone. Re-run with --yes to confirm.`,
    );
    return ExitCode.OK;
  }

  await withSession(
    session,
    (client) =>
      client.delete<unknown>(
        `/v1/configs/${encodeURIComponent(configId)}/settings/${encodeURIComponent(key)}`,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify({ key, configId, deleted: true }));
    return ExitCode.OK;
  }

  ctx.io.out(`Deleted flag '${key}'.`);
  return ExitCode.OK;
}

/**
 * `flag value <show|update>` — dispatch the value sub-command. The router hands
 * `value` the remaining argv (`<show|update> …`); this leaf consumes the first
 * positional as the sub-command and forwards the rest. A missing or unknown
 * sub-command is a USAGE error naming `show` / `update`.
 */
export async function runFlagValue(ctx: RunContext, deps: ReadDeps = {}): Promise<ExitCode> {
  const [sub, ...rest] = ctx.args;
  const subCtx: RunContext = { ...ctx, args: rest };

  switch (sub) {
    case "show":
      return await runFlagValueShow(subCtx, deps);
    case "update":
      return await runFlagValueUpdate(subCtx, deps);
    default:
      throw new CliError(
        sub === undefined
          ? "flag value: missing sub-command. Usage: confeature flag value <show|update> …"
          : `flag value: unknown sub-command '${sub}'. Usage: confeature flag value <show|update> …`,
        ExitCode.USAGE,
      );
  }
}

const lsLeaf: Leaf = {
  name: "ls",
  summary: "List feature flags.",
  run: (ctx) => runFlagLs(ctx),
};

const createLeaf: Leaf = {
  name: "create",
  summary: "Create a feature flag (key, name, type, optional hint).",
  run: (ctx) => runFlagCreate(ctx),
};

const updateLeaf: Leaf = {
  name: "update",
  summary: "Edit a flag's metadata (name/hint); for the value use `flag value update`.",
  run: (ctx) => runFlagUpdate(ctx),
};

const deleteLeaf: Leaf = {
  name: "delete",
  summary: "Delete a feature flag (requires --yes to confirm).",
  run: (ctx) => runFlagDelete(ctx),
};

const valueLeaf: Leaf = {
  name: "value",
  summary: "Show or set a flag's per-environment value (a set is live once it succeeds).",
  run: (ctx) => runFlagValue(ctx),
};

/** `flag` group — mirrors ConfigCat's CLI `flag` group (incl. `value`). */
export const flagGroup: Group = {
  name: "flag",
  summary: "Manage feature flags and their values.",
  commands: new Map([
    ["ls", lsLeaf],
    ["create", createLeaf],
    ["update", updateLeaf],
    ["delete", deleteLeaf],
    ["value", valueLeaf],
  ]),
};
