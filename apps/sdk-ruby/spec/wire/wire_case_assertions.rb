# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "json"

# What a `wire-cases.json` case means for sdk-ruby — ONE implementation,
# mixed into the hermetic suite (`wire_cases_spec.rb`, WebMock + a raw
# socket) AND the live suite (`wire_cases_live_spec.rb`, real HTTP against
# the harness, #920), so both are judged by the same rules. The request is
# passed in SDK-neutral form (path, URL, If-None-Match): the hermetic suite
# reads it from WebMock and the socket, the live suite from the harness's
# `GET /admin/requests`.
#
# Mirrors sdk-python's `_wire_case_assertions.py` (#783, decision row 6).
# Not a spec file (no `_spec` suffix): rspec loads it only when required.
module WireCaseAssertions
  FIXTURES_DIR = File.join(
    SpecHelpers.workspace_root, "packages", "test-fixtures-sdk-parity", "fixtures"
  )

  # Every `given` / `expected` field this consumer reads (#803 FR-003).
  # A field outside these lists FAILS the case — a new expectation can
  # never be skipped silently.
  KNOWN_GIVEN_FIELDS = %w[previousEtag sdkKey baseUrl].freeze
  KNOWN_EXPECTED_FIELDS = %w[
    outcome errorClass resultingEtag hasConfig
    requestHeaderIfNoneMatch requestUrlPrefix requestPath
  ].freeze

  # The fetcher's fixed, key-free transport reasons (#803 FR-002): each is
  # a fetchFailed. Named, so an unknown reason is NOT one.
  TRANSPORT_FAILURES = [
    "connection_reset", "network_error", Confeature::Internal::ConfigFetcher::INVALID_REQUEST
  ].freeze

  def self.load_corpus
    raw = File.read(File.join(FIXTURES_DIR, "wire-cases.json"))
    JSON.parse(raw).tap do |doc|
      raise "wire-cases.json malformed: missing 'cases'" unless doc.is_a?(Hash) && doc["cases"].is_a?(Array)
      raise "wire-cases.json carries no cases — fixture is FROZEN" if doc["cases"].empty?
    end
  end

  # Maps the fetcher's stringly-typed `FetchResult.error` onto the
  # corpus's normalised error-class vocabulary:
  #
  #   - "MALFORMED_JSON"          -> parseFailed   (JSON.parse failure or wrong shape)
  #   - "HTTP 403" / "HTTP 404"   -> invalidSdkKey (CDN rejected the key — per
  #                                  ConfigCat only 403/404 are invalid-SDK-key
  #                                  statuses; 401 is a generic retryable failure)
  #   - "INVALID_SDK_KEY"         -> invalidSdkKey (key refused before any request)
  #   - "HTTP <other-non-2xx>"    -> fetchFailed
  #   - "timeout"                 -> timeout
  #   - TRANSPORT_FAILURES        -> fetchFailed
  #
  # Fails closed, like sdk-python's `python_error_to_class`: anything else
  # maps to `unmapped:<reason>`, which matches no corpus class. Folding the
  # unknown into fetchFailed would let any unexpected failure pass every
  # fetchFailed case.
  def self.error_to_class(reason)
    return "parseFailed" if reason == "MALFORMED_JSON"
    return "invalidSdkKey" if ["HTTP 403", "HTTP 404", "INVALID_SDK_KEY"].include?(reason)
    return "fetchFailed" if reason.to_s.start_with?("HTTP ") || TRANSPORT_FAILURES.include?(reason)
    return "timeout" if reason == "timeout"

    "unmapped:#{reason.inspect}"
  end

  # The key a suite configures its fetcher with: the corpus's
  # `given.sdkKey` when the case pins one, else the suite's own default
  # (the live suite's default is the case id, the key the harness seeds).
  def self.sdk_key_for(wire_case, default_key)
    wire_case["given"]["sdkKey"] || default_key
  end

  # The exact path a case's request must carry (#803 FR-001): the corpus's
  # `requestPath` when the case pins one, else ConfigCat's
  # `/configuration-files/<sdkKey>/config_v6.json` with the key in RAW —
  # which is how a suite proves the SDK sent the key it was configured with.
  def self.request_path_for(wire_case, sdk_key)
    wire_case["expected"]["requestPath"] || "/configuration-files/#{sdk_key}/config_v6.json"
  end

  def resolve_body(server)
    if server["bodyRef"]
      File.read(File.join(FIXTURES_DIR, server["bodyRef"]))
    else
      server["body"]
    end
  end

  def assert_known_fields(wire_case)
    unknown_given = wire_case["given"].keys - KNOWN_GIVEN_FIELDS
    unknown_expected = wire_case["expected"].keys - KNOWN_EXPECTED_FIELDS
    raise "case #{wire_case["id"]}: unknown given field(s) #{unknown_given}" unless unknown_given.empty?
    raise "case #{wire_case["id"]}: unknown expected field(s) #{unknown_expected}" unless unknown_expected.empty?
  end

  # The request side: the exact path as sent (query excluded — #807 may
  # add one), no legacy /v2/ path, and `requestUrlPrefix` against the full
  # URL when the case pins one.
  def assert_request(wire_case, path:, url:, sdk_key:)
    expect(path).to eq(WireCaseAssertions.request_path_for(wire_case, sdk_key))
    expect(path).not_to include("/v2/")
    prefix = wire_case["expected"]["requestUrlPrefix"]
    expect(url).to start_with(prefix) if prefix
  end

  # If-None-Match header round-trip. The corpus uses a 3-state encoding:
  # absent key = don't assert, explicit null = header MUST NOT be sent,
  # explicit string = header MUST equal.
  def assert_if_none_match(actual, expected)
    return unless expected.key?("requestHeaderIfNoneMatch")

    if expected["requestHeaderIfNoneMatch"].nil?
      expect(actual).to be_nil
    else
      expect(actual).to eq(expected["requestHeaderIfNoneMatch"])
    end
  end

  def assert_outcome(wire_case, result)
    expected = wire_case["expected"]
    case expected["outcome"]
    when "fetched" then assert_fetched(result, expected)
    when "notModified" then assert_not_modified(result, expected)
    when "failed" then assert_failed(wire_case, result)
    else raise "Unknown outcome value in corpus: #{expected["outcome"].inspect}"
    end
    assert_has_config(result, expected)
  end

  def assert_fetched(result, expected)
    expect(result.status).to eq(:fetched),
                             "expected :fetched, got status=#{result.status.inspect} " \
                             "error=#{result.error.inspect}"
    expect(result.body).not_to be_nil
    expect(result.etag).to eq(expected["resultingEtag"]) if expected["resultingEtag"]
  end

  # Ruby returns status=:not_modified (snake_case symbol) where the
  # corpus uses 'notModified' (camelCase). The corpus is canonical; each
  # consumer maps to its own idiom.
  def assert_not_modified(result, expected)
    expect(result.status).to eq(:not_modified),
                             "expected :not_modified, got status=#{result.status.inspect} " \
                             "error=#{result.error.inspect}"
    expect(result.body).to be_nil
    expect(result.etag).to eq(expected["resultingEtag"]) if expected["resultingEtag"]
  end

  def assert_failed(wire_case, result)
    expected = wire_case["expected"]
    expect(result.status).to eq(:failed),
                             "expected :failed, got status=#{result.status.inspect} " \
                             "body=#{result.body.inspect}"
    mapped = WireCaseAssertions.error_to_class(result.error)
    expect(mapped).to eq(expected["errorClass"]),
                      "case #{wire_case["id"]}: expected errorClass=" \
                      "#{expected["errorClass"].inspect}, got mapped=#{mapped.inspect} " \
                      "from raw error=#{result.error.inspect}"
  end

  # hasConfig: the round-trip did / did not yield a config body.
  def assert_has_config(result, expected)
    return unless expected.key?("hasConfig")

    if expected["hasConfig"]
      expect(result.body).to be_a(Hash)
    else
      expect(result.body).to be_nil
    end
  end
end
