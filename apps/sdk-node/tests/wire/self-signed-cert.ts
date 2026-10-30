// SPDX-License-Identifier: MIT

/**
 * A throwaway self-signed TLS certificate for `127.0.0.1`, minted in-process.
 *
 * Why hand-rolled: the redirect cases (#834) need a REAL https origin for
 * Node's own `fetch` (undici) — the refusal is decided on the scheme of the
 * request just sent — and Node can sign but not build an X.509 certificate.
 * Committing a key pair would put a private key in a public repo, and a cert
 * library would be a new dependency for one test. So this is the minimum DER:
 * an ECDSA P-256 v3 certificate with one extension, subjectAltName
 * IP:127.0.0.1, valid for a day.
 */

import { generateKeyPairSync, sign } from "node:crypto";

/** DER length octets. */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...c: Buffer[]): Buffer => tlv(0x30, ...c);
const OID_ECDSA_SHA256 = Buffer.from("06082a8648ce3d040302", "hex");
const OID_COMMON_NAME = Buffer.from("0603550403", "hex");
const OID_SUBJECT_ALT_NAME = Buffer.from("0603551d11", "hex");

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-10-27T12:34:56.789Z
  const text = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const time = iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
  return tlv(0x17, Buffer.from(`${text}${time}Z`, "ascii"));
}

/** A PEM certificate and key for `https.createServer`, the cert also its own CA. */
export function selfSignedLoopbackCert(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = seq(
    tlv(0x31, seq(OID_COMMON_NAME, tlv(0x0c, Buffer.from("confeature-test", "utf8")))),
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // v3
    tlv(0x02, Buffer.from([0x01])), // serial
    seq(OID_ECDSA_SHA256),
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(
      0xa3,
      seq(
        seq(
          OID_SUBJECT_ALT_NAME,
          tlv(0x04, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])))), // iPAddress
        ),
      ),
    ),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, seq(OID_ECDSA_SHA256), tlv(0x03, Buffer.from([0x00]), signature));
  const base64 = der.toString("base64").replace(/.{64}/g, "$&\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
