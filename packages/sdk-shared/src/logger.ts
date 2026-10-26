// SPDX-License-Identifier: MIT

import { redactSdkKey } from "./sdk-key.ts";
import { SdkErrorCode } from "./types.ts";

/**
 * Log levels mirror `configcat-common`'s numeric ordering exactly so
 * level filtering ("Warn and above") works identically across SDKs.
 */
export const LogLevel = {
  Debug: 4,
  Info: 3,
  Warn: 2,
  Error: 1,
  Off: -1,
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Public logger interface — matches `IConfigCatLogger` in
 * `configcat-common/src/ConfigCatLogger.ts` verbatim. Customer-supplied
 * loggers are stored under `IOptions.logger` and forwarded by
 * {@link LoggerWrapper}.
 */
export interface IConfigCatLogger {
  level?: LogLevel;
  eol?: string;
  log(
    level: LogLevel,
    eventId: number | string,
    message: string | FormattableLogMessage,
    exception?: unknown,
  ): void;
}

/**
 * A message wrapper that defers formatting until the logger decides to
 * emit. Customers can subclass to support templated messages without
 * paying the formatting cost when the level is disabled.
 */
export class FormattableLogMessage {
  constructor(
    public readonly argNames: readonly string[],
    public readonly argValues: readonly unknown[],
    private readonly template: string,
  ) {}

  /**
   * Default formatting — substitutes `{name}` placeholders in
   * `template` with the matching `argValues` entry. Subclasses can
   * override for richer formatting.
   */
  toString(): string {
    return this.defaultFormattedMessage;
  }

  get defaultFormattedMessage(): string {
    let out = this.template;
    for (let i = 0; i < this.argNames.length; i++) {
      const name = this.argNames[i];
      if (name === undefined) continue;
      const value = this.argValues[i];
      out = out.replaceAll(`{${name}}`, String(value));
    }
    return out;
  }
}

/**
 * Console-backed default logger. Matches `configcat-common`'s
 * `ConfigCatConsoleLogger`. Customers get this by calling
 * {@link createConsoleLogger}.
 */
export class ConfigCatConsoleLogger implements IConfigCatLogger {
  constructor(
    public level: LogLevel = LogLevel.Warn,
    public eol = "\n",
  ) {}

  log(
    level: LogLevel,
    eventId: number | string,
    message: string | FormattableLogMessage,
    exception?: unknown,
  ): void {
    const formatted = typeof message === "string" ? message : message.toString();
    const line = `[${levelName(level)}] [${eventId}] ${formatted}`;
    switch (level) {
      case LogLevel.Error:
        console.error(line + this.eol, exception ?? "");
        break;
      case LogLevel.Warn:
        console.warn(line + this.eol);
        break;
      case LogLevel.Info:
        console.info(line + this.eol);
        break;
      case LogLevel.Debug:
        console.debug(line + this.eol);
        break;
      default:
        break;
    }
  }
}

/**
 * Factory matching `configcat-common`'s `createConsoleLogger` signature.
 */
export function createConsoleLogger(level: LogLevel, eol: string): IConfigCatLogger {
  return new ConfigCatConsoleLogger(level, eol);
}

/**
 * No-op logger used when the caller didn't supply one. Honours the
 * `IConfigCatLogger` interface so `LoggerWrapper` has a uniform target.
 */
export class NullLogger implements IConfigCatLogger {
  level: LogLevel = LogLevel.Off;
  eol = "\n";
  log(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _level: LogLevel,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _eventId: number | string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _message: string | FormattableLogMessage,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _exception?: unknown,
  ): void {
    /* intentional no-op */
  }
}

/**
 * Adapter around the caller's `IConfigCatLogger`. All internal log
 * sites go through these named helpers so:
 *  - the per-event-id `SdkErrorCode` is consistent everywhere,
 *  - level gating is centralised (zero allocations when disabled),
 *  - SDK keys are redacted at the boundary (security clause).
 */
export class LoggerWrapper {
  constructor(
    private readonly inner: IConfigCatLogger,
    private readonly onError?: (msg: string, exception?: unknown) => void,
  ) {}

  /** Level filter — callers can wrap heavy formatting in this guard. */
  isEnabled(level: LogLevel): boolean {
    const threshold = this.inner.level ?? LogLevel.Warn;
    if (threshold === LogLevel.Off) return false;
    return level <= threshold;
  }

  // ---- Public helpers -------------------------------------------------

  fetchFailed(sdkKey: string, status: number | string, exception?: unknown): void {
    this.emit(
      LogLevel.Error,
      SdkErrorCode.FETCH_FAILED,
      `Failed to fetch config (status=${status}, key=${redactSdkKey(sdkKey)}).`,
      exception,
    );
  }

  fetchTimeout(sdkKey: string, exception?: unknown): void {
    this.emit(
      LogLevel.Error,
      SdkErrorCode.FETCH_TIMEOUT,
      `Config fetch timed out (key=${redactSdkKey(sdkKey)}).`,
      exception,
    );
  }

  parseError(sdkKey: string, exception?: unknown): void {
    this.emit(
      LogLevel.Error,
      SdkErrorCode.PARSE_FAILED,
      `Failed to parse config payload (key=${redactSdkKey(sdkKey)}).`,
      exception,
    );
  }

  keyNotFound(key: string): void {
    this.emit(
      LogLevel.Info,
      SdkErrorCode.KEY_NOT_FOUND,
      `Setting "${key}" not found in config; returning default.`,
    );
  }

  typeMismatch(key: string, expected: string, actual: string): void {
    this.emit(
      LogLevel.Warn,
      SdkErrorCode.TYPE_MISMATCH,
      `Setting "${key}" type mismatch (expected ${expected}, got ${actual}); returning default.`,
    );
  }

  /**
   * `exception` is optional because the SDK clients' own last-resort catches
   * pass none: an error caught there may quote the keyed config URL, so it is
   * dropped and only this fixed message travels (#841, as #803 did for the
   * refresh path). The evaluator's catch still forwards its engine error.
   */
  evalError(key: string, exception?: unknown): void {
    this.emit(
      LogLevel.Error,
      SdkErrorCode.EVAL_FAILED,
      `Evaluation of setting "${key}" failed; returning default.`,
      exception,
    );
  }

  invalidSdkKey(sdkKey: string): void {
    this.emit(
      LogLevel.Error,
      SdkErrorCode.INVALID_SDK_KEY,
      `Invalid SDK key (key=${redactSdkKey(sdkKey)}). Subsequent evaluations will return defaults.`,
    );
  }

  configWarn(message: string): void {
    this.emit(LogLevel.Warn, SdkErrorCode.CONFIG_WARN, message);
  }

  /**
   * A targeting rule / percentage option needs a User Object that the caller
   * did not supply. ConfigCat logs this once per evaluation at WARN; the
   * evaluator serves the fallback (FR-016). Mirrors common-js
   * `userObjectIsMissing`.
   */
  userObjectIsMissing(key: string): void {
    this.emit(
      LogLevel.Warn,
      "3001",
      `cannot evaluate targeting rules and % options for setting '${key}' (User Object is missing); you should pass a User Object to the evaluation methods like \`getValue()\` in order to make targeting work properly; read more: https://configcat.com/docs/advanced/user-object/`,
    );
  }

  /**
   * A targeting rule references a User attribute the supplied User Object does
   * not carry. ConfigCat logs this once per missing attribute at WARN (event
   * 3003); the rule is ignored and evaluation continues. Mirrors common-js
   * `userObjectAttributeIsMissing`.
   */
  userObjectAttributeIsMissing(key: string, attributeName: string): void {
    this.emit(
      LogLevel.Warn,
      "3003",
      `cannot evaluate certain targeting rules of setting '${key}' (the User.${attributeName} attribute is missing); you should set the User.${attributeName} attribute in order to make targeting work properly; read more: https://configcat.com/docs/advanced/user-object/`,
    );
  }

  /**
   * The percentage-options keying attribute is missing on the supplied User.
   * ConfigCat logs a distinct WARN 3003 message ("% options" rather than
   * "certain targeting rules"); the % options are skipped. Mirrors common-js
   * `userObjectAttributeIsMissingPercentage`.
   */
  userObjectAttributeIsMissingForPercentage(key: string, attributeName: string): void {
    this.emit(
      LogLevel.Warn,
      "3003",
      `cannot evaluate % options for setting '${key}' (the User.${attributeName} attribute is missing); you should set the User.${attributeName} attribute in order to make targeting work properly; read more: https://configcat.com/docs/advanced/user-object/`,
    );
  }

  /**
   * A targeting-rule comparator could not convert a User attribute to the type
   * it needs (bad semver / number / datetime / array). ConfigCat logs a WARN
   * 3004 with the comparator-specific reason; the rule is ignored. Mirrors
   * common-js `userObjectAttributeIsInvalid`.
   */
  userObjectAttributeIsInvalid(key: string, attributeName: string, reason: string): void {
    this.emit(
      LogLevel.Warn,
      "3004",
      `cannot evaluate certain targeting rules of setting '${key}' (the User.${attributeName} attribute is invalid (${reason})); please check the User.${attributeName} attribute and make sure that its value corresponds to the comparison operator`,
    );
  }

  /**
   * A targeting-rule comparator's CONFIG comparison value is malformed (bad
   * semver / number operand). configcat-common validates the operand before the
   * user attribute (#509) and logs a distinct WARN 3004 — note there is NO
   * "please check the User.<attr>…" suffix, since the fault is in the config,
   * not the user. `innerMessage` is the full `comparison value '<v>' is invalid
   * (<reason>)` text. Mirrors common-js `RolloutEvaluator`'s comparison-value
   * error path.
   */
  comparisonValueIsInvalid(key: string, innerMessage: string): void {
    this.emit(
      LogLevel.Warn,
      "3004",
      `cannot evaluate certain targeting rules of setting '${key}' (${innerMessage})`,
    );
  }

  /**
   * A prerequisite-flag chain looped back on itself. ConfigCat fail-closes the
   * whole evaluation and logs an ERROR (event 1002) naming the setting + the
   * cycle path (`[a -> b -> a]`). Mirrors common-js `circularDependencyDetected`.
   */
  circularDependency(key: string, cycle: string): void {
    this.emit(
      LogLevel.Error,
      "1002",
      `failed to evaluate setting '${key}' (circular dependency detected between the following depending flags: [${cycle}])`,
    );
  }

  /**
   * Generic info — used sparingly. Never accepts an SDK key parameter;
   * any call site that needs to log a key passes the redacted form.
   * `eventId` is `string` (which subsumes `SdkErrorCode`) so callers
   * can pass either constant or ad-hoc identifiers.
   */
  info(eventId: string, message: string): void {
    this.emit(LogLevel.Info, eventId, message);
  }

  // ---- internal --------------------------------------------------------

  private emit(
    level: LogLevel,
    eventId: number | string,
    message: string | FormattableLogMessage,
    exception?: unknown,
  ): void {
    if (!this.isEnabled(level)) return;
    try {
      this.inner.log(level, eventId, message, exception);
    } catch {
      /* ignore logger errors — never let the logger crash the SDK */
    }
    if (level === LogLevel.Error && this.onError) {
      const formatted = typeof message === "string" ? message : message.toString();
      try {
        this.onError(formatted, exception);
      } catch {
        /* ignore */
      }
    }
  }
}

function levelName(level: LogLevel): string {
  switch (level) {
    case LogLevel.Debug:
      return "DEBUG";
    case LogLevel.Info:
      return "INFO";
    case LogLevel.Warn:
      return "WARN";
    case LogLevel.Error:
      return "ERROR";
    default:
      return "OFF";
  }
}
