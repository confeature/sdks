#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

harness=${1:?Path to the live-contract harness CLI}
test -f "$harness"
tests=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
dist=$(mktemp -d)
dist=$(cd -- "$dist" && pwd -P)
trap 'rm -r -- "$dist"' EXIT

export GEM_HOME="$dist/gems" GEM_PATH="$dist/gems"
unset RUBYLIB RUBYOPT
cp -- "$tests/Gemfile" "$tests/Gemfile.lock" "$dist/"
(
  cd -- "$dist"
  BUNDLE_GEMFILE="$dist/Gemfile" BUNDLE_FROZEN=true BUNDLE_FORCE_RUBY_PLATFORM=true \
    bundle install
)

(
  cd -- "$tests/../../sdk-ruby"
  gem build confeature.gemspec --output "$dist/confeature.gem"
)
(
  cd -- "$tests/.."
  gem build confeature-openfeature.gemspec --output "$dist/confeature-openfeature.gem"
)

ruby -rrubygems/package - "$dist/confeature.gem" "$dist/confeature-openfeature.gem" <<'RUBY'
  ARGV.zip(["confeature", "confeature-openfeature"]).each do |file, name|
    gem = Gem::Package.new(file)
    allowed_entries = gem.contents.all? { |entry| entry.match?(%r{\Alib/.+\.rb\z}) || %w[LICENSE README.md].include?(entry) }
    abort "unexpected distribution contents for #{name}" unless gem.spec.name == name && allowed_entries &&
      (%W[lib/#{name.tr("-", "_")}.rb LICENSE README.md] - gem.contents).empty?
  end
RUBY

gem install --local --no-document "$dist/confeature.gem" "$dist/confeature-openfeature.gem"
ruby -rconfeature_openfeature -e '
  %w[confeature confeature-openfeature openfeature-sdk].zip(%w[0.2.0 0.1.0 0.8.1]).each do |name, version|
    spec = Gem.loaded_specs.fetch(name)
    abort "unexpected gem origin or version for #{name}" unless spec.version.to_s == version &&
      spec.full_gem_path.start_with?("#{ENV.fetch("GEM_HOME")}/gems/")
  end
'
ruby "$tests/local_consumer_test.rb"
node "$harness" --seed "$tests/http-seed.json" --exec -- ruby "$tests/http_consumer_test.rb"
