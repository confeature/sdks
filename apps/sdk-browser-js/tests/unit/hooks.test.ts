// SPDX-License-Identifier: MIT

/**
 * Unit tests for the hand-rolled `Hooks` emitter (T053, US2).
 *
 * Coverage:
 *  - `on` / `off` round-trip: listener fires; off() unsubscribes.
 *  - `once` fires exactly once and self-unsubscribes.
 *  - Multiple listeners all fire on emit().
 *  - Listener throws are swallowed and don't break sibling listeners.
 *  - `clear()` wipes every registration.
 *  - Self-unsubscribe mid-emit is safe (no skipping subsequent listeners).
 */

import { describe, expect, test } from "vitest";

import { Hooks } from "../../src/hooks.ts";

describe("Hooks — on/off lifecycle", () => {
  test("on() registers a listener that fires on emit()", () => {
    const hooks = new Hooks();
    const calls: string[] = [];
    hooks.on("clientError", (msg: string) => calls.push(msg));
    hooks.emit("clientError", "boom");
    expect(calls).toEqual(["boom"]);
  });

  test("off() removes the listener — no further fires", () => {
    const hooks = new Hooks();
    const calls: string[] = [];
    const fn = (m: string): void => {
      calls.push(m);
    };
    hooks.on("clientError", fn);
    hooks.emit("clientError", "first");
    hooks.off("clientError", fn);
    hooks.emit("clientError", "second");
    expect(calls).toEqual(["first"]);
  });

  test("off() for an unregistered listener is a no-op", () => {
    const hooks = new Hooks();
    expect(() => hooks.off("clientError", () => {})).not.toThrow();
  });
});

describe("Hooks — once", () => {
  test("once() fires exactly one time", () => {
    const hooks = new Hooks();
    let count = 0;
    hooks.once("clientReady", () => count++);
    hooks.emit("clientReady");
    hooks.emit("clientReady");
    hooks.emit("clientReady");
    expect(count).toBe(1);
  });
});

describe("Hooks — multiple listeners + crash isolation", () => {
  test("emit() fans out to every registered listener", () => {
    const hooks = new Hooks();
    const calls: string[] = [];
    hooks.on("clientError", (m: string) => calls.push(`a:${m}`));
    hooks.on("clientError", (m: string) => calls.push(`b:${m}`));
    hooks.on("clientError", (m: string) => calls.push(`c:${m}`));
    hooks.emit("clientError", "ping");
    expect(calls).toEqual(["a:ping", "b:ping", "c:ping"]);
  });

  test("a throwing listener does not stop sibling listeners", () => {
    const hooks = new Hooks();
    const called: string[] = [];
    hooks.on("clientError", () => {
      throw new Error("listener crashed");
    });
    hooks.on("clientError", () => called.push("sibling ran"));
    expect(() => hooks.emit("clientError", "irrelevant")).not.toThrow();
    expect(called).toEqual(["sibling ran"]);
  });

  test("listener unsubscribing itself mid-emit is safe", () => {
    const hooks = new Hooks();
    const calls: string[] = [];
    const self = (m: string): void => {
      calls.push(`self:${m}`);
      hooks.off("clientError", self);
    };
    const sibling = (m: string): void => {
      calls.push(`sibling:${m}`);
    };
    hooks.on("clientError", self);
    hooks.on("clientError", sibling);
    hooks.emit("clientError", "x");
    expect(calls).toEqual(["self:x", "sibling:x"]);
    // Next emit only fires the sibling.
    hooks.emit("clientError", "y");
    expect(calls).toEqual(["self:x", "sibling:x", "sibling:y"]);
  });
});

describe("Hooks — clear()", () => {
  test("clear() removes every registration across all events", () => {
    const hooks = new Hooks();
    let aCount = 0;
    let bCount = 0;
    hooks.on("clientError", () => aCount++);
    hooks.on("clientReady", () => bCount++);
    hooks.clear();
    hooks.emit("clientError", "x");
    hooks.emit("clientReady");
    expect(aCount).toBe(0);
    expect(bCount).toBe(0);
  });
});

describe("Hooks — configChanged event payload typing", () => {
  test("configChanged listener receives the IConfig payload", () => {
    const hooks = new Hooks();
    const received: unknown[] = [];
    hooks.on("configChanged", (cfg) => received.push(cfg));
    const payload = {
      p: { u: "x", r: 0, s: "v1" },
      f: {},
      s: [],
    };
    hooks.emit("configChanged", payload as never);
    expect(received).toEqual([payload]);
  });
});
