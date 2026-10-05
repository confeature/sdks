// SPDX-License-Identifier: MIT

/**
 * SDK key format + redaction helpers.
 *
 * SECURITY (constitution security clause): SDK keys are secrets. They MUST
 * NEVER appear verbatim in any log line. Every log site that needs to
 * reference a key passes it through {@link redactSdkKey} first.
 */

/**
 * SDK key formats: `configcat-sdk-1/<22>/<22>` (minted today, #802) and
 * `confeature-sdk-1-<32>-<32>` (before). Invalid keys log INVALID_SDK_KEY
 * but never throw (FR-009). Cases: test-fixtures `sdk-key-shapes.json`.
 */
export const CONFEATURE_SDK_KEY_PATTERN =
  /^(?:configcat-sdk-1\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$/;

/**
 * Returns `true` when the key matches either Confeature SDK-key format.
 *
 * A `false` result does NOT cause the SDK to throw; it triggers an
 * `INVALID_SDK_KEY` log line (which, per security clause, includes only
 * the {@link redactSdkKey | redacted} form).
 */
export function isValidConfeatureKeyFormat(sdkKey: string): boolean {
  return CONFEATURE_SDK_KEY_PATTERN.test(sdkKey);
}

/**
 * Returns a privacy-preserving rendering of `sdkKey` suitable for logs.
 *
 * Strategy: keep ~20% of the key visible at each end, mask the middle.
 * For short / unusual keys (e.g. legacy ConfigCat keys), fall back to a
 * full mask. NEVER returns the raw key.
 *
 * Examples:
 *   a 61-char `configcat-sdk-1/…` key → `"config…[redacted]…<last 6>"`
 *   `redactSdkKey("short")`                  → `"[redacted]"`
 *   `redactSdkKey("")`                       → `"[redacted]"`
 */
export function redactSdkKey(sdkKey: string | null | undefined): string {
  if (!sdkKey || typeof sdkKey !== "string") return "[redacted]";
  if (sdkKey.length < 16) return "[redacted]";
  const visible = Math.max(4, Math.floor(sdkKey.length * 0.1));
  const head = sdkKey.slice(0, visible);
  const tail = sdkKey.slice(-visible);
  return `${head}…[redacted]…${tail}`;
}

/**
 * Derive a stable, opaque cache key from an SDK key.
 *
 * Format (research §R4): `confeature:cache:v1:<base64url(sha256(sdkKey)).slice(0,32)>`.
 *
 * Security clause (FR-018, SC-006): the SDK key is HASHED, not stored
 * raw. Even an attacker with DevTools open cannot read the SDK key
 * from a `localStorage` key written by the browser SDK.
 *
 * The hash is computed via `globalThis.crypto.subtle.digest` (Web Crypto
 * API). It is async because Web Crypto's digest method is async on every
 * runtime that ships it (browsers, Workers, Node ≥ 20, Deno, Bun).
 * Callers that need a synchronous variant should hydrate the derived
 * key into a private field at construction time.
 *
 * @param sdkKey The Confeature SDK key. Treated as opaque text — no
 *               format validation is performed (use `isValidConfeatureKeyFormat`
 *               separately for that).
 * @returns The fully-qualified cache key string.
 * @throws Error if Web Crypto is unavailable (extremely rare in the
 *         supported runtime matrix; the caller is responsible for the
 *         fallback to memory-only cache).
 */
export async function deriveCacheKey(sdkKey: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API unavailable; deriveCacheKey requires crypto.subtle.");
  }
  const bytes = new TextEncoder().encode(sdkKey);
  const digest = await subtle.digest("SHA-256", bytes);
  return `confeature:cache:v1:${base64UrlEncode(digest).slice(0, 32)}`;
}

/**
 * Synchronous variant of {@link deriveCacheKey}.
 *
 * Browser SDKs hydrate their `localStorage` cache from the client
 * constructor (research §R13 — instant first paint), and constructors
 * can't `await`. We therefore need a hash that:
 *
 *  - is computable synchronously (Web Crypto's `digest` is async),
 *  - hides the SDK key from a casual DevTools / `localStorage` snoop
 *    (constitution security clause, FR-018),
 *  - keeps the same `confeature:cache:v1:<32 chars>` shape as the
 *    async variant so cache entries written by either function remain
 *    cross-compatible should we ever pre-derive on the server.
 *
 * Strategy: 128-bit FNV-1a × xxHash-style mixing, then base64url. NOT a
 * cryptographic hash — the attacker model is "anyone with DevTools can
 * see their own browser's storage", not "preimage resistance against a
 * remote adversary". Anyone with the SDK key already has full access
 * to flag data on the CDN; what we hide is the key itself, and the
 * non-crypto hash is sufficient for that.
 */
export function deriveCacheKeySync(sdkKey: string): string {
  // Three FNV-1a 64-bit passes with distinct offset bases — input
  // verbatim, byte-reversed, and char-rotated — concatenated to 24
  // bytes (192 bits). Encodes to exactly 32 base64url chars, matching
  // the documented `confeature:cache:v1:<32 chars>` shape so cache
  // entries from sync + async hydration paths remain interchangeable.
  const bytes = fnv192(sdkKey);
  return `confeature:cache:v1:${base64UrlEncode(bytes.buffer as ArrayBuffer).slice(0, 32)}`;
}

/**
 * Base64URL encode an `ArrayBuffer` — emits the URL-safe alphabet
 * (`-_`) without padding. Pure runtime-agnostic helper; no
 * `Buffer`, no `node:*`.
 */
function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // btoa is on the web platform + Node ≥ 16; standard portable encoder.
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 128-bit FNV-1a-derived digest. Pure JS, no external dependency.
 *
 * Strategy: two independent FNV-1a 64-bit passes — one over the input
 * verbatim, one over the byte-reversed input — concatenated to produce
 * 16 bytes (128 bits) of output. The two passes use different offset-
 * bases so they don't trivially correlate.
 *
 * Big-int arithmetic uses 64-bit BigInts (supported on all the
 * runtimes in our target matrix). Performance: ~1 µs per call for a
 * typical SDK-key length — negligible at construction time.
 */
function fnv192(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const reversed = new Uint8Array(bytes);
  reversed.reverse();
  // Third pass: rotate every byte by 7 bits to decorrelate from the
  // verbatim + reversed passes without allocating a new array.
  const rotated = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    rotated[i] = ((b << 1) | (b >>> 7)) & 0xff;
  }
  const a = fnv64(bytes, 0xcbf29ce484222325n);
  const b = fnv64(reversed, 0x84222325cbf29ce4n);
  const c = fnv64(rotated, 0x9c8f3a55b1d2e6f7n);
  const out = new Uint8Array(24);
  writeBigUint64BE(out, 0, a);
  writeBigUint64BE(out, 8, b);
  writeBigUint64BE(out, 16, c);
  return out;
}

const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function fnv64(bytes: Uint8Array, offsetBasis: bigint): bigint {
  let hash = offsetBasis & UINT64_MASK;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ BigInt(bytes[i] as number)) & UINT64_MASK;
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return hash;
}

function writeBigUint64BE(out: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}
