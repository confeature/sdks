// SPDX-License-Identifier: MIT

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [sourceArg, destinationArg, originArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg || !originArg) {
  throw new Error("Usage: stage-sdk.mjs <base SDK> <new stage> <loopback origin>");
}

const source = resolve(sourceArg);
const destination = resolve(destinationArg);
const origin = new URL(originArg);
if (
  originArg !== origin.origin ||
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  Number(origin.port) < 1024
) {
  throw new Error("The fixture needs a numeric loopback origin with an explicit ephemeral port.");
}

// The production SDK remains untouched. Only the scratch composite receives the guard.
await mkdir(destination);
for (const entry of [
  "build.gradle.kts",
  "settings.gradle.kts",
  "gradle.properties",
  "detekt.yml",
  "kotlin-js-store",
  "src",
]) {
  await cp(join(source, entry), join(destination, entry), { recursive: true, errorOnExist: true });
}

const platformDir = (name) =>
  join(destination, "src", name, "kotlin/io/confeature/kmp/internal/platform");
const signature = "public actual fun createHttpClient(";
for (const target of ["jvm", "android", "js", "ios"]) {
  const file = join(platformDir(`${target}Main`), `HttpEngine.${target}.kt`);
  const implementation = await readFile(file, "utf8");
  if (implementation.split(signature).length !== 2) {
    throw new Error(`Expected one native engine factory for ${target}.`);
  }
  await writeFile(file, implementation.replace(signature, "internal fun createFixtureEngine("));
  const androidImports =
    target === "android"
      ? "import io.ktor.client.engine.okhttp.OkHttpConfig\nimport java.net.Proxy\n"
      : "";
  const androidNoProxy =
    target === "android"
      ? `
        engine {
            (this as OkHttpConfig).config {
                proxy(Proxy.NO_PROXY)
                followRedirects(false)
                followSslRedirects(false)
            }
        }`
      : "";
  await writeFile(
    join(platformDir(`${target}Main`), `FixtureEngine.${target}.kt`),
    `// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
${androidImports}
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient =
    createFixtureEngine {
        block()
        followRedirects = false
        install(FixtureSendGuard)${androidNoProxy}
    }
`,
  );
}

await writeFile(
  join(platformDir("commonMain"), "FixtureSendGuard.kt"),
  `// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.plugins.api.SendingRequest
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.http.URLProtocol

internal val FixtureSendGuard = createClientPlugin("ConfeatureFixtureSendGuard") {
    on(SendingRequest) { request, _ ->
        val url = request.url
        check(url.protocol == URLProtocol.HTTP && url.host == "127.0.0.1" && url.port == ${origin.port}) {
            "Kotlin test request is outside the loopback fixture."
        }
    }
}
`,
);
