// SPDX-License-Identifier: MIT

/**
 * Split shell text at its top-level `;`, `&&` and `||` (outside quotes,
 * `$( )` and `{ … }` groups), keeping the pieces. A group opens on a `{`
 * word where a command starts and closes on a `}` where a command starts
 * (round 9): the `{` of `${file}` is never a group, so a group stays one
 * piece whatever it holds. Enough for one line of a pack job's block.
 */
function topLevelCommands(text) {
  const out = [];
  let cur = "";
  let q = null;
  let depth = 0;
  let group = 0;
  let atStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q !== null) {
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (text.startsWith("$(", i)) {
      depth += 1;
      cur += "$(";
      i += 1;
    } else if (c === ")" && depth > 0) {
      depth -= 1;
      cur += c;
    } else if (depth === 0 && atStart && c === "{" && /\s/.test(text[i + 1] ?? "")) {
      group += 1;
      cur += c;
      continue;
    } else if (depth === 0 && atStart && c === "}" && group > 0) {
      group -= 1;
      cur += c;
    } else if (depth === 0 && (c === ";" || text.startsWith("&&", i) || text.startsWith("||", i))) {
      const two = c !== ";";
      if (group === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += two ? text.slice(i, i + 2) : c;
      if (two) i += 1;
      atStart = true;
      continue;
    } else cur += c;
    if (!/\s/.test(c)) atStart = false;
  }
  out.push(cur.trim());
  return out.filter((x) => x !== "");
}

/**
 * Whether one line writes `<name>` to $GITHUB_OUTPUT (round 8): the command
 * that redirects `>> "$GITHUB_OUTPUT"` (or the first command of the `{ … }`
 * group that does, the group found by topLevelCommands, round 9) is an echo or printf whose first argument starts with
 * `<name>=` or `<name><<`. A decoy `echo "name=" >/dev/null; printf x >>
 * "$GITHUB_OUTPUT"` or a comment writes nothing.
 */
export function writesOutput(line, name) {
  const m = /^(.*?)>>\s*"?\$\{?GITHUB_OUTPUT\}?"?\s*$/.exec(line.trim());
  if (m === null || m[1].trimStart().startsWith("#")) return false;
  const cmds = topLevelCommands(m[1]);
  let cmd = cmds.at(-1) ?? "";
  // A group is one piece of topLevelCommands: its first command is the write.
  if (/^\{\s/.test(cmd) && /[;\s]\}$/.test(cmd)) cmd = topLevelCommands(cmd.slice(1, -1))[0] ?? "";
  const w = /^(echo|printf)\s+(['"]?)(.*)$/.exec(cmd);
  if (w === null) return false;
  return w[3].startsWith(`${name}=`) || w[3].startsWith(`${name}<<`);
}
