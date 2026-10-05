// SPDX-License-Identifier: MIT

import type { Group, Registry } from "./commands/registry.ts";
import { VERSION } from "../version.ts";

const GLOBAL_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["-h, --help", "Print usage for the level invoked."],
  ["-V, --version", "Print the CLI version."],
  ["--json", "Emit machine-readable JSON where a command outputs data."],
  ["--profile <name>", "Select a named profile from config.json."],
  ["--api-url <url>", "Override the management API base URL."],
];

function pad(label: string, width: number): string {
  return label.padEnd(width, " ");
}

function renderRows(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, summary]) => `  ${pad(label, width)}  ${summary}`).join("\n");
}

/**
 * Root usage: the command groups + top-level commands + global flags (C1).
 */
export function renderRootHelp(registry: Registry): string {
  const commandRows: Array<readonly [string, string]> = [];
  for (const group of registry.groups.values()) {
    commandRows.push([group.name, group.summary]);
  }
  for (const leaf of registry.topLevel.values()) {
    commandRows.push([leaf.name, leaf.summary]);
  }

  return [
    "confeature — the Confeature feature-flag CLI",
    "",
    "USAGE:",
    "  confeature [global-flags] <command> [<subcommand>] [flags]",
    "",
    "COMMANDS:",
    renderRows(commandRows),
    "",
    "GLOBAL FLAGS:",
    renderRows(GLOBAL_FLAGS),
    "",
    `Run "confeature <command> --help" for more information on a command.`,
    `Version: ${VERSION}`,
  ].join("\n");
}

/**
 * Group usage: the leaf commands within one group (C2).
 */
export function renderGroupHelp(group: Group): string {
  const rows: Array<readonly [string, string]> = [];
  for (const leaf of group.commands.values()) {
    rows.push([leaf.name, leaf.summary]);
  }

  return [
    `confeature ${group.name} — ${group.summary}`,
    "",
    "USAGE:",
    `  confeature ${group.name} <command> [flags]`,
    "",
    "COMMANDS:",
    renderRows(rows),
  ].join("\n");
}

/**
 * Leaf usage: a single command's invocation line and summary.
 */
export function renderLeafHelp(
  groupName: string | undefined,
  leafName: string,
  summary: string,
): string {
  const path = groupName ? `${groupName} ${leafName}` : leafName;
  return [
    `confeature ${path} — ${summary}`,
    "",
    "USAGE:",
    `  confeature ${path} [flags]`,
  ].join("\n");
}
