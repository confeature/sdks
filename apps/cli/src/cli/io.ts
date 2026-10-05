// SPDX-License-Identifier: MIT

/**
 * Output sinks, injectable so tests can capture stdout/stderr without spawning
 * a subprocess. Defaults route to the console.
 */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** The default sinks: stdout via `console.log`, stderr via `console.error`. */
export const defaultIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};
