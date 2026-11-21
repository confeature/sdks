// SPDX-License-Identifier: MIT

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [sourceArg, destinationArg, originArg, runtime = "jvm"] = process.argv.slice(2);
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
const jsGuard =
  runtime === "browser"
    ? `
    var client = globalThis;
    if (client.location.origin !== expectedOrigin) throw new Error("Unexpected Karma origin.");
    var original = client.fetch;
    client.fetch = function(input, init) {
        return original.call(client, input, guardedOptions(client.Headers, input, init, "browser"));
    };
`
    : `
    var Module = eval("require")("module");
    var load = Module._load;
    Module._load = function(name) {
        var original = load.apply(this, arguments);
        if (name !== "node-fetch") return original;
        var guarded = function(input, init) {
            return original(input, guardedOptions(original.Headers, input, init, "node"));
        };
        return Object.assign(guarded, original);
    };
`;
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
  const guardJavaScript = target === "js" && (runtime === "browser" || runtime === "node");
  const setup = guardJavaScript ? "    installJsFixtureGuard()\n" : "";
  const jsSupport = guardJavaScript
    ? `
private val jsFixtureInstalled: Unit by lazy {
    js("""
        (function (expectedOrigin) {
            function guardedOptions(Headers, input, init, runtime) {
                var url = new URL(input);
                if (url.origin !== expectedOrigin || url.username || url.password) {
                    throw new Error("Kotlin fixture transport refused this origin.");
                }
                var headers = new Headers(init && init.headers);
                headers.set("X-Kotlin-Fixture-Transport", runtime);
                return Object.assign({}, init, { headers: headers, redirect: "error" });
            }
            ${jsGuard}
        })(${JSON.stringify(origin.origin)});
    """)
}

private fun installJsFixtureGuard() = jsFixtureInstalled
`
    : "";
  await writeFile(
    join(platformDir(`${target}Main`), `FixtureEngine.${target}.kt`),
    `// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
${androidImports}
public actual fun createHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient {
${setup}    return createFixtureEngine {
        block()
        followRedirects = false
        install(FixtureSendGuard)${androidNoProxy}
    }
}
${jsSupport}
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
