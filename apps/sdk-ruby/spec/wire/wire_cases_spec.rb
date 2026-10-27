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
# What a case's `expected` block means lives in `WireCaseAssertions`
# (wire_case_assertions.rb), shared with the live suite
# (wire_cases_live_spec.rb, #920) so both are judged by the same rules.
#
# See epic #146 (contract testing framework) + #148 slice 9 (this
# suite) + spec 112.

require "json"
require "io/wait"
require "socket"

require_relative "wire_case_assertions"

RSpec.describe "wire-cases.json contract (Ruby)" do
  include WireCaseAssertions

  WIRE_SDK_KEY = SpecHelpers::SAMPLE_SDK_KEY
  WIRE_BASE_URL = "https://cdn.wire-test.confeature.io"
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
  def assert_request_url(request, fetcher, sent_targets, wire_case, sdk_key)
    expected = wire_case["expected"]
    uri = request.uri
    uri = uri.omit(:port) if uri.port == uri.default_port
    expect(sent_targets.size).to eq(1), "expected one request sent, got #{sent_targets.size}"
    sent_path = sent_targets.first.to_s.split("?", 2).first
    expect(URI.parse(fetcher.url).path).to eq(expected["requestPath"]) if expected.key?("requestPath")
    assert_request(wire_case, path: sent_path, url: uri.to_s, sdk_key: sdk_key)
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
    fetcher = build_fetcher(WireCaseAssertions.sdk_key_for(wire_case, WIRE_SDK_KEY), "http://127.0.0.1:#{server.addr[1]}")
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

  CORPUS = WireCaseAssertions.load_corpus

  CORPUS["pending"].each do |id, ticket|
    it "case #{id} is pending (#{ticket}): this reader cannot read it yet" do
      skip "pending (#{ticket}) — wire-cases-pending.json"
    end
  end

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
          sdk_key = WireCaseAssertions.sdk_key_for(wire_case, WIRE_SDK_KEY)
          expect(target).to eq(WireCaseAssertions.request_path_for(wire_case, sdk_key).b)
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

        assert_known_fields(wire_case)

        sdk_key = WireCaseAssertions.sdk_key_for(wire_case, WIRE_SDK_KEY)
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

        assert_request_url(request, fetcher, sent_targets, wire_case, sdk_key)

        assert_if_none_match(request.headers["If-None-Match"], expected)

        # ---- Outcome assertions -----------------------------------------
        assert_outcome(wire_case, result)
      end
    end
  end
end
