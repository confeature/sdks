# Leak remediation runbook

What to do when a secret, a credential or anyone's personal data (an email address above all)
reaches this repository or a package published from it. It is written for the maintainers.

**A leak is purged, not merely fixed forward.** A commit that deletes the value leaves it in the
history, in every fork and clone, and in every package already published. So remediation has four
parts, done in this order: contain, purge the history, supersede or withdraw the artefact, and
deprecate the registry release.

## 1. Contain

1. **A credential is revoked first**, before anything else, at the service that issued it. Assume
   it was copied the moment it was pushed: purging the history does not un-copy it.
2. Open a private security advisory on this repository (Security, then Advisories) to track the
   incident. Do not discuss it in a public issue or pull request.
3. Note every place the value reached: the commits, the tags, the release artefacts, and each
   registry and version it was published to.

## 2. Purge the history (`git filter-repo`, then a force-push)

Work in a fresh mirror clone, never in a working checkout:

```sh
git clone --mirror https://github.com/confeature/sdks.git sdks-purge.git
cd sdks-purge.git
```

The leaked value never goes on a command line, where the shell history would keep it. Write
these files outside the clone with an editor, and delete them once the push is done:

- `../needles.txt`: the exact leaked value, one per line, for the checks below;
- `../replacements.txt`: one `literal:<the value>==>REMOVED` line per value, for file contents
  and commit and tag messages alike;
- `../mailmap.txt`, when the value is an identity in the git metadata: one
  `<correct name> <noreply address> <leaked address>` line per address, which rewrites the author,
  committer and tagger fields.

Then rewrite every branch and tag:

```sh
git filter-repo \
  --replace-text ../replacements.txt \
  --replace-message ../replacements.txt \
  --mailmap ../mailmap.txt
```

Leave out `--mailmap` when no identity leaked. To remove a whole file as well:
`git filter-repo --invert-paths --path <path>`.

Check that nothing is left, in the content and in every piece of metadata — authors, committers,
messages, tags — with the value read from the file:

```sh
git log --all -p | grep -F -c -f ../needles.txt                                  # must print 0
git log --all --format='%an %ae %cn %ce %B' | grep -F -c -f ../needles.txt      # must print 0
git for-each-ref --format='%(taggername) %(taggeremail) %(contents)' \
  | grep -F -c -f ../needles.txt                                                  # must print 0
```

Then force-push every ref. Branch protection has to be lifted for `main` for the duration of the
push, and restored right after:

```sh
git push --force --mirror origin
```

Delete `needles.txt`, `replacements.txt` and `mailmap.txt` once the push is done: they hold the
value.

Afterwards:

- ask GitHub Support to remove cached views of the old commits and any pull-request refs that still
  hold them, since forks and pull requests keep their own copies;
- tell everyone with a clone to re-clone; an old clone pushed back would restore the value;
- rotate anything the history purge cannot reach.

## 3. Supersede or withdraw the artefact

A release artefact (a CLI binary, a release archive, a package tarball) that embeds the value is
replaced, not edited:

1. Build a new version from the purged history and publish it.
2. Delete the leaking artefact where the host allows it, a GitHub release asset for instance. Where
   the host keeps it, the next step marks it.
3. The CLI download host (`cli.confeature.io`) is locked: a published version can never be
   deleted or overwritten there. A leaking CLI version is SUPERSEDED: publish the fixed version,
   move the `latest` pointer to it, and name the leaking version in the advisory so nobody pins it.

## 4. Deprecate the registry release

Most registries never delete a published version, and the ones that allow it do so only for a
short time. Unpublish where that is still possible, then deprecate, so that no new install picks
the leaking version up:

| Registry           | Unpublish (if still allowed)                     | Deprecate                                                      |
| :----------------- | :----------------------------------------------- | :------------------------------------------------------------- |
| npm                | `npm unpublish <pkg>@<version>` (72 hours)       | `npm deprecate <pkg>@<version> "<reason>; use <new version>"`  |
| PyPI               | not available                                    | yank the release in the project's settings                     |
| crates.io          | not available                                    | `cargo yank --version <version> confeature`                    |
| RubyGems           | `gem yank confeature -v <version>`               | (a yank is the only tool)                                      |
| Hex                | `mix hex.publish --revert <version>` (1 hour)    | `mix hex.retire confeature_client <version> security`          |
| pub.dev            | not available                                    | retract the version (7 days), or mark the package discontinued |
| Packagist          | delete the version tag in the package repository | mark the package abandoned, naming the replacement             |
| NuGet              | not available                                    | unlist the version, and deprecate it with the security reason  |
| Maven Central      | not available                                    | publish a fixed version; state the issue in the advisory       |
| Go module proxy    | not available                                    | add a `retract` directive in `go.mod` and tag a new version    |
| Swift, C++, Unreal | delete the release tag                           | tag a new version; state the issue in the advisory             |

Finally, publish the security advisory, naming the affected versions and the fixed ones.

## Prevention

- `verify:manifest-author` refuses a manifest with an address in it, or a published manifest that
  does not name `MakerLabs` as its author. It runs in `pnpm run verify`, and in `sdk-publish.yml`
  right before "Publish to npm" — the npm publish only. The other registries get the same gate in
  front of their own publish step when their publishing is set up (#794).
- Commits use a GitHub noreply address.
- Secret scanning and push protection stay on for this repository.
