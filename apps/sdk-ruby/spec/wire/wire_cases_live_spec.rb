# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# sdk-ruby live wire-cases (#920, after sdk-python's #783).
#
# sdk-ruby's own `Confeature::Internal::ConfigFetcher` — its real Net::HTTP
# stack — against a RUNNING live-contract harness serving the reference
# origin of the CDN read path. Every seeded wire-case is replayed and judged
# by `WireCaseAssertions`, the SAME rules the hermetic suite
# (`wire_cases_spec.rb`) applies to WebMock and a raw socket. Nothing is
# hand-built here and no admin write is made:
#
#   - the case set comes from the running harness (`GET /admin/state` ->
#     `keys`), never recomputed from the corpus and the seeds directory —
#     `http-403` among them, an unseeded key answered by the Worker itself;
#   - the request each case sent is read back from the harness
#     (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
#     asserted on the wire, and each fetch must add exactly one entry;
#   - a timeout case is ended by the SDK's OWN deadline
#     (`request_timeout_seconds`, a quarter of the harness's hold);
#   - US4: one unseeded key reaches the Worker's own unknown-key answer.
#
# Run it through the harness wrapper, the one agreed boot (the manifest's
# `liveSuite.runner`):
#
#     node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
#       --exec -- bash -c 'cd apps/sdk-ruby && bundle exec rspec spec/wire/wire_cases_live_spec.rb'
#
# GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
# hermetic `rake` run. When it is set without `LIVE_HARNESS_URL`, or the
# harness does not answer, the file FAILS at load; it never skips.

require "net/http"
require "uri"

require_relative "wire_case_assertions"

module WireCasesLive
  SDK_VERSION = "0.0.0-live-wire"
  LIVE = ENV["CONFEATURE_LIVE"] == "1"
  HARNESS_URL = ENV.fetch("LIVE_HARNESS_URL", "").chomp("/")
  GROUP_METADATA = LIVE ? {} : { skip: "hermetic run: CONFEATURE_LIVE is not set" }.freeze

  if LIVE && HARNESS_URL.empty?
    raise "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " \
          "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping"
  end

  # spec_helper refuses every real connection (WebMock); the harness is
  # the one host this suite may reach.
  def self.allow_harness!
    harness = URI(HARNESS_URL)
    WebMock.disable_net_connect!(allow: "#{harness.host}:#{harness.port}")
  end

  def self.get_json(path, query = {})
    uri = URI("#{HARNESS_URL}#{path}")
    uri.query = URI.encode_www_form(query) unless query.empty?
    response = Net::HTTP.get_response(uri)
    raise "harness #{path} answered #{response.code}: #{response.body}" unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body)
  end

  # The requests the harness logged for `sdk_key`, oldest first.
  def self.requests_for(sdk_key)
    body = get_json("/admin/requests", sdkKey: sdk_key)
    raise "harness refused /admin/requests: #{body["error"]}" unless body["ok"]

    body.fetch("requests")
  end

  # The harness's hold for a timeout case — the SDK's deadline is derived
  # from it (#783 A8) — or nil for any other behaviour.
  def self.hold_ms(wire_case, state)
    return nil unless wire_case["server"]["behavior"] == "timeout"

    fault = state.fetch("faults")[wire_case["id"]]
    hold = fault.is_a?(Hash) ? fault["ms"] : nil
    raise "#{wire_case["id"]} is seeded without a timeout fault" unless hold

    hold
  end

  def self.fetcher(sdk_key, timeout_seconds)
    Confeature::Internal::ConfigFetcher.new(
      sdk_key: sdk_key,
      version: SDK_VERSION,
      logger: SpecHelpers::SilentLogger.new,
      base_url: HARNESS_URL,
      request_timeout_seconds: timeout_seconds
    )
  end

  STATE =
    if LIVE
      allow_harness!
      get_json("/admin/state")
    else
      { "keys" => [], "faults" => {} }
    end
  CASE_IDS = STATE.fetch("keys").sort.freeze
  CORPUS = WireCaseAssertions.load_corpus["cases"].to_h { |wire_case| [wire_case["id"], wire_case] }.freeze
end

RSpec.describe "wire-cases.json live against the harness (Ruby, #920)", **WireCasesLive::GROUP_METADATA do
  include WireCaseAssertions

  before { WireCasesLive.allow_harness! }
  after { WebMock.disable_net_connect!(allow_localhost: false) }

  it "is served a non-empty seeded set, all of it in the corpus" do
    expect(WireCasesLive::CASE_IDS).not_to be_empty, "the harness reports no seeded case — an empty run checks nothing"
    expect(WireCasesLive::CASE_IDS - WireCasesLive::CORPUS.keys).to eq([])
  end

  WireCasesLive::CASE_IDS.each do |case_id|
    it "replays #{case_id} over real HTTP", :aggregate_failures do
      wire_case = WireCasesLive::CORPUS.fetch(case_id)
      assert_known_fields(wire_case)
      hold_ms = WireCasesLive.hold_ms(wire_case, WireCasesLive::STATE)

      # The harness seeds each case under its id; a case that pins
      # given.sdkKey is configured with that key instead (#803 FR-003).
      sdk_key = WireCaseAssertions.sdk_key_for(wire_case, case_id)
      logged_before = WireCasesLive.requests_for(sdk_key).size
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      fetcher = WireCasesLive.fetcher(sdk_key, hold_ms ? hold_ms / 4000.0 : 10.0)
      result = fetcher.fetch(wire_case["given"]["previousEtag"])
      fetcher.close
      elapsed_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000

      log = WireCasesLive.requests_for(sdk_key)
      # Exactly one request per fetch: a retrying SDK, or a request logged
      # by an earlier run, must not stand in for the one under test.
      expect(log.size - logged_before).to eq(1), "#{case_id}: requests sent by one fetch"
      # The SDK's own deadline ended the fetch, not the harness releasing it.
      expect(elapsed_ms).to be < hold_ms if hold_ms
      sent = log.last || {}
      assert_request(wire_case, path: sent["url"].to_s.split("?", 2).first, url: sent["url"].to_s, sdk_key: sdk_key)
      assert_if_none_match(sent["ifNoneMatch"], wire_case["expected"])
      assert_outcome(wire_case, result)
    end
  end

  # US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
  # 403 since #785, classed like a 404 as invalidSdkKey.
  it "reaches the Worker's own answer for an unseeded key and reports invalidSdkKey" do
    fetcher = WireCasesLive.fetcher("never-seeded-920", 10.0)
    result = fetcher.fetch
    fetcher.close
    expect(result.status).to eq(:failed)
    expect(WireCaseAssertions.error_to_class(result.error)).to eq("invalidSdkKey"), result.error.inspect
  end
end
