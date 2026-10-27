// SPDX-License-Identifier: MIT

import { parseArgs } from "@std/cli/parse-args";
import type { components, operations } from "@confeature/contract/api";
import { ExitCode } from "../exit.ts";
import { CliError } from "../errors.ts";
import { type ApiClient, ApiError } from "../../api/client.ts";
import type { Group, Leaf, RunContext } from "./registry.ts";
import {
  openReadSession,
  type ReadDeps,
  type ReadSession,
  requireOption,
  withSession,
} from "../read.ts";
import { type Column, renderTable } from "../table.ts";
import { coerceValue, type TypedValue } from "../value.ts";

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
 * flag's per-environment value through the same read seam, on the route the
 * config's `evaluationVersion` picks: the v2 value API by `settingId` on a v2
 * config, the by-key v1 route otherwise (#817). A value write is live in its
 * environment once it succeeds (#879), so `update` writes and stops, like
 * ConfigCat's CLI (#933).
 */

/**
 * A flag as this CLI reads it, from the list or a per-key answer: only the
 * fields both wire shapes carry. The list answers ConfigCat's `SettingModel[]`
 * since #880; the per-key routes (get one, create, update) answer
 * `SettingModel` since #937, and the older `Setting` (`type`, `config_id`,
 * epoch-ms dates) before it.
 */
interface FlagRow {
  key: string;
  name: string;
  hint: string | null;
  type: string;
}

/**
 * One setting in either shape → `FlagRow`, or `null` for a body that is neither:
 * a malformed answer is an error, never a row of `undefined`s. The one place a
 * setting's wire shape is read (the list reads each item through it), so the
 * CLI reads both sides of the api release (#937).
 */
export function readSetting(body: unknown): FlagRow | null {
  // An array or a scalar has none of the fields below, so it reads as null too.
  if (body === null || typeof body !== "object") return null;
  const s = body as Record<string, unknown>;
  // `settingType` is ConfigCat's name; `type` is the pre-#880/#937 one.
  const type = s.settingType ?? s.type;
  if (typeof s.key !== "string" || typeof s.name !== "string" || typeof type !== "string") {
    return null;
  }
  return { key: s.key, name: s.name, hint: typeof s.hint === "string" ? s.hint : null, type };
}

/** `readSetting`, or a RUNTIME error naming the command whose answer it could not read. */
function requireSetting(body: unknown, command: string): FlagRow {
  const row = readSetting(body);
  if (row === null) {
    throw new CliError(
      `${command}: the api answered a setting this CLI cannot read.`,
      ExitCode.RUNTIME,
    );
  }
  return row;
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
  const rows = items?.map(readSetting) ?? null;
  // A body that is neither shape, or holds an unreadable item, is an error,
  // never an empty or partial list.
  if (items === null || rows === null || rows.some((r) => r === null)) {
    throw new CliError(
      "flag ls: the api answered a settings list this CLI cannot read.",
      ExitCode.RUNTIME,
    );
  }
  return { items, rows: rows as FlagRow[] };
}

// The create / metadata-update bodies, threaded from the generated `operations`
// types so the write shapes are build-verified against the contract.
type CreateSettingBody =
  & operations["createSetting"]["requestBody"]["content"]["application/json"]
  & { reason?: string };
type UpdateSettingBody =
  & operations["updateSetting"]["requestBody"]["content"]["application/json"]
  & { reason?: string };

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

// The v1 per-environment value envelope (shared by GET value / PUT value). The PUT
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

/** Build the by-key v1 value path the GET/PUT value endpoints share. */
function valuePath(environmentId: string, configId: string, key: string): string {
  return (
    `/v1/environments/${encodeURIComponent(environmentId)}` +
    `/configs/${encodeURIComponent(configId)}` +
    `/settings/${encodeURIComponent(key)}/value`
  );
}

// The reads the route choice makes, and the v2 value API's read and patch
// shapes, threaded from the generated `operations` types (#817).
type ConfigModel = operations["getConfig"]["responses"][200]["content"]["application/json"];
/**
 * The per-key setting answer as the value route reads it: only its id, which
 * both shapes carry (ConfigCat's `SettingModel` since #937, `Setting` before).
 */
type SettingRead = { settingId?: unknown };
type SettingFormula =
  operations["getSettingValueV2"]["responses"][200]["content"]["application/json"];
type FormulaPatch =
  operations["updateSettingValueV2"]["requestBody"]["content"]["application/json"];
type ValueModel = components["schemas"]["ValueModel"];

/** The `ValueModel` field that holds a value of each setting type. */
const VALUE_FIELD = {
  boolean: "boolValue",
  string: "stringValue",
  int: "intValue",
  double: "doubleValue",
} as const satisfies Record<SettingType, keyof ValueModel>;

/** Where a flag's value lives in one environment, and which API speaks it. */
type ValueRoute = { kind: "v1"; path: string } | { kind: "v2"; path: string };

/**
 * THE choice of value route for the `flag value` commands (#817). It is the
 * only place the CLI decides it.
 *
 * A config whose `evaluationVersion` is `v2` keeps its values behind
 * ConfigCat's v2 value API, addressed by the setting's numeric `settingId`
 * (`/v2/environments/{environmentId}/settings/{settingId}/value`). Those values
 * carry targeting rules and percentage options, and the by-key v1 route refuses
 * a value that has them, so a v2 config must never be sent there. Any other
 * config keeps the by-key v1 route, which needs no `settingId`.
 *
 * The CLI is addressed by `--config-id` and `--key`, so the route costs a
 * config read, and on v2 a setting read for the `settingId`. ConfigCat's CLI
 * makes the same two reads before a value call.
 */
async function valueRouteOf(
  client: ApiClient,
  environmentId: string,
  configId: string,
  key: string,
): Promise<ValueRoute> {
  const config = await client.get<ConfigModel>(`/v1/configs/${encodeURIComponent(configId)}`);
  if (config.evaluationVersion !== "v2") {
    return { kind: "v1", path: valuePath(environmentId, configId, key) };
  }
  const setting = await client.get<SettingRead>(
    `/v1/configs/${encodeURIComponent(configId)}/settings/${encodeURIComponent(key)}`,
  );
  // The id becomes a path segment: anything but a positive integer is an api
  // answer this CLI cannot address a value with.
  const settingId = setting.settingId;
  if (typeof settingId !== "number" || !Number.isSafeInteger(settingId) || settingId < 1) {
    throw new CliError(
      `flag value: the api answered a setting id this CLI cannot read for '${key}'.`,
      ExitCode.RUNTIME,
    );
  }
  return {
    kind: "v2",
    path: `/v2/environments/${encodeURIComponent(environmentId)}` +
      `/settings/${settingId}/value`,
  };
}

/** A flag's value in one environment, as the route that holds it answers it. */
type ValueRead =
  | { kind: "v1"; path: string; body: SettingValue }
  | { kind: "v2"; path: string; body: SettingFormula };

/** Choose the route (see {@link valueRouteOf}), then read the value through it. */
async function readValue(
  session: ReadSession,
  environmentId: string,
  configId: string,
  key: string,
): Promise<ValueRead> {
  return await withSession(session, async (client): Promise<ValueRead> => {
    const route = await valueRouteOf(client, environmentId, configId, key);
    return route.kind === "v2"
      ? { ...route, body: await client.get<SettingFormula>(route.path) }
      : { ...route, body: await client.get<SettingValue>(route.path) };
  });
}

/** The flag's declared type: the v1 envelope's, or the v2 setting's. */
function settingTypeOf(read: ValueRead): SettingType {
  return read.kind === "v2" ? read.body.setting.settingType : read.body.settingType;
}

/**
 * The value the environment serves when no rule matches. On v2 that is the
 * default value's typed field; a null there is an answer this CLI cannot show.
 */
function valueOf(read: ValueRead): TypedValue {
  if (read.kind === "v1") return read.body.value;
  const value = read.body.defaultValue[VALUE_FIELD[settingTypeOf(read)]];
  if (value === null || value === undefined) {
    throw new CliError(
      "flag value: the api answered a value this CLI cannot read.",
      ExitCode.RUNTIME,
    );
  }
  return value;
}

/**
 * Write `value` through the route the value was read from, changing nothing
 * else about the flag (#669).
 *
 * - **v2**: a JSON Patch (RFC 6902) that replaces the default value's typed
 *   field and nothing else, so every targeting rule, percentage option and the
 *   percentage attribute stay as they are, by construction. The api applies
 *   it to the value it holds at write time, so a rule added between the read
 *   and the write is kept too. ConfigCat's CLI patches `/defaultValue` the same
 *   way. The change note is the `reason` query parameter there.
 * - **v1**: a full-replace `PUT` of the value envelope, so the targeting read
 *   back above is sent unchanged. The api pins it empty today, and refuses a v1
 *   write on a value that has v2 rules.
 */
async function writeValue(
  session: ReadSession,
  read: ValueRead,
  value: TypedValue,
  reason: string | undefined,
): Promise<void> {
  if (read.kind === "v2") {
    const patch: FormulaPatch = [
      { op: "replace", path: `/defaultValue/${VALUE_FIELD[settingTypeOf(read)]}`, value },
    ];
    const query = reason === undefined ? "" : `?reason=${encodeURIComponent(reason)}`;
    // A 200 and a 204 ("the patch changed nothing") both answer a live value.
    await withSession(session, (client) => client.patch<unknown>(`${read.path}${query}`, patch));
    return;
  }
  const putBody: SettingValuePutBody = {
    value,
    settingType: read.body.settingType,
    rolloutRules: read.body.rolloutRules,
    rolloutPercentageItems: read.body.rolloutPercentageItems,
  };
  if (reason !== undefined) putBody.reason = reason;
  await withSession(session, (client) => client.put<SettingValue>(read.path, putBody));
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
 * #656, US3). The route follows the config's `evaluationVersion` (#817): the
 * by-key v1 `SettingValue`, or the v2 `SettingFormulaModel` by `settingId`.
 * Renders `(env, type, value)`, plus the targeting rule count on v2, where the
 * value is the one served when no rule matches; `--json` prints the api's body
 * as sent (R2/R13). A missing required option is a USAGE error naming it
 * (R11); logged-out short-circuits with NO network call (R10).
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
  const read = await readValue(session, environmentId, configId, key);

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(read.body));
    return ExitCode.OK;
  }

  const pairs: [string, string][] = [
    ["KEY", key],
    ["ENVIRONMENT", environmentId],
    ["TYPE", settingTypeOf(read)],
    ["VALUE", String(valueOf(read))],
  ];
  if (read.kind === "v2") pairs.push(["RULES", String(read.body.targetingRules.length)]);
  ctx.io.out(renderPairs(pairs));
  return ExitCode.OK;
}

/**
 * `flag value update --config-id <id> --key <key> --environment-id <id>
 * --value <v> [--reason <note>]` — set a flag's value in one environment
 * (spec 182 / #656, US1/US2/US4). The value is live in that environment once
 * the write succeeds (#879), the same as ConfigCat's CLI, which writes and
 * stops.
 *
 * Flow (research §R4): read the value through the route the config's
 * `evaluationVersion` picks (#817), to learn the declared type and the
 * before-value; coerce `--value` to that type BEFORE any write (a wrong-type
 * value is a USAGE error with no write — R4); then write ONLY the value, so
 * the flag's targeting is never wiped (#669, see {@link writeValue}). Nothing
 * follows the write: a config publish would ship every other pending draft of
 * the config, in every environment (#933).
 *
 * A `503 not_live` from the write means the value is saved but its projection
 * did not land; the command says so and asks for the same command again, which
 * the api makes live (#879). Any other failure is the plain api error.
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

  // Read the current value to learn the declared type + the before-value. This
  // is the SAME read as `show`, so the whole flow stays on one resolver-gated
  // route (research §R4).
  const current = await readValue(session, environmentId, configId, key);
  const settingType = settingTypeOf(current);
  const before = valueOf(current);

  // Coerce `--value` to the flag's declared type. A non-parsing value throws a
  // type-naming USAGE error HERE — before the write — so a wrong-type input
  // never reaches the server (R4); the server re-validates as defence in depth.
  const coerced = coerceValue(rawValue, settingType);

  try {
    await writeValue(session, current, coerced, reason);
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
        settingType,
        before,
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
      ["TYPE", settingType],
      ["OLD", String(before)],
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
 * network call). `--json` prints the created setting as the api sent it; the
 * human surface is a confirmation + (key, name, type). A missing required option is a USAGE error
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
      client.post<unknown>(
        `/v1/configs/${encodeURIComponent(configId)}/settings`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(created));
    return ExitCode.OK;
  }

  const row = requireSetting(created, "flag create");
  ctx.io.out(`Created flag '${row.key}'.`);
  ctx.io.out(
    renderPairs([
      ["KEY", row.key],
      ["NAME", row.name],
      ["TYPE", row.type],
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
 * required (else a USAGE error). `--json` prints the updated setting as the api
 * sent it. A
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
      client.patch<unknown>(
        `/v1/configs/${encodeURIComponent(configId)}/settings/${encodeURIComponent(key)}`,
        body,
      ),
  );

  if (session.outputJson) {
    ctx.io.out(JSON.stringify(updated));
    return ExitCode.OK;
  }

  const row = requireSetting(updated, "flag update");
  ctx.io.out(`Updated flag '${row.key}'.`);
  ctx.io.out(
    renderPairs([
      ["KEY", row.key],
      ["NAME", row.name],
      ["HINT", row.hint ?? ""],
      ["TYPE", row.type],
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
