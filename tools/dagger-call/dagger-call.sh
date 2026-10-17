#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# dagger-call.sh — the one way a local `pnpm dagger:*` script hands the
# repository to Dagger (#789).
#
#   bash tools/dagger-call/dagger-call.sh [--timeout <seconds>] <dagger-function> [--<flag> <value>]...
#
# A function's own arguments follow it as `--<flag> <value>` pairs of plain
# names (`live-suite --sdk node`, #918): anything else could reach dagger's
# command line, and `--source` is refused because the snapshot is this
# script's to hand over.
#
# WHAT DAGGER SEES. A fresh snapshot of the working tree minus everything git
# ignores: `git ls-files --cached --others --exclude-standard`. `--source=.`
# uploaded the whole directory instead — 7.6 GB of build output, `/.env` and
# the Workers' local vars files included — and spent 27-40 minutes doing it, so the
# hook's ceiling ran out before a single test started. Neither `.dockerignore`
# nor any Dagger argument option filters a directory passed from the CLI
# (measured; see the plan). `.gitignore` is the single definition of what is
# local-only; this script reads it and spells nothing of its own.
#
# The snapshot is the WORKING TREE, not HEAD: uncommitted edits are tested, as
# `pnpm dagger:<sdk>` debugging needs. Untracked and modified files are counted
# on stderr, because they are tested here but do not travel with a push.
#
# THE CEILING. `--timeout` is owned here, with the signal forwarding and the
# cleanup, in one process. A watchdog outside this script could only signal the
# script, not `dagger`, and a run past the ceiling must be red whatever `dagger`
# returns afterwards.
#
# Exit codes:
#   n    `dagger call`'s own code
#   124  the ceiling expired (whatever dagger returned after)
#   129  hung up (SIGHUP)   130  interrupted (SIGINT)   143  terminated (SIGTERM)
#   2    bad arguments                   70   refused an unsafe snapshot path
#   1    the snapshot could not be built
set -euo pipefail

usage() {
  echo "usage: dagger-call.sh [--timeout <seconds>] <dagger-function> [--<flag> <value>]..." >&2
  exit 2
}

timeout_s=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)
      [ $# -ge 2 ] || usage
      timeout_s="$2"
      shift 2
      ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || usage
fn="$1"
shift
[[ "$fn" =~ ^[a-z][a-z0-9-]*$ ]] || usage
fn_args=()
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  [[ "$1" =~ ^--[a-z][a-z0-9-]*$ ]] || usage
  [ "$1" != "--source" ] || usage
  [[ "$2" =~ ^[a-z0-9][a-z0-9-]*$ ]] || usage
  fn_args+=("$1" "$2")
  shift 2
done
if [ -n "$timeout_s" ]; then
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || usage
fi

cd "$(git rev-parse --show-toplevel)"
# Per worktree, owned by the user, never listed by git, never /tmp.
base="$(git rev-parse --absolute-git-dir)/dagger-snapshot"
# The BASE is private (0700): no other local user can reach a snapshot. The
# snapshot itself keeps ordinary modes (0755 dirs), because Dagger preserves
# them into the container and some gates run as a non-root user — a 0700 tree
# failed goTest with `stat .: permission denied` (#789).
mkdir -p "$base"
if [ -L "$base" ]; then
  echo "[dagger-call] refusing a symlinked snapshot base: $base" >&2
  exit 70
fi
chmod 700 "$base"
umask 022

# A run killed by SIGKILL cannot clean up. Its snapshot is never reused — only
# removed here, and only once the process that owned it is gone, so two
# concurrent runs in one worktree never delete each other's input.
for stale in "$base"/snap.* "$base"/list.*; do
  [ -e "$stale" ] || continue
  [ -L "$stale" ] && continue
  owner="${stale##*/}"
  owner="${owner#*.}"
  owner="${owner%%.*}"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then continue; fi
  rm -rf -- "$stale"
done

snap="$(mktemp -d "$base/snap.$$.XXXXXX")"
chmod 755 "$snap"
list="$(mktemp "$base/list.$$.XXXXXX")"
child=""

# shellcheck disable=SC2329 # invoked by the EXIT trap
remove_ours() {
  local path
  for path in "${snap:-}" "${list:-}"; do
    [ -n "$path" ] || continue
    case "$path" in
      "$base"/snap.* | "$base"/list.*) ;;
      *) continue ;;
    esac
    [ -L "$path" ] && continue
    rm -rf -- "$path"
  done
}
trap remove_ours EXIT

# Stop the child: TERM, a 5 s grace, then KILL. Always reaps it.
stop_child() {
  [ -n "$child" ] || return 0
  kill -TERM "$child" 2>/dev/null || true
  local waited=0
  while kill -0 "$child" 2>/dev/null && [ "$waited" -lt 5 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
}
# shellcheck disable=SC2329 # invoked by the TERM/INT traps
on_signal() {
  trap - TERM INT HUP
  stop_child
  exit "$1"
}
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP

# ---- The snapshot ------------------------------------------------------------
# NUL-delimited end to end; a tracked file deleted in the working tree is
# dropped here rather than failing the copy.
git ls-files -z --cached --others --exclude-standard |
  while IFS= read -r -d '' f; do
    if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
  done >"$list"
expected=$(($(tr -cd '\0' <"$list" | wc -c)))
if [ "$expected" -eq 0 ]; then
  echo "[dagger-call] git lists no file — refusing to hand Dagger an empty tree" >&2
  exit 1
fi
rsync -a --files-from="$list" --from0 ./ "$snap/"
copied=$(($(find "$snap" \( -type f -o -type l \) -print0 | tr -cd '\0' | wc -c)))
if [ "$copied" -ne "$expected" ]; then
  echo "[dagger-call] snapshot holds $copied files, git lists $expected — refusing" >&2
  exit 1
fi

untracked=$(($(git ls-files -z --others --exclude-standard | tr -cd '\0' | wc -c)))
# Against HEAD, so staged edits count too: they are tested here but not pushed
# until committed. Deletions count as changes.
changed=$(($(git diff -z --name-only HEAD -- | tr -cd '\0' | wc -c)))
if [ "$untracked" -gt 0 ] || [ "$changed" -gt 0 ]; then
  echo "[dagger-call] $untracked untracked, $changed changed-vs-HEAD files included (tested here, not pushed)" >&2
fi

# ---- The run -----------------------------------------------------------------
dagger call -m ./dagger "$fn" ${fn_args[@]+"${fn_args[@]}"} --source="$snap" &
child=$!

timed_out=0
started=$SECONDS
while kill -0 "$child" 2>/dev/null; do
  if [ -n "$timeout_s" ] && [ $((SECONDS - started)) -ge "$timeout_s" ]; then
    timed_out=1
    echo "[dagger-call] $fn exceeded ${timeout_s}s — stopping it" >&2
    stop_child
    break
  fi
  sleep 1
done

rc=0
wait "$child" 2>/dev/null || rc=$?
child=""
if [ "$timed_out" -eq 1 ]; then exit 124; fi
exit "$rc"
