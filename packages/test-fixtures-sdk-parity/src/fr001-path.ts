// SPDX-License-Identifier: MIT

/**
 * FR-001 (#803) — the request path an SDK sends for a key, as the corpus's
 * oracle computes it. ONE implementation, read by the TS wire reader
 * (`wire-test-helpers.ts`, when a case pins no `requestPath`) and by the
 * corpus validator (`scripts/validate-wire-cases.ts`, which checks every
 * pinned `requestPath` against it). No vitest import, so the validator can
 * load it under plain `tsx`.
 *
 * Written here, not imported from `@confeature/sdk-shared`: the oracle must
 * not borrow the code it judges.
 */

/** FR-001's "well-shaped" — a ConfigCat-shaped or a legacy key. */
export const WELL_SHAPED_KEY =
  /^(?:configcat-sdk-1\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$/;

// Go's `url.PathEscape` keep set (net/url `shouldEscape`, mode
// encodePathSegment): the unreserved `A-Za-z0-9 - _ . ~` plus the
// sub-delims `$ & + : = @`. Everything else — `/ ; , ?` included, and every
// non-ASCII byte — is `%XX` (uppercase hex) of its UTF-8 bytes. This is NOT
// `encodeURIComponent`, which also keeps `! ' ( ) *` and escapes
// `$ & + : = @`.
const PATH_SEGMENT_KEEP = /^[A-Za-z0-9\-_.~$&+:=@]$/;

/**
 * Go's `url.PathEscape(s)`, byte for byte: FR-001's escaper for one path
 * segment. Throws on a lone surrogate (no UTF-8 encoding — no path).
 */
export function pathEscape(segment: string): string {
  const utf8 = new TextEncoder();
  let out = "";
  for (const char of segment) {
    if (PATH_SEGMENT_KEEP.test(char)) {
      out += char;
      continue;
    }
    // A code point from the iterator in the surrogate range is a lone one;
    // TextEncoder would silently turn it into U+FFFD.
    const codePoint = char.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error("pathEscape: a lone surrogate has no UTF-8 encoding");
    }
    for (const byte of utf8.encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * The path an SDK requests for `sdkKey` (query excluded). A well-shaped key
 * travels raw — its parts, split on `/`, each segment-escaped (a no-op for a
 * valid key), exactly a stock ConfigCat SDK's bytes; any other key is escaped
 * into ONE segment with Go's `url.PathEscape`. Throws for `""`, `.` and `..`:
 * no escaper keeps them in their segment, so FR-001 has no path for them —
 * the SDK refuses to fetch (`INVALID_SDK_KEY`).
 */
export function fr001Path(sdkKey: string): string {
  if (sdkKey === "" || sdkKey === "." || sdkKey === "..") {
    throw new Error(`fr001Path: ${JSON.stringify(sdkKey)} has no path — the SDK must not fetch`);
  }
  const keyPath = WELL_SHAPED_KEY.test(sdkKey)
    ? sdkKey.split("/").map(pathEscape).join("/")
    : pathEscape(sdkKey);
  return `/configuration-files/${keyPath}/config_v6.json`;
}
