// SPDX-License-Identifier: MIT

/**
 * Best-effort browser opener (spec 180 / #654).
 *
 * Spawns the platform's URL opener so `confeature login` can pop the approval
 * page. It is intentionally best-effort: if the opener is missing or fails (a
 * headless box, a sandbox, no `--allow-run`), it returns `false` and the caller
 * falls back to the URL it already printed — it NEVER throws or crashes the
 * login.
 *
 * The opener is injectable so the login test never spawns a real browser.
 */

/** Opens `url` in the default browser; returns whether the spawn succeeded. */
export type BrowserOpener = (url: string) => Promise<boolean>;

/**
 * The URL opener's binary on `os`: the one program the compiled binary may run
 * there (`scripts/compile.ts` grants exactly this one per target, #904).
 */
export function openerOf(os: string): "open" | "cmd" | "xdg-open" {
  switch (os) {
    case "darwin":
      return "open";
    case "windows":
      return "cmd";
    default:
      // Linux / *BSD.
      return "xdg-open";
  }
}

/** Resolve the platform opener command for a URL. */
function openerCommand(url: string): { cmd: string; args: string[] } {
  const cmd = openerOf(Deno.build.os);
  // `cmd /c start "" <url>` — the empty title arg avoids `start` swallowing a
  // quoted URL as the window title.
  return cmd === "cmd" ? { cmd, args: ["/c", "start", "", url] } : { cmd, args: [url] };
}

/**
 * Open `url` in the default browser. Returns `true` on a clean spawn, `false`
 * on any failure (opener not found, non-zero exit, missing `--allow-run`) —
 * never throws.
 */
export const openBrowser: BrowserOpener = async (url) => {
  const { cmd, args } = openerCommand(url);
  try {
    const command = new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const { success } = await command.output();
    return success;
  } catch {
    // Opener binary missing, permission denied, or `--allow-run` not granted —
    // the caller relies on the printed URL. Not an error worth surfacing.
    return false;
  }
};
