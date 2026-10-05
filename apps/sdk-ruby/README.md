<!-- SPDX-License-Identifier: MIT -->

# confeature (Ruby)

Ruby SDK for [Confeature](https://confeature.io). Drop-in compatible
with the upstream [`configcat`](https://rubygems.org/gems/configcat)
gem — the public surface (class names, option keywords, polling
modes, override semantics) mirrors `configcat` 1:1
(a project rule, checked by its conformance tests).

```ruby
require "confeature"

Confeature::Client.new(sdk_key: "configcat-sdk-1/<22 chars>/<22 chars>") do |client|
  enabled = client.get_value("feature.dark-mode", false)
end
```

SDK keys are minted in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>`. Keys minted earlier, shaped
`confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted.
`Confeature.valid_confeature_key_format?(key)` returns `true` for both
shapes; a key that matches neither only logs `INVALID_SDK_KEY` (with the
key redacted) and the client carries on.

Full reference: <https://docs.confeature.io/sdks/ruby/>.

Licensed under MIT.
