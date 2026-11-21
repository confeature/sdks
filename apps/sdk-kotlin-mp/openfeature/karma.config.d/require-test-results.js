// SPDX-License-Identifier: MIT
/* global config */

config.set({
  failOnEmptyTestSuite: true,
  failOnFailingTestSuite: true,
});

if (process.env.CONFEATURE_KOTLIN_BROWSER_ORIGIN) {
  const origin = new URL(process.env.CONFEATURE_KOTLIN_BROWSER_ORIGIN);
  const facade = new URL(process.env.CONFEATURE_KOTLIN_BROWSER_FACADE);
  if (
    [origin, facade].some(
      (url) =>
        url.hostname !== "127.0.0.1" ||
        url.protocol !== "http:" ||
        !url.port ||
        url.href !== url.origin + "/",
    )
  ) {
    throw new Error("Karma needs local fixture endpoints.");
  }
  const configRoute = "/configuration-files/";
  const redirectRoute = "/fixture-redirect/configuration-files/";
  config.set({
    client: { mocha: { timeout: 20_000 } },
    hostname: "127.0.0.1",
    listenAddress: "127.0.0.1",
    port: Number(origin.port),
    proxies: {
      [configRoute]: facade.origin + configRoute,
      [redirectRoute]: facade.origin + redirectRoute,
    },
  });
}
