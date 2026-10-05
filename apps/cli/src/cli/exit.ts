// SPDX-License-Identifier: MIT

/**
 * Process exit codes — the single source for the CLI's exit-code contract
 * (data-model.md exit-code table).
 *
 * | Code | Name              | Meaning                                                   |
 * | ---- | ----------------- | -------------------------------------------------------- |
 * | 0    | `OK`              | Success (incl. `--help`, `--version`).                   |
 * | 1    | `RUNTIME`         | Unexpected runtime error.                                |
 * | 2    | `USAGE`           | Unknown group/command/flag, invalid args, bad profile.   |
 * | 3    | `NOT_IMPLEMENTED` | A stub leaf was invoked.                                 |
 * | 4    | `AUTH`            | Auth-state failure (operation needs login while logged out). |
 */
export const ExitCode = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  NOT_IMPLEMENTED: 3,
  AUTH: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
