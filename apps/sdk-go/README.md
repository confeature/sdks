# confeature/sdk-go

Go SDK for [Confeature](https://confeature.io) — a drop-in replacement
for ConfigCat's official `configcat/go-sdk` v9. Migrate by changing the
import path and the SDK key value; no code changes needed.

## Install

```bash
go get github.com/confeature/sdks/apps/sdk-go@latest
```

Requires Go 1.22+.

> Module tagging is deferred to a future release; for now, depend on the
> module via a `replace` directive against a checkout of this repository:
>
> ```
> replace github.com/confeature/sdks/apps/sdk-go => /path/to/sdks/apps/sdk-go
> ```

## Quickstart

```go
package main

import (
    "fmt"

    confeature "github.com/confeature/sdks/apps/sdk-go"
)

func main() {
    client, err := confeature.NewClient("configcat-sdk-1/<your-22-char>/<your-22-char>")
    if err != nil {
        panic(err)
    }
    defer client.Close()

    user := &confeature.User{Identifier: "alice@example.com"}
    enabled := client.GetValue("feature.dark-mode", false, user)
    fmt.Printf("dark mode: %v\n", enabled)
}
```

Confeature SDK keys have ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>`. Keys minted before that shape
(`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted. A key of
neither shape logs a redacted `INVALID_SDK_KEY` warning and the client
carries on.

The default polling mode (`AutoPoll`) spawns a goroutine that fetches
the latest config every 60 seconds in the background. Each `GetValue`
call is served from the in-memory atomic config snapshot —
sub-microsecond — and returns the supplied default on any failure path.
The SDK never panics from a public method.

## Polling modes

Mirrors `configcat/go-sdk` v9: pick one of `WithAutoPoll(...)` (default
when omitted, 60 s cadence), `WithLazyLoad(...)` (fetch on first stale
read), or `WithManualPoll()` (only on explicit `client.ForceRefresh()`).

```go
client, _ := confeature.NewClient(
    "configcat-sdk-1/...",
    confeature.WithManualPoll(),
)
_ = client.ForceRefresh()
```

## Flag overrides

Use `confeature.FlagOverrides` with `MapOverrideDataSource` to bypass
the network entirely (tests, local dev):

```go
client, _ := confeature.NewClient(
    "configcat-sdk-1/...",
    confeature.WithFlagOverrides(confeature.FlagOverrides{
        DataSource: confeature.NewMapOverrideDataSource(map[string]any{
            "feature.x": true,
        }),
        Behaviour: confeature.LocalOnly,
    }),
)

if client.GetValue("feature.x", false, nil) != true {
    panic("override not applied")
}
```

`LocalOverRemote` and `RemoteOverLocal` are accepted at the type level
but log a deferral and fall back to the supplied default at evaluation
time (deferred per the parent monorepo's spec 031 §R8).

## Migrate from ConfigCat

```diff
- import configcat "github.com/configcat/go-sdk/v9"
+ import confeature "github.com/confeature/sdks/apps/sdk-go"

- client := configcat.NewClient("YOUR-CONFIGCAT-KEY")
+ client, _ := confeature.NewClient("YOUR-CONFEATURE-KEY")
```

Method signatures, polling options, flag-overrides semantics, and the
`User` field names all mirror `configcat/go-sdk` v9. The corpus parity
tier (`parity_test.go`) gates byte-identical output across 58 (flag,
user, default) tuples shared with the Node and Python SDKs.

## Local development

```bash
# Run the full test suite, including the 58-tuple parity gate.
go test -cover ./...

# Lint.
go vet ./...

# Static analysis. Install staticcheck first if it's not on PATH:
go install honnef.co/go/tools/cmd/staticcheck@latest
$(go env GOPATH)/bin/staticcheck ./...

# Format.
gofmt -l .
```

Or from the monorepo root, the `go:ready` script chains all of the
above plus `go build ./...`:

```bash
pnpm run go:ready
```

## Documentation & support

- Docs: [confeature.io/docs/sdks/go](https://confeature.io/docs/sdks/go)
- Issue tracker: <https://github.com/confeature/sdks/issues>
- Source: [`apps/sdk-go/`](./) in the `confeature/sdks` repository.

## License

MIT. See `LICENSE` at the package root.
