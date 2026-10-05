// SPDX-License-Identifier: MIT

/**
 * Vendored pure-JS SHA-1 and SHA-256.
 *
 * The flag evaluator needs two **synchronous, runtime-agnostic** hashes
 * (research.md §R2):
 *
 *   - **SHA-1, UNSALTED** for percentage bucketing —
 *     `parseInt(sha1(key + attr).slice(0, 7), 16) % 100`.
 *   - **SHA-256, SALTED** for sensitive comparators —
 *     `sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))`.
 *
 * Why a vendored pure-JS implementation rather than Web Crypto or
 * `node:crypto` (precedent: `sdk-key.ts`):
 *
 *   - `crypto.subtle.digest` is **async on every runtime** — adopting it
 *     would force `RolloutEvaluator.evaluate` (and every SDK's sync
 *     `getValue`) to become async, breaking ConfigCat surface parity.
 *   - `node:crypto.createHash` is sync but absent in browsers / Cloudflare
 *     Workers / Deno-without-node-compat, so it fails the runtime-agnostic
 *     mandate of `@confeature/sdk-shared`.
 *
 * These hashes are used for bucketing / hashed-equality matching, not as a
 * security boundary, so a pure-JS implementation is correct (it is exactly
 * what ConfigCat's `common-js` ships). UTF-8 bytes are obtained via
 * `TextEncoder` (universally available), matching common-js `utf8Encode`.
 *
 * Both functions return a **lowercase hex** string and are byte-identical
 * across Node / Browser / Workers / Bun / Deno — which the parity corpus
 * requires (the same bucket / hash must come out on every runtime).
 */

const HEX = "0123456789abcdef";

/** Lowercase-hex-encode a byte array. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX[(b >>> 4) & 0x0f] + HEX[b & 0x0f];
  }
  return out;
}

/** 32-bit left-rotate. */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** 32-bit right-rotate. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Compute the SHA-1 digest of `input` and return it as a 40-char
 * lowercase hex string.
 *
 * Used UNSALTED for ConfigCat percentage bucketing (research.md §R2).
 */
export function sha1(input: string): string {
  const msg = new TextEncoder().encode(input);
  const ml = msg.length;
  // Pad: append 0x80, then 0x00 up to (len % 64) === 56, then the 64-bit
  // big-endian bit length.
  const withOne = ml + 1;
  const blocks = Math.ceil((withOne + 8) / 64);
  const total = blocks * 64;
  const data = new Uint8Array(total);
  data.set(msg);
  data[ml] = 0x80;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  const dv = new DataView(data.buffer);
  dv.setUint32(total - 8, bitLenHi >>> 0, false);
  dv.setUint32(total - 4, bitLenLo, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = dv.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 80; t++) {
      w[t] = rotl(
        ((w[t - 3] as number) ^
          (w[t - 8] as number) ^
          (w[t - 14] as number) ^
          (w[t - 16] as number)) >>>
          0,
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + (w[t] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  return toHex(out);
}

// SHA-256 round constants (first 32 bits of the fractional parts of the
// cube roots of the first 64 primes).
const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Compute the SHA-256 digest of `input` and return it as a 64-char
 * lowercase hex string.
 *
 * Used SALTED for ConfigCat sensitive comparators (see
 * {@link hashComparisonValue}, research.md §R2). UTF-8-encodes the string
 * first, then delegates to {@link sha256Bytes}.
 */
export function sha256(input: string): string {
  return sha256Bytes(new TextEncoder().encode(input));
}

/**
 * Compute the SHA-256 digest of raw `msg` bytes and return it as a 64-char
 * lowercase hex string. The byte-level entry point the sensitive
 * startsWith/endsWith comparators need: they slice the attribute at the UTF-8
 * **byte** boundary and hash that slice concatenated with the salt bytes — so
 * the input is an arbitrary byte sequence, not re-encodable text.
 */
export function sha256Bytes(msg: Uint8Array): string {
  const ml = msg.length;
  const withOne = ml + 1;
  const blocks = Math.ceil((withOne + 8) / 64);
  const total = blocks * 64;
  const data = new Uint8Array(total);
  data.set(msg);
  data[ml] = 0x80;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  const dv = new DataView(data.buffer);
  dv.setUint32(total - 8, bitLenHi >>> 0, false);
  dv.setUint32(total - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Int32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = dv.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[t] = (((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + (K256[t] as number) + (w[t] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  odv.setUint32(20, h5, false);
  odv.setUint32(24, h6, false);
  odv.setUint32(28, h7, false);
  return toHex(out);
}

/**
 * Hash a user-attribute value for a **sensitive** comparator (research.md
 * §R2). Mirrors common-js `hashComparisonValue`:
 *
 * ```
 * sha256( utf8(value) + utf8(configJsonSalt) + utf8(contextSalt) )
 * ```
 *
 * concatenated with no separators, output as lowercase hex.
 *
 * @param value          the user attribute value as text (after attribute
 *                       conversion).
 * @param configJsonSalt the top-level config salt (`config.p.s`).
 * @param contextSalt    the per-evaluation discriminator — the setting key
 *                       for a user condition, or the segment name for a
 *                       segment condition.
 */
export function hashComparisonValue(
  value: string,
  configJsonSalt: string,
  contextSalt: string,
): string {
  return sha256(value + configJsonSalt + contextSalt);
}

/**
 * Compute a ConfigCat percentage bucket in `[0, 99]` for `key + attrValue`
 * (research.md §R2). Mirrors common-js `evaluatePercentageOptions`:
 *
 * ```
 * parseInt( sha1(key + attrValue).substring(0, 7), 16 ) % 100
 * ```
 *
 * SHA-1, **unsalted**. 7 hex chars = 28 bits, well within a safe 32-bit
 * `parseInt`.
 */
export function percentageBucket(key: string, attrValue: string): number {
  const hex = sha1(key + attrValue).substring(0, 7);
  return parseInt(hex, 16) % 100;
}
