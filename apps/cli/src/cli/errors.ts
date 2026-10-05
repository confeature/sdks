// SPDX-License-Identifier: MIT

import type { ExitCode } from "./exit.ts";

/**
 * Base class for every *expected* CLI error. It carries the {@link ExitCode}
 * the process should exit with, so the router's dispatch boundary can turn a
 * thrown domain error into a clean stderr message + exit code instead of a raw
 * stack trace (review HIGH: credential / parse / URL failures must not surface
 * a trace to the user).
 *
 * Subclasses just pass their message + exit code; the concrete class name is
 * captured automatically via `new.target`.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}
