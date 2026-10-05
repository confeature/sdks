# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Wire-protocol fixture suite (Ruby consumer).
#
# Drives `Confeature::Internal::ConfigFetcher` against each case in
# `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
# corpus is the language-agnostic contract; this file is the Ruby
# consumer that maps the fetcher's `FetchResult` (status symbol +
# stringly-typed `error` reason) onto the corpus's normalised
# `{fetched, notModified, failed}` x
# `{fetchFailed, timeout, parseFailed, invalidSdkKey}` vocabulary.
#
# Layer choice: this drives the fetcher directly (NOT the public
# `Confeature::Client`), matching what sdk-node / sdk-browser-js /
# sdk-bun / sdk-deno / sdk-python / sdk-go already do — the
# wire-cases corpus by name tests wire behaviour, and the fetcher is
# sdk-ruby's wire layer. Driving the public Client would add
# poll-service indirection that the corpus does not assert.
#
# See epic #146 (contract testing framework) + #148 slice 9 (this
# suite) + spec 112.

require "json"
require "io/wait"
require "socket"

RSpec.describe "wire-cases.json contract (Ruby)" do
  # Maps the fetcher's stringly-typed `FetchResult.error` onto the
  # corpus's normalised error-class vocabulary. The fetcher produces:
  #
  #   - "MALFORMED_JSON"          -> parseFailed   (JSON.parse failure or wrong shape)
  #   - "HTTP 403" / "HTTP 404"   -> invalidSdkKey (CDN rejected the key — per
  #                                  ConfigCat only 403/404 are invalid-SDK-key
  #                                  statuses; 401 is a generic retryable failure)
  #   - "INVALID_SDK_KEY"         -> invalidSdkKey (key refused before any request)
  #   - "HTTP <other-non-2xx>"    -> fetchFailed
  #   - "timeout"                 -> timeout
  #   - anything else (network)   -> fetchFailed ("connection_reset",
  #                                  "network_error")
  #
  # Mirrors sdk-python's `_python_error_to_class` and sdk-go's
  # `goErrorToClass`. When the fetcher upgrades to a typed enum, this
  # mapping moves to a `case` on that enum.
  def self.ruby_error_to_class(reason)
    return "fetchFailed" if reason.nil?
    return "parseFailed" if reason == "MALFORMED_JSON"
    return "invalidSdkKey" if ["HTTP 403", "HTTP 404", "INVALID_SDK_KEY"].include?(reason)
    return "fetchFailed" if reason.start_with?("HTTP ")
    return "timeout" if reason == "timeout"

    "fetchFailed"
  end

  WIRE_SDK_KEY = SpecHelpers::SAMPLE_SDK_KEY
  WIRE_BASE_URL = "https://cdn.wire-test.confeature.io"
  WIRE_FIXTURES_DIR = File.join(
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

  def self.load_corpus
    raw = File.read(File.join(WIRE_FIXTURES_DIR, "wire-cases.json"))
    JSON.parse(raw).tap do |doc|
      raise "wire-cases.json malformed: missing 'cases'" unless doc.is_a?(Hash) && doc["cases"].is_a?(Array)
      raise "wire-cases.json carries no cases — fixture is FROZEN" if doc["cases"].empty?
    end
  end

  def resolve_body(server)
    if server["bodyRef"]
      File.read(File.join(WIRE_FIXTURES_DIR, server["bodyRef"]))
    else
      server["body"]
    end
  end

  # Maps the corpus's `server.behavior` discriminator (#490) onto the
  # WebMock mock transport. Mirrors the sdk-go behaviour adapter
  # (commit a804507):
  #
  #   - "respond" (default / absent) — deliver status + headers + body
  #     (the original behaviour).
  #   - "timeout" — the server never responds; WebMock's `to_timeout`
  #     raises `Net::OpenTimeout`, which the fetcher's rescue maps to a
  #     timeout-class reason ("Net::OpenTimeout" includes "Timeout").
  #   - "close-mid-response" — the connection drops mid-body; WebMock
  #     raises `EOFError` (a transport/body-read failure), which the
  #     fetcher classifies as fetchFailed — NOT parseFailed, because a
  #     truncated body is not a JSON-shape error.
  #
  # An unrecognised behaviour FAILS the case loudly — it MUST NEVER
  # fall through to the respond path (the corpus would otherwise pass a
  # case it does not actually exercise).
  def stub_for_behavior(server, body, base_url)
    stub = stub_request(:get, %r{\A#{Regexp.escape(base_url.chomp("/"))}/})
    case server["behavior"] || "respond"
    when "respond"
      return_kwargs = { status: server["status"], headers: server["headers"] || {} }
      return_kwargs[:body] = body unless body.nil?
      stub.to_return(**return_kwargs)
    when "timeout"
      stub.to_timeout
    when "close-mid-response"
      stub.to_raise(EOFError.new("connection reset mid-response"))
    else
      raise "wire-cases: unsupported server.behavior #{server["behavior"].inspect} — no adapter"
    end
    stub
  end

  def build_fetcher(sdk_key, base_url)
    Confeature::Internal::ConfigFetcher.new(
      sdk_key: sdk_key,
      version: "0.0.0-wire-test",
      logger: SpecHelpers::SilentLogger.new,
      base_url: base_url,
      request_timeout_seconds: 1.0
    )
  end

  # URL shape: ConfigCat's <baseUrl>/configuration-files/<sdkKey>/
  # config_v6.json (#803). The corpus pins the prefix and the exact
  # PARSED path (query excluded — #807 may add one). WebMock records the
  # URI with an explicit default port; drop it before the prefix check.
  #
  # The path is compared AS SENT: `sent_targets` holds the request
  # targets handed to `Net::HTTP::Get` — the bytes Net::HTTP writes on
  # the request line. WebMock's recorded URI is normalised (it decodes
  # `%2C %3B %21 %27 %28 %29 %2A`), so it cannot pin the escaping.
  def assert_request_url(request, fetcher, sent_targets, expected)
    uri = request.uri
    uri = uri.omit(:port) if uri.port == uri.default_port
    expect(uri.to_s).to start_with(expected["requestUrlPrefix"]) if expected.key?("requestUrlPrefix")
    expect(sent_targets.size).to eq(1), "expected one request sent, got #{sent_targets.size}"
    sent_path = sent_targets.first.to_s.split("?", 2).first
    if expected.key?("requestPath")
      expect(URI.parse(fetcher.url).path).to eq(expected["requestPath"])
      expect(sent_path).to eq(expected["requestPath"])
    end
    expect(sent_path).to start_with("/configuration-files/")
    expect(sent_path).to end_with("/config_v6.json")
  end

  # Records the request target of every `Net::HTTP::Get` built.
  def record_sent_targets
    sent_targets = []
    allow(Net::HTTP::Get).to receive(:new).and_wrap_original do |original, target, *rest|
      sent_targets << target
      original.call(target, *rest)
    end
    sent_targets
  end

  # The request Net::HTTP actually writes on the socket, as raw bytes. A
  # one-shot TCP listener on 127.0.0.1 reads the request line and headers
  # (WebMock lets this one localhost round-trip through), then answers
  # with the case's OWN `server` status, headers and body — so a 404, a
  # 304 or an ETag rotation travels a real socket and a real Net::HTTP
  # response parse, not a WebMock stub. The request line is the
  # byte-for-byte proof that Net::HTTP neither re-encodes nor normalises
  # the path the fetcher built.
  #
  # Fails closed, never hangs: when the fetcher sends no request (it
  # refused the URL), the listener gives up after RAW_WAIT_SECONDS and
  # the recorded request is nil.
  RAW_WAIT_SECONDS = 5

  # The listener frames the response itself: it owns these two headers.
  RAW_FRAMING_HEADERS = %w[content-length connection].freeze

  def raw_round_trip(wire_case)
    given = wire_case["given"]
    server = TCPServer.new("127.0.0.1", 0)
    reader = Thread.new { serve_once(server, wire_case["server"]) }
    WebMock.disable_net_connect!(allow_localhost: true)
    fetcher = build_fetcher(given["sdkKey"] || WIRE_SDK_KEY, "http://127.0.0.1:#{server.addr[1]}")
    result = fetcher.fetch(given["previousEtag"])
    fetcher.close
    [reader.join(RAW_WAIT_SECONDS)&.value, result]
  ensure
    reader&.kill
    WebMock.disable_net_connect!(allow_localhost: false)
    server&.close
  end

  def serve_once(server, case_server)
    return nil unless server.wait_readable(RAW_WAIT_SECONDS)

    socket = server.accept
    socket.binmode
    line = socket.gets("\r\n")
    headers = read_raw_headers(socket)
    socket.write(raw_response(case_server))
    { line: line, headers: headers }
  ensure
    socket&.close
  end

  # Request headers as received, names lower-cased.
  def read_raw_headers(socket)
    headers = {}
    while (header = socket.gets("\r\n")) && header != "\r\n"
      name, value = header.delete_suffix("\r\n").split(":", 2)
      headers[name.strip.downcase] = value.to_s.strip
    end
    headers
  end

  # The case's status, headers and body as an HTTP/1.1 response. A 1xx,
  # 204 or 304 carries no body (RFC 9110 §6.4.1), so none is framed.
  def raw_response(case_server)
    status = Integer(case_server["status"])
    bodyless = status < 200 || [204, 304].include?(status)
    body = bodyless ? "" : resolve_body(case_server).to_s
    head = ["HTTP/1.1 #{status} Wire Case"]
    (case_server["headers"] || {}).each do |name, value|
      head << "#{name}: #{value}" unless RAW_FRAMING_HEADERS.include?(name.downcase)
    end
    head << "Content-Length: #{body.bytesize}" unless bodyless
    head << "Connection: close"
    "#{head.join("\r\n")}\r\n\r\n".b + body.b
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
    mapped = self.class.ruby_error_to_class(result.error)
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

  CORPUS = load_corpus

  CORPUS["cases"].each do |wire_case|
    describe "case #{wire_case["id"]}" do
      # The whole case ON THE WIRE (#803 brief item 4): a real Net::HTTP
      # talks to a real socket that answers with the case's own status,
      # headers and body. The raw request line must carry
      # expected.requestPath byte for byte — non-ASCII key bytes included
      # (é€😀 in request-path-malformed-key) — and the outcome must be the
      # corpus's. `given.baseUrl` is not used here (the listener is on
      # 127.0.0.1): `requestUrlPrefix` is asserted by the stubbed example.
      if (wire_case["server"]["behavior"] || "respond") == "respond"
        it "round-trips its status, headers and body over a raw socket", :aggregate_failures do
          expected = wire_case["expected"]
          raw, result = raw_round_trip(wire_case)
          expect(raw).not_to be_nil, "no request reached the raw listener"
          raw ||= {}
          line = raw[:line].to_s
          expect(line.encoding).to eq(Encoding::BINARY)
          expect(line).to start_with("GET ".b)
          expect(line).to end_with(" HTTP/1.1\r\n".b)
          target = line.delete_suffix("\r\n".b).split(" ".b)[1].to_s.split("?".b, 2).first.to_s
          if expected.key?("requestPath")
            expect(target).to eq(expected["requestPath"].b)
          else
            expect(target).to start_with("/configuration-files/".b)
            expect(target).to end_with("/config_v6.json".b)
          end
          assert_if_none_match(raw.fetch(:headers, {})["if-none-match"], expected)
          assert_outcome(wire_case, result)
        end
      end

      # `it` description is the corpus's case description — surfaces the
      # full contract intent in the rspec output. `aggregate_failures`
      # is used to keep the request- and outcome-side assertions inside
      # a single `it` block: the contract is one round-trip per case,
      # and surfacing every drift in one report makes diagnosing a
      # broken wire layer dramatically easier than chasing seven
      # sequential failures.
      it(wire_case["description"], :aggregate_failures) do
        given = wire_case["given"]
        server = wire_case["server"]
        expected = wire_case["expected"]

        unknown_given = given.keys - KNOWN_GIVEN_FIELDS
        unknown_expected = expected.keys - KNOWN_EXPECTED_FIELDS
        raise "case #{wire_case["id"]}: unknown given field(s) #{unknown_given}" unless unknown_given.empty?
        raise "case #{wire_case["id"]}: unknown expected field(s) #{unknown_expected}" unless unknown_expected.empty?

        sdk_key = given["sdkKey"] || WIRE_SDK_KEY
        base_url = given["baseUrl"] || WIRE_BASE_URL
        body = resolve_body(server)
        stub = stub_for_behavior(server, body, base_url)

        sent_targets = record_sent_targets
        fetcher = build_fetcher(sdk_key, base_url)
        result = fetcher.fetch(given["previousEtag"])
        fetcher.close

        # ---- Request-side assertions ------------------------------------
        expect(stub).to have_been_requested.once
        request = WebMock::RequestRegistry.instance.requested_signatures.hash.keys.first
        expect(request).not_to be_nil

        assert_request_url(request, fetcher, sent_targets, expected)

        assert_if_none_match(request.headers["If-None-Match"], expected)

        # ---- Outcome assertions -----------------------------------------
        assert_outcome(wire_case, result)
      end
    end
  end
end
