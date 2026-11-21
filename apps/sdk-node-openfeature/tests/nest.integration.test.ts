// SPDX-License-Identifier: MIT

import "reflect-metadata";
import { ConfeatureProvider } from "@confeature/openfeature-node";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OpenFeatureModule, getOpenFeatureClientToken, type Client } from "@openfeature/nestjs-sdk";
import { OpenFeature } from "@openfeature/server-sdk";
import { expect, it, vi } from "vitest";

import { admin, installFixtureTransport, targetedFlag } from "./fixture.ts";

it("resolves a targeted flag through the official NestJS module's injected client", async () => {
  const fixture = installFixtureTransport();
  const sdk = fixture.createClient();
  let app: INestApplicationContext | undefined;
  try {
    class FixtureModule {}
    Module({
      imports: [OpenFeatureModule.forRoot({ defaultProvider: new ConfeatureProvider(sdk) })],
    })(FixtureModule);
    app = await NestFactory.createApplicationContext(FixtureModule, {
      logger: false,
      abortOnError: false,
    });
    const flags = app.get<Client>(getOpenFeatureClientToken());
    await vi.waitFor(() => expect(flags.providerStatus).toBe("READY"), { timeout: 5000 });
    const result = await flags.getStringDetails(targetedFlag, "Fallback", admin);
    expect(result).toMatchObject({ value: "Dog", variant: "5b64d9b4" });
    expect(result.errorCode).toBeUndefined();
    expect(fixture.transport).toHaveBeenCalledTimes(1);
  } finally {
    try {
      if (app) await app.close();
      else await OpenFeature.close();
    } finally {
      sdk.dispose();
      vi.unstubAllGlobals();
    }
  }
});
