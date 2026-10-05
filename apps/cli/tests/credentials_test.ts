// SPDX-License-Identifier: MIT

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  clearToken,
  CorruptCredentialError,
  readToken,
  writeToken,
} from "../src/auth/credentials.ts";
import {
  credentialFilePath,
  credentialsDir,
  InvalidProfileNameError,
} from "../src/config/paths.ts";

const POSIX = Deno.build.os !== "windows";

/** Run `fn` with a throwaway XDG_CONFIG_HOME so we never touch the real store. */
async function withTempConfig(fn: () => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "confeature-cli-creds-" });
  const prevXdg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", tmp);
  try {
    await fn();
  } finally {
    if (prevXdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prevXdg);
    await Deno.remove(tmp, { recursive: true });
  }
}

// C13 — after writeToken: file mode is 0600, dir is 0700 (POSIX).
Deno.test("C13: writeToken sets file 0600 and dir 0700", async () => {
  await withTempConfig(async () => {
    await writeToken("default", "secret-token-abc");

    const fileInfo = await Deno.stat(credentialFilePath("default"));
    const dirInfo = await Deno.stat(credentialsDir());

    if (POSIX) {
      assertEquals(fileInfo.mode! & 0o777, 0o600, "credential file must be 0600");
      assertEquals(dirInfo.mode! & 0o777, 0o700, "credentials dir must be 0700");
    }
  });
});

// C14 — write → read → clear → read round-trips, then null after clear.
Deno.test("C14: write→read→clear→read round-trip returns null after clear", async () => {
  await withTempConfig(async () => {
    assertEquals(await readToken("default"), null);

    await writeToken("default", "secret-token-xyz");
    assertEquals(await readToken("default"), "secret-token-xyz");

    await clearToken("default");
    assertEquals(await readToken("default"), null);

    // clearToken is idempotent — no error when already absent.
    await clearToken("default");
  });
});

// Defensive: readToken refuses a group/world-readable file (POSIX).
Deno.test("readToken refuses an over-permissive credential file (POSIX)", async () => {
  if (!POSIX) return;
  await withTempConfig(async () => {
    await writeToken("default", "secret-token-perm");
    // Loosen the perms behind the store's back.
    await Deno.chmod(credentialFilePath("default"), 0o644);

    let threw = false;
    try {
      await readToken("default");
    } catch (error) {
      threw = true;
      const msg = error instanceof Error ? error.message : String(error);
      assertEquals(msg.includes("group/world-accessible"), true);
    }
    assertEquals(threw, true, "readToken must refuse a 0644 credential file");
  });
});

// Path-traversal guard: an unsafe profile name is rejected at the path choke
// point, so it can never escape the credentials directory (security HIGH).
Deno.test("credential path rejects a path-traversal / unsafe profile name", () => {
  assertThrows(() => credentialFilePath("../evil"), InvalidProfileNameError);
  assertThrows(() => credentialFilePath("a/b"), InvalidProfileNameError);
  assertThrows(() => credentialFilePath(".."), InvalidProfileNameError);
});

Deno.test("readToken / writeToken reject an unsafe profile name", async () => {
  await assertRejects(() => readToken("../evil"), InvalidProfileNameError);
  await assertRejects(() => writeToken("../evil", "t"), InvalidProfileNameError);
});

// A correctly-permissioned but corrupt credential file surfaces a clean domain
// error, never a raw SyntaxError stack trace (security/test HIGH).
Deno.test("readToken throws CorruptCredentialError on invalid JSON", async () => {
  await withTempConfig(async () => {
    await writeToken("default", "good"); // creates the dir 0700
    await Deno.writeTextFile(credentialFilePath("default"), "{ corrupt");
    if (POSIX) await Deno.chmod(credentialFilePath("default"), 0o600);
    await assertRejects(() => readToken("default"), CorruptCredentialError);
  });
});
