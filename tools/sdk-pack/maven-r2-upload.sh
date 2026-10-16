#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# maven-r2-upload.sh — the upload of one JVM SDK release to maven.confeature.io
# (Cloudflare R2, #902), run by sdk-publish.yml's publish-maven job, the job
# that holds the R2 S3 credentials.
#
#   bash tools/sdk-pack/maven-r2-upload.sh release
#
# It was the job's inline step until the credentialed jobs were held to a
# strict shell grammar (#794 review, round 3): its functions, case patterns
# and process substitutions are outside that grammar, so the job runs this one
# reviewed script instead, recorded as its exact PUBLISH_EXCEPTION. The job
# has already checked every file of <release-dir> against the pack job's
# digests, and check:maven-release ran in the pack job.
#
# What it does, in order:
#   1. refuses to start without MAVEN_R2_ACCESS_KEY_ID, MAVEN_R2_SECRET_ACCESS_KEY
#      and CLOUDFLARE_ACCOUNT_ID;
#   2. refuses a maven-metadata.xml that would drop a version the stored one
#      lists;
#   3. puts every file of the version with If-None-Match: * (immutable, a
#      stored identical file is kept, a different one refuses the run), POMs
#      and Gradle modules after the jars, the root artifact's last;
#   4. puts the metadata and its checksums last (short cache);
#   5. reads the root POM back through the public host, as a consumer would.
#
# Environment: MAVEN_R2_ACCESS_KEY_ID, MAVEN_R2_SECRET_ACCESS_KEY,
# CLOUDFLARE_ACCOUNT_ID (secrets); UNIT_COORDINATES (group:artifactId),
# UNIT_VERSION, MAVEN_BUCKET, MAVEN_URL. Nothing is installed: the runner
# image carries the AWS CLI.
set -euo pipefail

release="${1:?usage: maven-r2-upload.sh <release-dir>}"
: "${UNIT_COORDINATES:?}" "${UNIT_VERSION:?}" "${MAVEN_BUCKET:?}" "${MAVEN_URL:?}"
if [ -z "${MAVEN_R2_ACCESS_KEY_ID:-}" ] || [ -z "${MAVEN_R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "::error::MAVEN_R2_ACCESS_KEY_ID, MAVEN_R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID must be set in environment sdk-publish-maven"
  exit 1
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export AWS_ACCESS_KEY_ID="$MAVEN_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$MAVEN_R2_SECRET_ACCESS_KEY"
# Checksums only when the API requires them: newer AWS CLIs add CRC
# headers by default, which an S3-compatible endpoint need not accept.
export AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required AWS_PAGER=""
endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
group="${UNIT_COORDINATES%%:*}"
root="${UNIT_COORDINATES#*:}"
base="${group//.//}"
s3() { aws s3api --endpoint-url "$endpoint" "$@"; }
type_of() {
  case "$1" in
    *.md5 | *.sha1 | *.sha256 | *.sha512) echo "text/plain" ;;
    *.pom | *.xml) echo "application/xml" ;;
    *.jar | *.aar) echo "application/java-archive" ;;
    *.module | *.json) echo "application/json" ;;
    *) echo "application/octet-stream" ;;
  esac
}
rank() {
  case "$1" in
    */maven-metadata.xml) echo 4 ;;
    */maven-metadata.xml.*) echo 3 ;;
    "$base/$root/"*.pom* | "$base/$root/"*.module*) echo 2 ;;
    *.pom* | *.module*) echo 1 ;;
    *) echo 0 ;;
  esac
}
put_once() {
  local err
  if err="$(s3 put-object --bucket "$MAVEN_BUCKET" --key "$1" --body "$1" --content-type "$(type_of "$1")" --cache-control "public, max-age=31536000, immutable" --if-none-match '*' 2>&1 >/dev/null)"; then
    echo "uploaded $1"
    return
  fi
  case "$err" in
    *PreconditionFailed*) ;;
    *) echo "::error::$1: $err"; exit 1 ;;
  esac
  s3 get-object --bucket "$MAVEN_BUCKET" --key "$1" "$tmp/stored" >/dev/null
  [ "$(sha256sum < "$tmp/stored")" = "$(sha256sum < "$1")" ] ||
    { echo "::error::$1 is already stored with other bytes: version ${UNIT_VERSION} is taken"; exit 1; }
  echo "kept $1 (already stored, identical)"
}
keeps_stored_versions() {
  local err
  if ! err="$(s3 get-object --bucket "$MAVEN_BUCKET" --key "$1" "$tmp/stored.xml" 2>&1 >/dev/null)"; then
    case "$err" in
      *NoSuchKey* | *"Not Found"*) return 0 ;;
      *) echo "::error::cannot read the stored $1: $err"; exit 1 ;;
    esac
  fi
  while IFS= read -r v; do
    grep -qF "$v" "$1" ||
      { echo "::error::$1 would drop ${v}, which the stored metadata lists"; exit 1; }
  done < <(grep -o '<version>[^<]*</version>' "$tmp/stored.xml")
}
cd "$release"
while IFS= read -r f; do echo "$(rank "$f") $f"; done < <(find . -type f | sed 's|^\./||') | sort -k1,1n -k2,2 > "$tmp/order"
while read -r r f; do
  if [ "$r" -eq 4 ]; then keeps_stored_versions "$f"; fi
done < "$tmp/order"
while read -r r f; do
  if [ "$r" -le 2 ]; then put_once "$f"; fi
done < "$tmp/order"
while read -r r f; do
  if [ "$r" -ge 3 ]; then
    s3 put-object --bucket "$MAVEN_BUCKET" --key "$f" --body "$f" --content-type "$(type_of "$f")" --cache-control "public, max-age=300" >/dev/null
    echo "uploaded $f"
  fi
done < "$tmp/order"

# Through the public host, as a consumer resolves it.
group="${UNIT_COORDINATES%%:*}"
root="${UNIT_COORDINATES#*:}"
pom="${group//.//}/${root}/${UNIT_VERSION}/${root}-${UNIT_VERSION}.pom"
curl --proto '=https' --tlsv1.2 -fsSI --retry 5 --retry-delay 15 --retry-all-errors "$MAVEN_URL/$pom"
