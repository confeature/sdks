# Confeature OpenFeature provider for Go

Use this module to evaluate Confeature flags through the official OpenFeature Go SDK. It requires Go 1.23 or later and uses your existing Confeature client's polling and cache.

```sh
go get github.com/confeature/sdks/apps/sdk-go/openfeature@v0.1.0
```

```go
package main

import (
	"context"
	"log"
	"os"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
	provider "github.com/confeature/sdks/apps/sdk-go/openfeature"
	openfeature "github.com/open-feature/go-sdk/openfeature"
)

func main() {
	client, err := confeature.NewClient(os.Getenv("CONFEATURE_SDK_KEY"),
		confeature.WithAutoPoll(time.Minute, 5*time.Second))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	flags, err := provider.NewProvider(client)
	if err != nil {
		log.Print(err)
		return
	}
	if err := openfeature.SetProviderAndWait(flags); err != nil {
		log.Print(err)
		return
	}
	defer openfeature.Shutdown()

	user := openfeature.NewEvaluationContext("user-42", map[string]any{"plan": "beta"})
	result, err := openfeature.NewClient("dashboard").BooleanValueDetails(
		context.Background(), "show-dashboard", false, user)
	if err != nil {
		log.Printf("flag returned its fallback with code %s", result.ErrorCode)
	}
	log.Printf("show-dashboard = %t", result.Value)
}
```

Set the user's identifier with the OpenFeature targeting key. Targeting attributes such as `plan`, `Email` and `Country` go in the evaluation context. When the targeting key is absent, identifier-based percentage rules are skipped. An explicit percentage attribute can still be used.

The provider resolves Boolean, string, integer and floating-point flags. Read a JSON setting as a string and decode it in your application. OpenFeature exposes the Confeature variation ID as the variant when one is available.

The application owns the Confeature client and closes it when it is finished with it. For manual polling, call `ForceRefreshWithContext` before the first evaluation to populate the cache.
