// SPDX-License-Identifier: MIT

import type { IConfig } from "@confeature/sdk-shared";

/**
 * Event names emitted by the client — mirrors `configcat-common`'s
 * `HookEvents` exactly. Customer code that registers listeners via
 * `client.on("clientReady", ...)` keeps compiling unchanged.
 */
export interface HookEvents {
  clientReady: [];
  clientError: [message: string, exception?: unknown];
  configChanged: [config: IConfig];
  flagEvaluated: [details: IEvaluationDetails];
}

/**
 * Shape of the evaluation-detail payload emitted on `flagEvaluated`.
 * v1 never emits this event, but the type is exposed so listener
 * signatures continue to type-check.
 */
export interface IEvaluationDetails<TValue = unknown> {
  key: string;
  value: TValue;
  variationId?: string;
  fetchTime?: Date;
  user?: unknown;
  isDefaultValue: boolean;
  errorMessage?: string;
  errorException?: unknown;
  matchedTargetingRule?: unknown;
  matchedPercentageOption?: unknown;
}

/** Listener handle returned by {@link Hooks.on} — call `off()` to remove. */
export interface HookSubscription {
  /** Drop the listener. Idempotent. */
  off(): void;
}

/** Customer-facing read view — what {@link IConfigCatClient.on} exposes. */
export interface IProvidesHooks {
  on<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this;
  once<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this;
  off<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this;
}

type Listener = (...args: unknown[]) => void;

/**
 * Minimal typed event emitter. Used internally by the client.
 *
 * v1 emits `clientReady` (once, after the first fetch completes or
 * the init wait expires) and `clientError` (every error log line).
 * `configChanged` and `flagEvaluated` are wired but never fire — see
 * README "What the v1 SDK deliberately does NOT do".
 */
export class Hooks implements IProvidesHooks {
  private readonly listeners = new Map<keyof HookEvents, Listener[]>();
  private readonly onceFlags = new WeakSet<Listener>();

  on<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    this.add(event, listener as Listener);
    return this;
  }

  once<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    const wrapped: Listener = listener as Listener;
    this.onceFlags.add(wrapped);
    this.add(event, wrapped);
    return this;
  }

  off<E extends keyof HookEvents>(event: E, listener: (...args: HookEvents[E]) => void): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    const idx = list.indexOf(listener as Listener);
    if (idx >= 0) list.splice(idx, 1);
    return this;
  }

  /** Internal — fan out an event to its listeners. Errors swallowed. */
  emit<E extends keyof HookEvents>(event: E, ...args: HookEvents[E]): void {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;
    // Copy first so listeners that unsubscribe themselves don't skip
    // siblings.
    const copy = list.slice();
    for (const fn of copy) {
      try {
        fn(...(args as unknown[]));
      } catch {
        /* swallow — listener crashes must never propagate */
      }
      if (this.onceFlags.has(fn)) {
        this.off(event, fn as never);
      }
    }
  }

  /** Internal — clear all listeners (called from `dispose()`). */
  clear(): void {
    this.listeners.clear();
  }

  private add(event: keyof HookEvents, listener: Listener): void {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
  }
}
