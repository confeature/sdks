// SPDX-License-Identifier: MIT

// Package confeature is the Go SDK for the Confeature feature-flag
// service. It is a drop-in replacement for the official ConfigCat Go
// SDK (github.com/configcat/go-sdk v9) at both wire and API-surface
// levels — see the constitution's Principle II (NON-NEGOTIABLE).
//
// Quickstart:
//
//	import confeature "github.com/confeature/sdks/apps/sdk-go"
//
//	client, err := confeature.NewClient("configcat-sdk-1/...")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer client.Close()
//
//	enabled := client.GetValue("feature.dark-mode", false, nil)
package confeature

// Version is the semver-aligned package version. It is also stamped
// into the User-Agent header (`confeature-go-sdk/<Version>`) sent by
// the config fetcher.
const Version = "0.1.0"
