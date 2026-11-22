// SPDX-License-Identifier: MIT

export const GO_SDK_MODULE = "github.com/confeature/sdks/apps/sdk-go";
export const GO_OPENFEATURE_DIR = "apps/sdk-go/openfeature";

/** Select the base SDK require from a gofmt-formatted companion manifest. */
export function requiredGoSdkVersion(manifest) {
  let grouped = false;
  const versions = [];
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require[ \t]+\($/.test(line)) {
      grouped = true;
      continue;
    }
    if (line === ")") {
      grouped = false;
      continue;
    }
    const require = grouped ? line : /^require[ \t]+(.+)$/.exec(line)?.[1];
    const [module, version, extra] = require?.split(/[ \t]+/) ?? [];
    if (module === GO_SDK_MODULE) {
      versions.push(version?.startsWith("v") && extra === undefined ? version.slice(1) : undefined);
    }
  }
  return versions.length === 1 ? versions[0] : undefined;
}

export function declaresGoModule(contents, module) {
  const declarations = contents.match(/^module[ \t]+[^\r\n]+$/gm) ?? [];
  return (
    declarations.length === 1 && declarations[0].replace(/^module[ \t]+/, "").trim() === module
  );
}
