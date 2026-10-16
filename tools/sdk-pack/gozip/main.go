// SPDX-License-Identifier: MIT

// Command gozip builds the zip the Go module proxy would serve for one release
// of a module, and checks it the way the proxy does.
//
//	go -C tools/sdk-pack/gozip run . -dir <module dir> -module <path> -version v<X.Y.Z> -out <file.zip>
//
// A Go module is published by pushing its tag: there is no upload, and nothing
// to dry-run against. What the proxy can still refuse is the module itself (a
// file name it rejects, a file over its size limits, a go.mod that names
// another path, a version the path cannot carry), and it refuses it only after
// the tag is public, which cannot be undone. So the pack job of sdk-publish.yml
// builds the zip here, with golang.org/x/mod/zip, the code the proxy uses, and
// the release stops before the tag when it fails.
//
// Exit codes: 0 the zip is valid, 1 the module would be refused, 2 usage error.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/mod/modfile"
	"golang.org/x/mod/module"
	"golang.org/x/mod/zip"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	flags := flag.NewFlagSet("gozip", flag.ContinueOnError)
	dir := flags.String("dir", "", "the module's directory (it holds go.mod)")
	path := flags.String("module", "", "the module path the release resolved")
	version := flags.String("version", "", "the module version, v<X.Y.Z>")
	out := flags.String("out", "", "where to write the zip")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 ||
		*dir == "" || *path == "" || *version == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: gozip -dir <dir> -module <path> -version v<X.Y.Z> -out <file.zip>")
		return 2
	}

	gomod, err := os.ReadFile(filepath.Join(*dir, "go.mod"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "gozip: %v\n", err)
		return 1
	}
	if declared := modfile.ModulePath(gomod); declared != *path {
		fmt.Fprintf(os.Stderr, "gozip: go.mod declares module %q, not %q\n", declared, *path)
		return 1
	}
	release := module.Version{Path: *path, Version: *version}
	if err := module.Check(release.Path, release.Version); err != nil {
		fmt.Fprintf(os.Stderr, "gozip: %v\n", err)
		return 1
	}

	f, err := os.Create(*out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gozip: %v\n", err)
		return 1
	}
	if err := zip.CreateFromDir(f, release, *dir); err != nil {
		f.Close()
		fmt.Fprintf(os.Stderr, "gozip: the proxy would refuse %s: %v\n", release, err)
		return 1
	}
	if err := f.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "gozip: %v\n", err)
		return 1
	}
	// Read back exactly as the proxy reads a zip it is handed.
	if _, err := zip.CheckZip(release, *out); err != nil {
		fmt.Fprintf(os.Stderr, "gozip: %s does not check: %v\n", *out, err)
		return 1
	}
	return 0
}
