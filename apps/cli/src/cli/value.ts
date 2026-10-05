// SPDX-License-Identifier: MIT

import { CliError } from "./errors.ts";
import { ExitCode } from "./exit.ts";
import type { components } from "@confeature/contract/api";

/**
 * Value coercion for `flag value update` (spec 182 / #656).
 *
 * The PUT body requires a TYPED `value` (boolean | string | number) that
 * respects the setting's declared `settingType`; the user passes `--value`
 * as a raw string. This module turns that raw string into the typed value
 * the flag's declared type demands — ConfigCat-parity: the CLI learns the
 * type from the flag (via the GET-value response), the user never passes it.
 *
 * A value that does NOT parse for the declared type throws a clear,
 * type-naming {@link CliError} with the USAGE exit code — raised BEFORE any
 * network write so a wrong-type input never reaches the server (FR-003,
 * R4). The server re-validates (`valueRespectsType`) as defence in depth.
 */

/** The four-member ConfigCat `SettingType`, threaded from the contract. */
type SettingType = components["schemas"]["SettingType"];

/** The typed value the PUT body carries (ConfigCat's `SettingValueType`). */
export type TypedValue = boolean | string | number;

/** Build the type-naming usage error a non-parsing value raises. */
function rejectValue(raw: string, type: SettingType, expectation: string): never {
  throw new CliError(
    `flag value update: '${raw}' is not a valid ${type} value — ${expectation}.`,
    ExitCode.USAGE,
  );
}

/**
 * Coerce the raw `--value` string to the typed value the flag's declared
 * `settingType` requires:
 *   - `boolean` → `true`/`false` (case-insensitive; nothing else parses);
 *   - `int`     → an integer (rejects decimals, `NaN`, non-numeric text);
 *   - `double`  → any finite number (rejects `NaN`/±`Infinity`, non-numeric);
 *   - `string`  → the literal string (every input is a valid string).
 *
 * Throws a {@link CliError} (USAGE) naming the type on a non-parsing value.
 */
export function coerceValue(raw: string, type: SettingType): TypedValue {
  switch (type) {
    case "boolean": {
      const lowered = raw.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
      return rejectValue(raw, type, "expected `true` or `false`");
    }
    case "int": {
      const trimmed = raw.trim();
      // Plain decimal integers ONLY. The regex rejects blank, decimals, hex
      // (`0x10`), and scientific notation (`1e3`) — all of which `Number()`
      // would otherwise accept and silently turn into a different number than
      // the operator typed. `isSafeInteger` then rejects values past 2^53-1
      // that would lose precision before the PUT.
      if (!/^-?\d+$/.test(trimmed)) {
        return rejectValue(raw, type, "expected a whole number");
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed)) {
        return rejectValue(raw, type, "whole number is outside the safe integer range");
      }
      return parsed;
    }
    case "double": {
      const trimmed = raw.trim();
      const parsed = Number(trimmed);
      if (trimmed.length === 0 || !Number.isFinite(parsed)) {
        return rejectValue(raw, type, "expected a finite number");
      }
      return parsed;
    }
    case "string":
      return raw;
  }
}
