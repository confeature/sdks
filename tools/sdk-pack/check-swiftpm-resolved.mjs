// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

const expected = new Map([
  [
    "confeature-swift",
    { location: "https://github.com/confeature/confeature-swift.git", version: /^0\.2\.\d+$/ },
  ],
  [
    "swift-sdk",
    {
      location: "https://github.com/open-feature/swift-sdk.git",
      version: /^0\.7\.0$/,
      // A moved upstream tag would invalidate the provider's reviewed dependency.
      revision: "19c0de402027db6b69bf055b134f3123ea97f2f2",
    },
  ],
  ["swift-log", { location: "https://github.com/apple/swift-log", version: /^1\.\d+\.\d+$/ }],
]);

// The provider graph must resolve to public packages. In particular, the base
// SDK's ConfigCat conformance dependency belongs to its own tests.
export function checkSwiftPMResolved({ pins }, { native = false } = {}) {
  // The native suite uses a local base mirror. The official pin is identical in both modes.
  const checkedPins =
    native && Array.isArray(pins) ? pins.filter((pin) => pin?.identity === "swift-sdk") : pins;
  if (!Array.isArray(checkedPins) || checkedPins.length !== (native ? 1 : expected.size))
    throw new Error(
      native
        ? "Expected one official OpenFeature package pin"
        : "Expected only the Confeature, OpenFeature and SwiftLog package pins",
    );
  const seen = new Set();
  for (const pin of checkedPins) {
    const want = expected.get(pin.identity);
    if (
      !want ||
      seen.has(pin.identity) ||
      pin.kind !== "remoteSourceControl" ||
      pin.location !== want.location ||
      !want.version.test(pin.state?.version ?? "") ||
      (want.revision !== undefined && pin.state?.revision !== want.revision)
    )
      throw new Error(`Unexpected SwiftPM resolution for ${pin.identity}`);
    seen.add(pin.identity);
  }
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    checkSwiftPMResolved(JSON.parse(readFileSync(process.argv[2], "utf8")), {
      native: process.argv[3] === "--native",
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
