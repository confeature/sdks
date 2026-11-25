// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("../../apps/sdk-android/gradle-ci.sh", import.meta.url));

it.each([
  ["success", "", 0, false, 0],
  ["a test failure", "Test failed", 1, false, 1],
  [
    "a 429 from another host",
    "https://example.org Received status code 429 from server",
    1,
    false,
    1,
  ],
  [
    "a recovered Maven Central 429",
    "https://repo.maven.apache.org/x Received status code 429 from server",
    1,
    true,
    0,
  ],
  [
    "a persistent Maven Central 429",
    "https://repo.maven.apache.org/x Received status code 429 from server",
    1,
    true,
    23,
  ],
])("%s", (_, message, firstStatus, retry, expectedStatus) => {
  const cwd = mkdtempSync(join(tmpdir(), "android-gradle-retry-"));
  try {
    writeFileSync(
      join(cwd, "gradlew"),
      `[ "$*" = '--no-daemon lint test assembleRelease' ] || exit 99
if [ -f attempted ]; then
    echo 'Gradle retry'
    exit "$SECOND_STATUS"
fi
touch attempted
printf '%s\\n' "$FIRST_MESSAGE"
exit "$FIRST_STATUS"
`,
    );
    writeFileSync(join(cwd, "sleep"), "#!/bin/sh\nprintf 'sleep %s\\n' \"$1\"\n", { mode: 0o700 });
    const result = spawnSync("sh", [runner, "lint", "test", "assembleRelease"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [cwd, process.env.PATH].join(delimiter),
        FIRST_MESSAGE: message,
        FIRST_STATUS: String(firstStatus),
        SECOND_STATUS: String(expectedStatus),
      },
    });
    expect(result.status).toBe(expectedStatus);
    expect(result.stdout).toBe(retry ? `${message}\nsleep 60\nGradle retry\n` : `${message}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
