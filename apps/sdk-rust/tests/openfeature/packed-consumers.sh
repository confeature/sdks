#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

fixture_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
cd "$fixture_dir/../.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

metadata=$(cargo metadata --no-deps --format-version 1)
version=$(node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).packages[0].version' <<< "$metadata")
target=$(node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).target_directory' <<< "$metadata")
cargo package
archive="$target/package/confeature-$version.crate"
test -s "$archive"
tar -tzf "$archive" > "$scratch/contents"
if grep -Fq '/tests/openfeature/' "$scratch/contents"; then
  printf '%s\n' 'The published crate must not include the OpenFeature fixture harness.' >&2
  exit 1
fi
wc -c "$archive"
sha256sum "$archive"
tar -xzf "$archive" -C "$scratch"
packaged="$scratch/confeature-$version"

# Both projects resolve separately so feature unification cannot conceal a
# dependency in the base graph. Cargo's fallback honors the crate's MSRV.
export CARGO_TARGET_DIR="$target"
export CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
mkdir -p "$scratch/base/src" "$scratch/extra/src"
cat > "$scratch/base/Cargo.toml" <<EOF
[package]
name = "confeature-base-smoke"
version = "0.0.0"
edition = "2021"
rust-version = "1.86"

[dependencies]
confeature = { path = "$packaged" }
EOF
cat > "$scratch/base/src/main.rs" <<'EOF'
fn main() {
    let _ = confeature::Client::builder(
        "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB",
    ).polling_mode(confeature::PollingMode::ManualPoll);
}
EOF
cargo +1.86 run --manifest-path "$scratch/base/Cargo.toml"
cargo +1.86 tree --manifest-path "$scratch/base/Cargo.toml" -e normal --prefix none > "$scratch/base-tree"
if grep -Eq '^(open-feature|time) v' "$scratch/base-tree"; then
  printf '%s\n' 'The default packed consumer resolved an OpenFeature-only dependency.' >&2
  exit 1
fi
printf '%s\n' 'Rust 1.86 packed base consumer passed'

cat > "$scratch/extra/Cargo.toml" <<EOF
[package]
name = "confeature-openfeature-smoke"
version = "0.0.0"
edition = "2021"
rust-version = "1.88"

[dependencies]
confeature = { path = "$packaged", features = ["openfeature"] }
open-feature = { version = "=0.3.0", default-features = false }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
serde_json = "1"
tempfile = "3"
tokio = { version = "1", features = ["rt-multi-thread", "time", "net"] }
async-std = "1.13.2"
EOF
cp "$fixture_dir/consumer.rs" "$scratch/extra/src/main.rs"
cp "$fixture_dir/fixture.rs" "$scratch/extra/src/fixture.rs"
cargo build --manifest-path "$scratch/extra/Cargo.toml"
cargo tree --manifest-path "$scratch/extra/Cargo.toml" -e normal --prefix none > "$scratch/extra-tree"
grep -E '^(open-feature v0\.3\.0|time v0\.3\.)' "$scratch/extra-tree"
node "$fixture_dir/run.mjs" -- "$target/debug/confeature-openfeature-smoke"
