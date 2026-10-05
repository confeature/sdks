# CLI releases on R2: runbook (#801)

Users install the CLI from **https://cli.confeature.io**, a Cloudflare R2 bucket behind a custom
domain. The hostname and the object layout are a **permanent contract**: every root install script
ever served installs pinned versions from `v<version>/<asset>` (ADR 0006, amendment of 2026-09-28).
This file lives under `apps/cli/` so it moves with the CLI to the public repository (#794).

| Object                                                | Written by                                       | Cache                                 | Mutable                              |
| :---------------------------------------------------- | :----------------------------------------------- | :------------------------------------ | :----------------------------------- |
| `v<X.Y.Z>/confeature-<target>`, `v<X.Y.Z>/SHA256SUMS` | `publish-r2.sh upload`                           | `public, max-age=31536000, immutable` | **Never**: bucket lock on prefix `v` |
| `install.sh`, `install.ps1`                           | `publish-r2.sh promote`, taken from the checkout | `no-cache`                            | Yes, on promote                      |
| `latest` (exactly `X.Y.Z`)                            | `publish-r2.sh promote`, **last**                | `no-cache`                            | Yes, on promote                      |

`apps/cli/scripts/publish-r2.sh` is the **only writer**. Never run `wrangler r2 object put` by hand,
and never put `latest` by hand.

## Provisioning (done once, 2026-09-28)

In the MakerLabs account, on the `confeature.io` zone. Take both ids from the dashboard; they are
not written here. Run from `tools/test-harness-live-contract/`, whose wrangler is the workspace's:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account id>
pnpm exec wrangler r2 bucket create confeature-cli-releases
# Released versions can never be overwritten or deleted, by any credential.
pnpm exec wrangler r2 bucket lock add confeature-cli-releases immutable-versions v --retention-indefinite -y
pnpm exec wrangler r2 bucket domain add confeature-cli-releases \
  --domain cli.confeature.io --zone-id <zone id> --min-tls 1.2 -y
pnpm exec wrangler r2 bucket dev-url disable confeature-cli-releases -y   # no r2.dev
```

**HTTPS only, scoped to this host.** A dynamic redirect rule on the zone sends
`http://cli.confeature.io/*` to `https://`, with status 301. It is **not** the zone-wide "Always Use
HTTPS" or minimum-TLS setting: those would also apply to `cdn.confeature.io`, and so to SDK clients
in production. The installers enforce HTTPS on their side as well
(`curl --proto '=https' --tlsv1.2`).

**HSTS, scoped the same way.** A response header transform rule on the zone (the
`http_response_headers_transform` entrypoint, rule "cli.confeature.io: HSTS") sets
`Strict-Transport-Security: max-age=31536000` when `http.host eq "cli.confeature.io"`. It has no
`includeSubDomains` and no `preload`. It was added 2026-09-29 for the Cloudflare Security Insight
"Domains without HSTS". It is not the zone-wide HSTS setting, for the same reason as above.

No CORS is configured: `curl` and `irm` are not browsers.

**The bare host.** A second rule sends `https://cli.confeature.io/` (the root path only) to
`https://docs.confeature.io/cli/installation/` with a 302. An R2 bucket has no index, and the docs
name the host itself.

**Publishing token (operator, in the dashboard).** Go to R2, then _Manage API tokens_, then _Create
API token_. Choose _Object Read & Write_, applied to **`confeature-cli-releases` only**. Then run:

```bash
gh secret set CLI_R2_API_TOKEN      # paste the token value when prompted
```

The token must not reach any other bucket. Check with
`pnpm exec wrangler r2 object get <another-bucket>/<any-key> --remote` using that token: it must be
refused.

## Backfill of cli-v0.2.0 (done once, 2026-09-28)

`cli-v0.2.0` predates R2. Its binaries and `SHA256SUMS` come from the GitHub release. Each file is
checked against **both** the release's `SHA256SUMS` **and** the digest GitHub recorded at upload
time. The first check alone would be self-referential. The release's own `install.sh` and
`install.ps1` are **not** published: they hard-code the private GitHub URL.

```bash
gh release download cli-v0.2.0 --dir /tmp/cli-v0.2.0 --pattern 'confeature-*' --pattern SHA256SUMS
gh api repos/<the repository that published it>/releases/tags/cli-v0.2.0 --jq '.assets[] | "\(.digest) \(.name)"'
(cd /tmp/cli-v0.2.0 && shasum -a 256 -c SHA256SUMS)
WRANGLER="pnpm --dir tools/test-harness-live-contract exec wrangler" bash apps/cli/scripts/publish-r2.sh upload 0.2.0 /tmp/cli-v0.2.0
WRANGLER="pnpm --dir tools/test-harness-live-contract exec wrangler" bash apps/cli/scripts/publish-r2.sh promote 0.2.0
```

Reference digests for cli-v0.2.0, as recorded by GitHub, so git holds a copy:

```text
sha256:7832fcf9c4edd04b5a47598de01b53add36000652d788b326418da0979c2a96f confeature-aarch64-apple-darwin
sha256:2587e40a214b1fff0c8d7b2719dfb4607367cd5110838a29bb8c5c661f01ed6c confeature-aarch64-unknown-linux-gnu
sha256:8dacbd994a508833ac21ab2cc52c9cb2f7b8d971114272e5b51f6c8e79658904 confeature-x86_64-apple-darwin
sha256:1c78a3ff35d3bd471c41d7b3a788fc5f702a2022d5dceb0946079c02fc5fcef6 confeature-x86_64-pc-windows-msvc.exe
sha256:6ce126f67b3d9b057a64677bddc6507692a2ea4a3184b24841f56ddfeb4afa71 confeature-x86_64-unknown-linux-gnu
sha256:a61c47019f9f7ede592810009e2e4898c4a21080b8d82543e87477d03691f201 SHA256SUMS
```

The backfill ran on 2026-09-28. All six files matched both the release's `SHA256SUMS` and these
digests before upload. `latest` was promoted to `0.2.0`, and an unauthenticated `curl … | sh`
installed 0.2.0 on macOS arm64.

## Rollback

```bash
WRANGLER="pnpm --dir tools/test-harness-live-contract exec wrangler" bash apps/cli/scripts/publish-r2.sh rollback <previous X.Y.Z>
```

The bad version's `v<X.Y.Z>/` stays in the bucket. It is locked, and nothing points at it once
`latest` has moved back. A burned version number is never reused.

## Incident: a bad object was served

1. Roll back `latest` (above).
2. Purge the edge cache for the affected URLs: dashboard, then _Caching_, then _Purge by URL_, for
   `https://cli.confeature.io/latest`, `/install.sh` and `/install.ps1`. Mutable objects are
   `no-cache`, so this is belt and braces.
3. `v*/` objects cannot be changed or deleted (the lock). A compromised version is withdrawn by
   never pointing `latest` at it and by announcing it.

**Wrangler misreports refused deletes.** `wrangler r2 object delete` prints "Delete complete" and
exits 0 even when the lock refuses the delete (seen on 2026-09-28, wrangler 4.90.1). A refused
overwrite does fail, with error 10069. Always confirm the state by listing the bucket, never from
wrangler's message.

## Admin: an unwanted object under `v`

The lock makes every `v*` object permanent, including one written by mistake or by a compromised
credential. It cannot be overwritten, and it is never reached as long as `latest` never points at
its version. If it must go, an account admin removes the lock rule, deletes the object, and re-adds
the rule at once, in that order. Then check the rule is back with a listing:

```bash
pnpm exec wrangler r2 bucket lock remove confeature-cli-releases --id immutable-versions
pnpm exec wrangler r2 object delete confeature-cli-releases/v<X.Y.Z>/<asset> --remote
pnpm exec wrangler r2 bucket lock add confeature-cli-releases immutable-versions v --retention-indefinite -y
pnpm exec wrangler r2 bucket lock list confeature-cli-releases
```

The bucket is unprotected while the rule is off, so keep that window to seconds, and record it.
