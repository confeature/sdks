<!-- SPDX-License-Identifier: MIT -->

# Confeature OpenFeature provider for Ruby

Use the optional `confeature-openfeature` gem to evaluate Confeature flags through
the official OpenFeature Ruby SDK. Version 0.1.0 requires Ruby 3.4 or later and
pins `confeature` to 0.2.0 and `openfeature-sdk` to 0.8.1.

## Install

Add the provider to your Gemfile and run `bundle install`.

```ruby
gem "confeature-openfeature", "0.1.0"
```

## Evaluate a flag

Set `CONFEATURE_SDK_KEY` to your Confeature SDK key. The example looks up the
boolean flag `feature.dark-mode` and falls back to `false` if evaluation fails.

```ruby
require "confeature_openfeature"

api = OpenFeature::SDK::API.instance
native_client = Confeature::Client.new(sdk_key: ENV.fetch("CONFEATURE_SDK_KEY"))

begin
  api.set_provider_and_wait(ConfeatureOpenFeature::Provider.new(client: native_client), domain: "checkout")
  flags = api.build_client(domain: "checkout")
  context = OpenFeature::SDK::EvaluationContext.new(targeting_key: "example-user", plan: "beta")

  enabled = flags.fetch_boolean_value(
    flag_key: "feature.dark-mode",
    default_value: false,
    evaluation_context: context
  )
  puts enabled
ensure
  begin
    api.shutdown
  ensure
    native_client.close
  end
end
```

Create the native client at application startup and reuse it. The provider uses
that client's polling mode, cache and loaded configuration. With manual
polling, call `native_client.force_refresh` to load or update flags. At
application shutdown, shut down OpenFeature and close the native client.

OpenFeature merges API, transaction, client and invocation context in that order.
The resulting `targeting_key` supplies the Confeature user identifier. An absent
key leaves the identifier unset, even if the native client has a default user.
An empty string counts as an identifier for percentage rollouts. The provider
reads string `Email` and `Country` fields and passes supported custom attributes,
such as `plan`, to targeting.

Use boolean, string, integer or float evaluations for the matching Confeature
flag types. Number evaluations accept both integer and float flags and return
the stored type. Object evaluations return the supplied default with
`TYPE_MISMATCH`. Use the corresponding `fetch_*_details` method to read the
evaluated variant when available or the OpenFeature error code on failure.
