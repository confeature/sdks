// SPDX-License-Identifier: MIT

/**
 * src/fr001-path.ts — the oracle's FR-001 escaper (#803). Every pinned byte
 * below is real `go run` output of Go's `url.PathEscape`; the refusals are
 * the keys FR-001 gives no path (the SDK must not fetch).
 */

import { describe, expect, it } from "vitest";

import { fr001Path, pathEscape } from "../src/fr001-path.ts";

describe("pathEscape — Go url.PathEscape, byte for byte", () => {
  it("keeps exactly A-Z a-z 0-9 - _ . ~ $ & + : = @ among the 128 ASCII bytes", () => {
    // Go: for b in 0..127, url.PathEscape(string(b)) == string(b).
    const kept = [];
    for (let b = 0; b < 128; b++) {
      const char = String.fromCharCode(b);
      if (pathEscape(char) === char) kept.push(char);
    }
    expect(kept.join("")).toBe(
      "$&+-.0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~",
    );
  });

  it("escapes every other ASCII byte as %XX with uppercase hex", () => {
    expect(pathEscape(" /;,?#%!'()*")).toBe("%20%2F%3B%2C%3F%23%25%21%27%28%29%2A");
    expect(pathEscape("\x7f\x1f")).toBe("%7F%1F");
  });

  it("escapes a 2-, 3- and 4-byte UTF-8 character byte by byte, not per UTF-16 unit", () => {
    expect(pathEscape("é")).toBe("%C3%A9");
    expect(pathEscape("€")).toBe("%E2%82%AC");
    // U+1F600 is a surrogate pair in a JS string; Go sees 4 UTF-8 bytes.
    expect(pathEscape("😀")).toBe("%F0%9F%98%80");
  });

  it("refuses a lone surrogate (no UTF-8 encoding, so no path)", () => {
    expect(() => pathEscape("a\ud800b")).toThrow(/lone surrogate/);
    expect(() => pathEscape("\udc00")).toThrow(/lone surrogate/);
  });
});

describe("fr001Path — the request path for a key", () => {
  it("refuses '', '.' and '..' — no escaper keeps them in their segment", () => {
    for (const key of ["", ".", ".."]) {
      expect(() => fr001Path(key)).toThrow(/has no path/);
    }
  });

  it("does not refuse '...' or a key merely containing '..'", () => {
    expect(fr001Path("...")).toBe("/configuration-files/.../config_v6.json");
    expect(fr001Path("a..")).toBe("/configuration-files/a../config_v6.json");
  });

  it("sends a ConfigCat-shaped key raw — three segments, '/' kept", () => {
    expect(fr001Path("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d")).toBe(
      "/configuration-files/configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json",
    );
  });

  it("sends a legacy key raw", () => {
    const key =
      "confeature-sdk-1-FAKE_fixtureKeyN-otRealFAKEfi-03-FAKEfixtureKeyNotRealFAKEfixtu04";
    expect(fr001Path(key)).toBe(`/configuration-files/${key}/config_v6.json`);
  });

  it("escapes a malformed key into ONE segment — its '/' becomes %2F", () => {
    // One 21-char part: fails the shape check, so the '/' does not survive.
    expect(fr001Path("configcat-sdk-1/FAKEfixtureKeyNotRe05/FAKEfixtureKeyNotRea06")).toBe(
      "/configuration-files/configcat-sdk-1%2FFAKEfixtureKeyNotRe05%2FFAKEfixtureKeyNotRea06/config_v6.json",
    );
  });

  it("matches Go on the corpus's malformed key (request-path-malformed-key)", () => {
    expect(fr001Path("bad key$&+:=@,;!'()*~/x?y#z%é€😀..")).toBe(
      "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80../config_v6.json",
    );
  });

  it("refuses a malformed key carrying a lone surrogate", () => {
    expect(() => fr001Path("bad\ud800key")).toThrow(/lone surrogate/);
  });
});
