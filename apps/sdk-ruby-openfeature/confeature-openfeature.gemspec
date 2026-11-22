# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "lib/confeature_openfeature/version"

Gem::Specification.new do |spec|
  spec.name = "confeature-openfeature"
  spec.version = ConfeatureOpenFeature::VERSION
  spec.authors = ["MakerLabs"]
  spec.summary = "Confeature provider for the OpenFeature Ruby SDK"
  spec.homepage = "https://confeature.io"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.4"
  spec.metadata = {
    "source_code_uri" => "https://github.com/confeature/sdks",
    "bug_tracker_uri" => "https://github.com/confeature/sdks/issues",
    "rubygems_mfa_required" => "true"
  }
  spec.files = Dir["lib/**/*.rb"] + Dir["{README.md,LICENSE}"]
  spec.require_paths = ["lib"]

  spec.add_dependency "confeature", "= 0.2.0"
  spec.add_dependency "openfeature-sdk", "= 0.8.1"
end
