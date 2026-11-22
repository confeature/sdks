# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "lib/confeature/version"

Gem::Specification.new do |spec|
  spec.name          = "confeature"
  spec.version       = Confeature::VERSION
  spec.authors       = ["MakerLabs"]

  spec.summary       = "Ruby SDK for Confeature — drop-in compatible with ConfigCat's configcat gem."
  spec.description   = <<~DESC
    The `confeature` gem is the MIT-licensed Ruby SDK for Confeature's
    feature-flag service. It supports ConfigCat-style evaluation, polling
    and flag overrides.
  DESC
  spec.homepage      = "https://confeature.io"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 3.0"

  spec.metadata = {
    "homepage_uri" => "https://confeature.io",
    "source_code_uri" => "https://github.com/confeature/sdks",
    "bug_tracker_uri" => "https://github.com/confeature/sdks/issues",
    "documentation_uri" => "https://docs.confeature.io/sdks/ruby/",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.rb"] + Dir["{README.md,LICENSE}"]
  spec.require_paths = ["lib"]

  # Runtime: stdlib-only semantics. `base64` was bundled with the
  # standard library through Ruby 3.3 but moved out of default-gem
  # status in 3.4; `logger` moved out in 4.0. Declare explicit
  # dependencies on those stdlib gems so the SDK keeps working on the
  # newest interpreters without dragging in any third-party code
  # (Constitution Principle II — no surprises vs. configcat).
  spec.add_dependency "base64", ">= 0.2"
  spec.add_dependency "logger", ">= 1.6"
end
