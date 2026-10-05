// SPDX-License-Identifier: MIT

/**
 * Zod schema for seed files — AUTHORITATIVE for the seed format and the fault
 * vocabulary (plan 680, decision rows 1-3). seed-loader.ts and the admin API
 * validate with it, and types.ts derives every public type from it.
 *
 * schemas/seed.schema.json is emitted from this file by
 * tools/emit-seed-schema.mjs and is STRUCTURAL ONLY: the `.refine` rules below
 * (no body on a null-body status, a body requires a Content-Type, what a null
 * payload may carry) are not expressible there.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// FaultMarker
//
// Parameter-less faults are string-shaped; parameterised faults are
// object-shaped with a discriminating `kind` field. This schema is the ONLY
// place the fault vocabulary and its validity rules are decided — `types.ts`
// derives from it, and no caller re-checks a status, a header or a body.
// ---------------------------------------------------------------------------

/**
 * Statuses that cannot carry a body (Fetch spec "null body status", within the
 * 200–599 range a fault may use). `new Response("", { status: 304 })` throws,
 * so a fault on one of these is always built with a `null` body.
 */
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The header value grammar: visible ASCII, internal spaces/tabs allowed, no
 * leading or trailing whitespace. Stricter than both sinks (undici `Headers`
 * and Node `writeHead`), so an accepted fault never fails at serve time.
 */
const HeaderValue = z
  .string()
  .regex(/^([\x21-\x7E]([\x20\x09]*[\x21-\x7E])*)?$/, "header value must be visible ASCII");

/**
 * The closed set of headers a `status` fault may declare — the end-to-end
 * headers the wire-case corpus uses. Framing and hop-by-hop headers
 * (Content-Length, Transfer-Encoding, Connection, …) are harness-computed and
 * can never be declared; `.strict()` rejects them. `Content-Type` is limited
 * to non-active types: the harness never serves active content (plan S1).
 */
const StatusFaultHeadersSchema = z
  .object({
    "Content-Type": z.enum(["text/plain", "application/json"]).optional(),
    ETag: HeaderValue.optional(),
    "Last-Modified": HeaderValue.optional(),
    "Retry-After": HeaderValue.optional(),
    "Cache-Control": HeaderValue.optional(),
  })
  .strict();

const StatusFaultSchema = z
  .object({
    kind: z.literal("status"),
    status: z.number().int().min(200).max(599),
    headers: StatusFaultHeadersSchema.optional(),
    body: z.string().optional(),
  })
  .strict()
  .refine((f) => f.body === undefined || !NULL_BODY_STATUSES.has(f.status), {
    message: "a body is forbidden on status 204, 205 and 304",
    path: ["body"],
  })
  .refine((f) => f.body === undefined || f.headers?.["Content-Type"] !== undefined, {
    message: "a body requires a declared Content-Type",
    path: ["body"],
  });

/**
 * The canned fault literals — named once here. Each is an alias for a `status`
 * fault equal to its corpus case (fault-injector.ts CANNED_FAULTS), and each
 * replaces the whole response.
 */
export const CANNED_FAULT_NAMES = ["5xx", "404", "malformed-json", "wrong-shape"] as const;
export type CannedFaultName = (typeof CANNED_FAULT_NAMES)[number];

const TimeoutFaultSchema = z.object({
  kind: z.literal("timeout"),
  ms: z.number().int().min(1),
});

const EtagMismatchFaultSchema = z.object({
  kind: z.literal("etag-mismatch"),
  newEtag: z.string().regex(/^(W\/)?"[^"]*"$/, "must be a valid HTTP ETag"),
});

export const FaultMarkerSchema = z.union([
  z.literal("none"),
  z.enum(CANNED_FAULT_NAMES),
  TimeoutFaultSchema,
  EtagMismatchFaultSchema,
  StatusFaultSchema,
  z.literal("close-mid-response"),
]);

/**
 * Faults that replace the whole response, so they need no upstream body.
 * A seed key whose payload is null (absent from KV) may carry one of these,
 * or no fault at all — then the upstream serves its own KV-miss response.
 */
function replacesWholeResponse(fault: z.infer<typeof FaultMarkerSchema>): boolean {
  if (typeof fault === "object") return fault.kind === "status";
  return (CANNED_FAULT_NAMES as readonly string[]).includes(fault);
}

// ---------------------------------------------------------------------------
// ConfigV6Body — structural only; the CDN Worker owns deep validation
// ---------------------------------------------------------------------------

export const ConfigV6BodySchema = z
  .object({
    p: z.unknown().optional(),
    f: z.record(z.unknown()).optional(),
    s: z.array(z.unknown()).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// SeededKey
// ---------------------------------------------------------------------------

/**
 * RFC 9110 IMF-fixdate — what the management API writes (`Date#toUTCString()`) and what
 * the CDN Worker echoes verbatim as `Last-Modified` (#785). A seed may not put any
 * other shape on the wire.
 */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const EtagPattern = /^(W\/)?"[^"]*"$/;

export const SeededKeySchema = z
  .object({
    sdkKey: z
      .string()
      .min(1, "sdkKey must be non-empty")
      // A legacy key has no slash; a ConfigCat-shaped key (#802) has exactly
      // the two of `configcat-sdk-1/<a>/<b>`. Nothing else may carry one.
      .regex(
        /^(?:[^/]+|configcat-sdk-1\/[^/]+\/[^/]+)$/,
        "sdkKey must be slash-free or ConfigCat-shaped (configcat-sdk-1/<a>/<b>)",
      ),
    payload: z.union([ConfigV6BodySchema, z.null()]),
    etag: z.string().regex(EtagPattern, "must be a valid HTTP ETag").optional(),
    lastModified: z
      .string()
      .regex(IMF_FIXDATE, "lastModified must be an HTTP-date (IMF-fixdate)")
      .optional(),
    fault: FaultMarkerSchema.optional(),
  })
  .refine(
    (key) =>
      // A null payload means "absent from KV". It may stand alone (the upstream
      // serves its real miss) or carry a fault that replaces the whole
      // response; a fault that forwards the upstream body would have none.
      key.payload !== null ||
      key.fault === undefined ||
      key.fault === "none" ||
      replacesWholeResponse(key.fault),
    {
      message: "when payload is null, fault must be absent or replace the whole response",
      path: ["fault"],
    },
  );

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export const SeedSchema = z.object({
  schemaVersion: z.literal("1.0"),
  description: z.string().optional(),
  keys: z.array(SeededKeySchema).min(1, "keys must have at least one entry"),
});

export type SeedSchemaType = z.infer<typeof SeedSchema>;
export type SeededKeySchemaType = z.infer<typeof SeededKeySchema>;
export type FaultMarkerSchemaType = z.infer<typeof FaultMarkerSchema>;
