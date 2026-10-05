// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";

import { FormattableLogMessage, LoggerWrapper, LogLevel, NullLogger } from "../../src/logger.ts";
import { CONFEATURE_SDK_KEY_PATTERN } from "../../src/sdk-key.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("LoggerWrapper.isEnabled", () => {
  test("Off threshold suppresses everything", () => {
    const inner = { level: LogLevel.Off, eol: "\n", log: vi.fn() };
    const lw = new LoggerWrapper(inner);
    expect(lw.isEnabled(LogLevel.Error)).toBe(false);
    expect(lw.isEnabled(LogLevel.Warn)).toBe(false);
    expect(lw.isEnabled(LogLevel.Info)).toBe(false);
    expect(lw.isEnabled(LogLevel.Debug)).toBe(false);
  });

  test("Warn threshold lets Error+Warn through, suppresses Info+Debug", () => {
    const inner = { level: LogLevel.Warn, eol: "\n", log: vi.fn() };
    const lw = new LoggerWrapper(inner);
    expect(lw.isEnabled(LogLevel.Error)).toBe(true);
    expect(lw.isEnabled(LogLevel.Warn)).toBe(true);
    expect(lw.isEnabled(LogLevel.Info)).toBe(false);
    expect(lw.isEnabled(LogLevel.Debug)).toBe(false);
  });

  test("Debug threshold lets everything through", () => {
    const inner = { level: LogLevel.Debug, eol: "\n", log: vi.fn() };
    const lw = new LoggerWrapper(inner);
    expect(lw.isEnabled(LogLevel.Error)).toBe(true);
    expect(lw.isEnabled(LogLevel.Warn)).toBe(true);
    expect(lw.isEnabled(LogLevel.Info)).toBe(true);
    expect(lw.isEnabled(LogLevel.Debug)).toBe(true);
  });

  test("default threshold (no level set) behaves like Warn", () => {
    const inner = { eol: "\n", log: vi.fn() };
    const lw = new LoggerWrapper(inner);
    expect(lw.isEnabled(LogLevel.Error)).toBe(true);
    expect(lw.isEnabled(LogLevel.Warn)).toBe(true);
    expect(lw.isEnabled(LogLevel.Info)).toBe(false);
  });
});

describe("LoggerWrapper error hook", () => {
  test("clientError callback fires on every Error log", () => {
    const sink = vi.fn();
    const onError = vi.fn();
    const lw = new LoggerWrapper({ level: LogLevel.Error, eol: "\n", log: sink }, onError);
    lw.fetchFailed(SDK_KEY, 500);
    lw.parseError(SDK_KEY);
    lw.evalError("k", new Error("boom"));
    lw.invalidSdkKey(SDK_KEY);
    expect(onError.mock.calls.length).toBe(4);
  });

  test("Warn-level events do NOT fire the clientError hook", () => {
    const sink = vi.fn();
    const onError = vi.fn();
    const lw = new LoggerWrapper({ level: LogLevel.Debug, eol: "\n", log: sink }, onError);
    lw.typeMismatch("k", "boolean", "string");
    lw.configWarn("warn");
    expect(onError).not.toHaveBeenCalled();
  });

  test("logger.log throws — the wrapper still calls onError and does not propagate", () => {
    const sink = vi.fn(() => {
      throw new Error("logger crashed");
    });
    const onError = vi.fn();
    const lw = new LoggerWrapper({ level: LogLevel.Error, eol: "\n", log: sink }, onError);
    expect(() => {
      lw.fetchFailed(SDK_KEY, 500);
    }).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

describe("LoggerWrapper — SECURITY: SDK keys must not leak (constitution clause)", () => {
  test("regex assert no SDK-key in any captured line across all helper calls", () => {
    const captured: string[] = [];
    const inner = {
      level: LogLevel.Debug,
      eol: "\n",
      log(level: LogLevel, eventId: number | string, message: string | FormattableLogMessage) {
        const formatted = typeof message === "string" ? message : message.toString();
        captured.push(`${String(level)}|${String(eventId)}|${formatted}`);
      },
    };
    const lw = new LoggerWrapper(inner);

    // Every helper that accepts an SDK key.
    lw.fetchFailed(SDK_KEY, 500, new Error("net"));
    lw.fetchTimeout(SDK_KEY, new Error("t"));
    lw.parseError(SDK_KEY, new SyntaxError("bad"));
    lw.invalidSdkKey(SDK_KEY);

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(SDK_KEY);
      expect(CONFEATURE_SDK_KEY_PATTERN.test(line)).toBe(false);
    }
  });

  test("redacted form is still recognisable (head + tail visible)", () => {
    const captured: string[] = [];
    const inner = {
      level: LogLevel.Error,
      eol: "\n",
      log(_l: LogLevel, _e: number | string, message: string | FormattableLogMessage) {
        captured.push(typeof message === "string" ? message : message.toString());
      },
    };
    const lw = new LoggerWrapper(inner);
    lw.invalidSdkKey(SDK_KEY);
    const joined = captured.join("\n");
    expect(joined).toContain("[redacted]");
    // The first 4 chars of the key should survive ('confeature' starts
    // with these 4 — see redactSdkKey, visible = max(4, 10% of length)).
    expect(joined).toContain(SDK_KEY.slice(0, 4));
    // The last 4 chars of the key should also survive.
    expect(joined).toContain(SDK_KEY.slice(-4));
  });
});

describe("FormattableLogMessage", () => {
  test("substitutes named placeholders", () => {
    const m = new FormattableLogMessage(["key"], ["dark-mode"], 'Setting "{key}" missing.');
    expect(m.defaultFormattedMessage).toBe('Setting "dark-mode" missing.');
  });
});

describe("NullLogger", () => {
  test("does nothing and never throws", () => {
    const nl = new NullLogger();
    expect(() => {
      nl.log(LogLevel.Error, "X", "msg");
    }).not.toThrow();
  });
});
