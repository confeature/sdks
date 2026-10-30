#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Strict JSON duplicate-key verifier.
//
// `JSON.parse` and most JSON tooling (including `jq`) silently take the
// LAST occurrence when a JSON object has duplicate keys — which is how a
// root `package.json` once ended up with six separate top-level `"ready"`
// scripts after cascading rebases, five of them dead. This script re-parses
// the file with a hand-rolled tokenizer that raises on any repeated key at
// any nesting depth.
//
// Usage: node tools/repo-gates/verify-no-dup-json-keys.mjs <file> [<file> ...]
// Exit codes: 0 = clean, 1 = duplicate(s) found, 2 = malformed JSON / I/O.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

/**
 * @param {string} json
 * @returns {{ path: string, key: string, line: number }[]}
 */
export function findDuplicateKeys(json) {
  /** @type {{ path: string, key: string, line: number }[]} */
  const dups = [];
  /** @type {string[]} */
  const path = [];
  let i = 0;
  let line = 1;

  function advance() {
    if (json[i] === "\n") line++;
    i++;
  }

  function skipWS() {
    while (i < json.length && /\s/.test(json[i])) advance();
  }

  /** @returns {string} */
  function parseString() {
    // assumes json[i] === '"'
    advance();
    let s = "";
    while (i < json.length && json[i] !== '"') {
      if (json[i] === "\\") {
        s += json[i] + (json[i + 1] || "");
        advance();
        advance();
      } else {
        s += json[i];
        advance();
      }
    }
    advance(); // closing quote
    return s;
  }

  function parseValue() {
    skipWS();
    if (json[i] === "{") return parseObject();
    if (json[i] === "[") return parseArray();
    if (json[i] === '"') return parseString();
    // primitive: skip until separator
    while (i < json.length && !/[,}\]\s]/.test(json[i])) advance();
  }

  function parseArray() {
    advance(); // [
    let idx = 0;
    skipWS();
    while (i < json.length && json[i] !== "]") {
      path.push(`[${idx}]`);
      parseValue();
      path.pop();
      idx++;
      skipWS();
      if (json[i] === ",") advance();
      skipWS();
    }
    advance(); // ]
  }

  function parseObject() {
    advance(); // {
    skipWS();
    /** @type {Map<string, number>} */
    const seen = new Map();
    while (i < json.length && json[i] !== "}") {
      const keyLine = line;
      if (json[i] !== '"') {
        throw new Error(`Expected key string at offset ${i} (line ${line})`);
      }
      const key = parseString();
      if (seen.has(key)) {
        dups.push({
          path: path.length ? path.join(".") + "." + key : key,
          key,
          line: keyLine,
        });
      }
      seen.set(key, keyLine);
      skipWS();
      if (json[i] !== ":") {
        throw new Error(`Expected ':' after key '${key}' at line ${line}`);
      }
      advance(); // :
      path.push(key);
      parseValue();
      path.pop();
      skipWS();
      if (json[i] === ",") advance();
      skipWS();
    }
    advance(); // }
  }

  parseValue();
  // The tokenizer tolerates EOF anywhere, so a file cut short (an unterminated
  // string, object or array) used to read as clean (#870 item 7). JSON.parse
  // then judges the whole syntax: malformed or truncated input throws, and the
  // CLI exits 2.
  JSON.parse(json);
  return dups;
}

/** The CLI: returns the exit code. */
export function main(files) {
  if (files.length === 0) {
    console.error("Usage: verify-no-dup-json-keys.mjs <file> [<file> ...]");
    return 2;
  }
  let bad = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      console.error(`✗ ${file}: cannot read (${err.message})`);
      return 2;
    }
    let dups;
    try {
      dups = findDuplicateKeys(text);
    } catch (err) {
      console.error(`✗ ${file}: malformed JSON (${err.message})`);
      return 2;
    }
    if (dups.length === 0) {
      console.log(`✓ ${file}: no duplicate keys`);
    } else {
      bad++;
      console.error(`✗ ${file}: ${dups.length} duplicate key(s):`);
      for (const d of dups) {
        console.error(`    line ${d.line}: ${d.path}`);
      }
    }
  }
  return bad > 0 ? 1 : 0;
}

const HERE = fileURLToPath(import.meta.url);

if (isEntry(process.argv[1], HERE)) process.exit(main(process.argv.slice(2)));
