// SPDX-License-Identifier: MIT

import type { ConfigCatClient, IOptions, PollingMode } from "@confeature/sdk-browser-js";
import type { Mock } from "vitest";

export const admin: { targetingKey: string; Custom1: string };
export const viewer: { targetingKey: string; Custom1: string };
export const targetedFlag: string;
export const configPath: string;

export function checkedFixtureOrigin(origin: string | undefined): string;
export function guardedFetch(expected: string, transport: typeof fetch): typeof fetch;
export function installFixtureTransport(): {
  transport: Mock<typeof fetch>;
  createClient: (mode?: PollingMode, options?: IOptions) => ConfigCatClient;
  reseed: (attribute?: string) => Promise<void>;
};
