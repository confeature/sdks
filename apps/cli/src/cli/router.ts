// SPDX-License-Identifier: MIT

import { ExitCode } from "./exit.ts";
import { CliError } from "./errors.ts";
import { parseGlobals } from "./globals.ts";
import type { Globals } from "./globals.ts";
import type { Leaf, Registry, RunContext } from "./commands/registry.ts";
import { renderGroupHelp, renderLeafHelp, renderRootHelp } from "./help.ts";
import { defaultIo, type Io } from "./io.ts";
import { VERSION } from "../version.ts";

export type { Io } from "./io.ts";

function makeContext(globals: Globals, args: string[], io: Io): RunContext {
  return { globals, args, io };
}

/**
 * Dispatch `argv` (everything after the program name) against the registry.
 *
 * Behaviour (contract C1–C6, C16):
 *   - `--version` short-circuits to the version string, exit 0.
 *   - `--help` with no command prints root usage, exit 0.
 *   - `<group> --help` prints that group's commands, exit 0.
 *   - `<group> <leaf> --help` prints the leaf usage, exit 0.
 *   - an unknown top-level command → "unknown command '<x>'", exit 2.
 *   - an unknown leaf in a known group → distinct message naming the group, exit 2.
 *   - a known leaf runs and returns its own exit code.
 */
export async function route(
  argv: string[],
  registry: Registry,
  io: Io = defaultIo,
): Promise<ExitCode> {
  const { globals, positionals } = parseGlobals(argv);

  // `--version` wins over everything (FR-001).
  if (globals.version) {
    io.out(VERSION);
    return ExitCode.OK;
  }

  // No command path: root help (whether or not `--help` was passed).
  if (positionals.length === 0) {
    io.out(renderRootHelp(registry));
    return ExitCode.OK;
  }

  const [first, second, ...rest] = positionals;

  // Top-level command (e.g. `whoami`).
  const topLeaf = registry.topLevel.get(first);
  if (topLeaf) {
    if (globals.help) {
      io.out(renderLeafHelp(undefined, topLeaf.name, topLeaf.summary));
      return ExitCode.OK;
    }
    return await dispatchLeaf(topLeaf, globals, [second, ...rest].filter(isDefined), io);
  }

  // Group command (e.g. `flag ls`).
  const group = registry.groups.get(first);
  if (group) {
    // `<group> --help` or a bare group with no leaf → group usage.
    if (globals.help || second === undefined) {
      io.out(renderGroupHelp(group));
      // `--help` is success; a bare group with no leaf is an incomplete usage.
      return globals.help ? ExitCode.OK : ExitCode.USAGE;
    }

    const leaf = group.commands.get(second);
    if (!leaf) {
      io.err(
        `unknown command '${second}' in group '${group.name}'. ` +
          `Run "confeature ${group.name} --help" to list available commands.`,
      );
      return ExitCode.USAGE;
    }
    return await dispatchLeaf(leaf, globals, rest, io);
  }

  // Neither a top-level command nor a group.
  io.err(
    `unknown command '${first}'. Run "confeature --help" to list available commands.`,
  );
  return ExitCode.USAGE;
}

async function dispatchLeaf(
  leaf: Leaf,
  globals: Globals,
  args: string[],
  io: Io,
): Promise<ExitCode> {
  if (globals.help) {
    io.out(renderLeafHelp(undefined, leaf.name, leaf.summary));
    return ExitCode.OK;
  }
  // The dispatch boundary owns error→exit-code mapping: an expected `CliError`
  // becomes a clean stderr message + its own exit code; anything else is a
  // RUNTIME failure reported without a raw stack trace.
  try {
    return await leaf.run(makeContext(globals, args, io));
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.exitCode;
    }
    const detail = error instanceof Error ? error.message : String(error);
    io.err(`error: ${detail}`);
    return ExitCode.RUNTIME;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
