module github.com/confeature/sdks/apps/sdk-go/openfeature/tests

go 1.23.0

require (
	github.com/confeature/sdks/apps/sdk-go v0.2.0
	github.com/confeature/sdks/apps/sdk-go/openfeature v0.1.0
	github.com/open-feature/go-sdk v1.15.1
)

require (
	github.com/go-logr/logr v1.4.3 // indirect
	go.uber.org/mock v0.5.2 // indirect
)

replace github.com/confeature/sdks/apps/sdk-go/openfeature => ..
