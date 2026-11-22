// SPDX-License-Identifier: MIT

import { dag, type Container, type Directory } from "@dagger.io/dagger";

export function goToolchain(source: Directory): Container {
  return dag
    .container()
    .from("golang:1.23.12-bookworm")
    .withEnvVariable("CI", "true")
    .withEnvVariable("GOMODCACHE", "/cache/go-mod")
    .withEnvVariable("GOCACHE", "/cache/go-build")
    .withMountedCache("/cache/go-mod", dag.cacheVolume("go-mod-cache"))
    .withMountedCache("/cache/go-build", dag.cacheVolume("go-build-cache"))
    .withExec(["useradd", "-m", "-u", "1000", "runner"])
    .withExec([
      "bash",
      "-eu",
      "-c",
      // Install staticcheck under root with GOBIN forced to /usr/local/bin so
      // it resolves on PATH for the unprivileged runner user.
      "GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2024.1.1",
    ])
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-go");
}

// Run as an unprivileged user so the SDK's permission tests exercise normal
// POSIX access rules. Keep the existing module and build cache volume names.
const goChecks = `
  export GOWORK=off GOTOOLCHAIN=local
  test -z "$(gofmt -l .)"
  go vet ./...
  staticcheck ./...
  go test -cover ./...
  go build ./...

  base="$PWD"
  (
    cd openfeature
    export GOFLAGS=-mod=readonly
    go build ./...
    go vet ./...
    staticcheck ./...
    go mod verify
  )
  cd openfeature/tests

  # This consumer compiles the companion against the released base module.
  go test -mod=readonly -count=1 ./...

  # The same consumer also guards work in the current source checkout.
  scratch=$(mktemp -d)
  trap 'rm -r -- "$scratch"' EXIT
  cp go.mod go.sum "$scratch/"
  go mod edit -modfile "$scratch/go.mod" \
    "-replace=github.com/confeature/sdks/apps/sdk-go=$base" \
    "-replace=github.com/confeature/sdks/apps/sdk-go/openfeature=$base/openfeature"
  export GOFLAGS="-mod=readonly -modfile=$scratch/go.mod"
  go vet ./...
  staticcheck ./...
  go test -race -cover ./...
`;

export async function runGoSuites(source: Directory): Promise<string> {
  const result = await goToolchain(source)
    .withExec([
      "bash",
      "-eu",
      "-c",
      // Update cache ownership even when the toolchain install layer is cached.
      'chown -R runner:runner /cache && runuser -u runner -- bash -eu -c "$1"',
      "go-gate",
      goChecks,
    ])
    .stdout();
  const lastLine = result.trim().split("\n").at(-1);
  return `${lastLine} (Phase 3 goTest with OpenFeature)`;
}
