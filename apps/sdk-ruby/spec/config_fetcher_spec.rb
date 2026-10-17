# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "socket"

RSpec.describe Confeature::Internal::ConfigFetcher do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }
  let(:sdk_key) { SpecHelpers::SAMPLE_SDK_KEY }
  let(:fetcher) do
    described_class.new(
      sdk_key: sdk_key,
      version: Confeature::VERSION,
      logger: silent_logger,
      base_url: "https://cdn.example.test",
      request_timeout_seconds: 2.0
    )
  end

  let(:expected_url) do
    "https://cdn.example.test/configuration-files/#{sdk_key}/config_v6.json"
  end

  def fetcher_for(key, logger: silent_logger, timeout: 2.0, base_url: "https://cdn.example.test")
    described_class.new(
      sdk_key: key, version: Confeature::VERSION, logger: logger,
      base_url: base_url, request_timeout_seconds: timeout
    )
  end

  # Runs the block and returns `[value, raised]` — any exception
  # (`Exception`, so WebMock's `NetConnectNotAllowedError` too) is
  # captured, never allowed to end the example.
  def capture_raise
    [yield, nil]
  rescue Exception => e # rubocop:disable Lint/RescueException
    [nil, e]
  end

  def parsed_path(url)
    URI.parse(url).path
  end

  # #803 FR-001/FR-004 — the request path is ConfigCat's
  # `/configuration-files/<sdkKey>/config_v6.json` (configcat gem
  # `lib/configcat/configfetcher.rb:168`). Pins compare the PARSED PATH,
  # never the full URL string (#807 may add a query).
  describe "request path" do
    it "puts a legacy key in the path raw, as one segment" do
      expect(parsed_path(fetcher_for(sdk_key).url))
        .to eq("/configuration-files/#{sdk_key}/config_v6.json")
    end

    it "puts a ConfigCat-shaped key in the path raw — three segments, no %2F" do
      key = SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY
      url = fetcher_for(key).url
      expect(parsed_path(url)).to eq("/configuration-files/#{key}/config_v6.json")
      expect(url).not_to include("%2F")
    end

    it "takes the path from every valid key in sdk-key-shapes.json raw" do
      SpecHelpers.sdk_key_shapes["valid"].each do |entry|
        expect(parsed_path(fetcher_for(entry["key"]).url))
          .to eq("/configuration-files/#{entry["key"]}/config_v6.json"), entry["name"]
      end
    end

    it "escapes a malformed key into ONE segment (Go url.PathEscape)" do
      url = fetcher_for("bad/key?x=1 ;,%").url
      expect(parsed_path(url))
        .to eq("/configuration-files/bad%2Fkey%3Fx=1%20%3B%2C%25/config_v6.json")
      expect(URI.parse(url).query).to be_nil
    end

    # Literals are real `go run` output of url.PathEscape — never built
    # with the escaper under test.
    {
      "bad key$&+:=@,;!'()*~/x?y#z%.." => "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
      "bad key$&+:=@,;!'()*~/x?y#z%é€😀.." =>
        "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80..",
      "bad/key?x=1 ;,%" => "bad%2Fkey%3Fx=1%20%3B%2C%25",
      "caf\u00e9-key" => "caf%C3%A9-key"
    }.each do |key, escaped|
      it "escapes the malformed key #{key.inspect} as Go url.PathEscape: #{escaped}" do
        expect(parsed_path(fetcher_for(key).url)).to eq("/configuration-files/#{escaped}/config_v6.json")
      end
    end

    # A key in a broken or non-UTF-8 encoding is malformed, not an
    # encoding error: its bytes are escaped like any other (#803).
    {
      "invalid UTF-8" => ["k\xFFey-".dup.force_encoding(Encoding::UTF_8) * 4, "k%FFey-" * 4],
      "binary with high bytes" => [("\xFE\xFF".b * 10), "%FE%FF" * 10]
    }.each do |name, (key, escaped)|
      it "forms a request path for a key in #{name} and fetches, raising nothing" do
        stub = stub_request(:get, %r{\Ahttps://cdn\.example\.test/}).to_return(status: 200, body: '{"f":{}}')
        client, raised = capture_raise do
          Confeature::Client.new(
            sdk_key: key, base_url: "https://cdn.example.test", logger: silent_logger,
            polling_mode: Confeature::PollingMode.manual_poll
          ).tap(&:force_refresh)
        end
        client&.close
        expect(raised).to be_nil
        expect(parsed_path(fetcher_for(key).url)).to eq("/configuration-files/#{escaped}/config_v6.json")
        expect(stub).to have_been_requested.once
      end
    end

    it "strips EVERY trailing slash from the base URL" do
      expect(parsed_path(fetcher_for(sdk_key, base_url: "https://cdn.example.test///").url))
        .to eq("/configuration-files/#{sdk_key}/config_v6.json")
      expect(parsed_path(fetcher_for(sdk_key, base_url: "https://cdn.example.test/proxy//").url))
        .to eq("/proxy/configuration-files/#{sdk_key}/config_v6.json")
    end

    it "keeps no /v2/ prefix and no cache-key tail of the key" do
      tail = Confeature.derive_cache_key(sdk_key).split(":").last
      expect(fetcher_for(sdk_key).url).not_to include("/v2/")
      expect(fetcher_for(sdk_key).url).not_to include(tail)
    end

    ["", ".", ".."].each do |key|
      it "refuses to fetch for the key #{key.inspect} — redacted INVALID_SDK_KEY, no request" do
        captured = []
        logger = SpecHelpers::CapturingLogger.new(captured)
        stub = stub_request(:any, /cdn\.example\.test/)
        result = fetcher_for(key, logger: logger).fetch
        expect(result.status).to eq(:failed)
        expect(result.error).to eq("INVALID_SDK_KEY")
        expect(stub).not_to have_been_requested
        expect(captured.join("\n")).to include("INVALID_SDK_KEY")
      end
    end
  end

  it "sends the confeature-ruby-sdk User-Agent header" do
    stub = stub_request(:get, expected_url)
           .with(headers: { "User-Agent" => "confeature-ruby-sdk/#{Confeature::VERSION}" })
           .to_return(status: 200, body: '{"f":{}}', headers: { "ETag" => "v1" })

    result = fetcher.fetch
    expect(stub).to have_been_requested
    expect(result.status).to eq(:fetched)
    expect(result.etag).to eq("v1")
  end

  it "returns :not_modified on HTTP 304 and forwards the supplied ETag" do
    stub_request(:get, expected_url)
      .with(headers: { "If-None-Match" => "etag-x" })
      .to_return(status: 304, headers: { "ETag" => "etag-x" })

    result = fetcher.fetch("etag-x")
    expect(result.status).to eq(:not_modified)
    expect(result.etag).to eq("etag-x")
  end

  it "returns :failed with HTTP N reason on non-2xx" do
    stub_request(:get, expected_url).to_return(status: 500)
    result = fetcher.fetch
    expect(result.status).to eq(:failed)
    expect(result.error).to eq("HTTP 500")
  end

  it "returns :failed with MALFORMED_JSON when the body is not valid JSON" do
    stub_request(:get, expected_url).to_return(status: 200, body: "not-json{")
    result = fetcher.fetch
    expect(result.status).to eq(:failed)
    expect(result.error).to eq("MALFORMED_JSON")
  end

  # #803 FR-002/FR-004 — the URL now holds the key, so every transport
  # failure must reach logs and `FetchResult.error` as a fixed code.
  describe "key-free failures" do
    keys = {
      "legacy" => SpecHelpers::SAMPLE_SDK_KEY,
      "configcat-shaped" => SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY
    }
    url_quoting_error = lambda do |klass, key|
      klass.new("failed GET https://cdn.example.test/configuration-files/#{key}/config_v6.json")
    end
    failures = {
      "a timeout" => [->(stub, _key) { stub.to_timeout }, "timeout"],
      "a timeout quoting the URL" => [
        ->(stub, key) { stub.to_raise(url_quoting_error.call(Net::ReadTimeout, key)) }, "timeout"
      ],
      "a mid-body reset" => [
        ->(stub, key) { stub.to_raise(url_quoting_error.call(EOFError, key)) }, "connection_reset"
      ],
      "a connection reset" => [
        ->(stub, key) { stub.to_raise(url_quoting_error.call(Errno::ECONNRESET, key)) }, "connection_reset"
      ],
      "an unknown network error" => [
        ->(stub, key) { stub.to_raise(url_quoting_error.call(SocketError, key)) }, "network_error"
      ],
      "a redirect loop" => [
        lambda do |stub, key|
          stub.to_return(
            status: 302,
            headers: { "Location" => "https://cdn.example.test/configuration-files/#{key}/config_v6.json" }
          )
        end,
        "HTTP 302"
      ]
    }

    keys.each do |key_name, key|
      failures.each do |failure_name, (arrange, reason)|
        it "reports #{failure_name} for a #{key_name} key as #{reason.inspect} with no key in logs or error" do
          captured = []
          stub = stub_request(:get, "https://cdn.example.test/configuration-files/#{key}/config_v6.json")
          arrange.call(stub, key)
          result = fetcher_for(key, logger: SpecHelpers::CapturingLogger.new(captured)).fetch

          expect(result.status).to eq(:failed)
          expect(result.error).to eq(reason)
          expect(captured).not_to be_empty
          SpecHelpers.key_secrets(key).each do |secret|
            captured.each { |line| expect(line).not_to include(secret) }
            expect(result.error).not_to include(secret)
          end
        end
      end
    end
  end

  # #803 FR-002 — a base URL that cannot form an absolute http(s) URL
  # ends as the fixed `invalid_request`, with no request. It never
  # raises — constructor included: a `URI::InvalidURIError` quotes the
  # whole URL, key included.
  # Found by the live suite (#920): two Net::HTTP behaviours WebMock cannot
  # show, so these examples talk to a real socket on 127.0.0.1.
  describe "over a real socket" do
    # Accepts every connection, reads its request, then runs `respond`
    # (nil = hold it unanswered). Returns the accepted-connection count.
    def serve(respond)
      server = TCPServer.new("127.0.0.1", 0)
      accepted = Queue.new
      thread = Thread.new do
        loop do
          socket = server.accept
          accepted << socket
          socket.gets("\r\n\r\n")
          respond&.call(socket)
        end
      end
      WebMock.disable_net_connect!(allow_localhost: true)
      yield "http://127.0.0.1:#{server.addr[1]}"
      accepted.size
    ensure
      thread&.kill
      accepted&.size&.times { accepted.pop.close }
      server&.close
      WebMock.disable_net_connect!(allow_localhost: false)
    end

    # Net::HTTP retries an idempotent GET once on a read timeout
    # (`max_retries` defaults to 1): two requests, and twice the deadline,
    # for one fetch. One fetch is one request; the poller owns retrying.
    it "sends one request when the read times out" do
      result = nil
      connections = serve(nil) { |base| result = fetcher_for(sdk_key, timeout: 0.2, base_url: base).fetch }
      expect([result.status, result.error, connections]).to eq([:failed, "timeout", 1])
    end

    # Net::HTTP reads a Content-Length body ignoring EOF, so a body cut
    # short arrives as a short string, never an EOFError: it is a dropped
    # connection (fetchFailed), not a JSON error (wire-cases `network-reset`).
    it "reports a body cut short of its Content-Length as connection_reset" do
      cut = lambda do |socket|
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{\"f\":")
        socket.close
      end
      result = nil
      serve(cut) { |base| result = fetcher_for(sdk_key, base_url: base).fetch }
      expect([result.status, result.error]).to eq([:failed, "connection_reset"])
    end
  end

  describe "a bad base URL" do
    keys = {
      "legacy" => SpecHelpers::SAMPLE_SDK_KEY,
      "configcat-shaped" => SpecHelpers::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY
    }
    bad_base_urls = {
      "a stray trailing space" => "https://cdn.example.com ",
      "an inner space" => "https://cdn.exa mple.com",
      "an unbalanced IPv6 bracket" => "https://[::1",
      "no scheme" => "cdn.example.com",
      "no host" => "https://",
      "a non-http scheme" => "ftp://cdn.example.com",
      # A `?` or `#` in the base would move the key out of the path —
      # into the query string (sent) or the fragment (never sent).
      "a bare query mark" => "https://cdn.example.com?",
      "a query" => "https://cdn.example.com/edge?x=1",
      "a query before a trailing slash" => "https://cdn.example.com?/",
      "a bare fragment mark" => "https://cdn.example.com#",
      "a fragment" => "https://cdn.example.com/#frag"
    }

    def assert_key_free(key, captured, raised, *values)
      surfaces = captured + values.map(&:to_s)
      surfaces += SpecHelpers.printable_forms(raised) if raised
      SpecHelpers.key_secrets(key).each do |secret|
        surfaces.each { |surface| expect(surface).not_to include(secret) }
      end
    end

    keys.each do |key_name, key|
      bad_base_urls.each do |url_name, base_url|
        it "fails a #{key_name} key with #{url_name} as invalid_request — no request, no key anywhere" do
          captured = []
          logger = SpecHelpers::CapturingLogger.new(captured)
          result, raised = capture_raise { fetcher_for(key, logger: logger, base_url: base_url).fetch }

          assert_key_free(key, captured, raised, result&.error)
          expect(raised).to be_nil
          expect(result.error).to eq("invalid_request")
          expect(captured.join("\n")).to include("invalid_request")
          expect(a_request(:any, //)).not_to have_been_made
        end

        it "builds a Client for a #{key_name} key with #{url_name} and refreshes, raising nothing" do
          captured = []
          logger = SpecHelpers::CapturingLogger.new(captured)
          refresh, raised = capture_raise do
            client = Confeature::Client.new(
              sdk_key: key, base_url: base_url, logger: logger,
              polling_mode: Confeature::PollingMode.manual_poll
            )
            client.force_refresh.tap { client.close }
          end

          assert_key_free(key, captured, raised, refresh&.error)
          expect(raised).to be_nil
          expect(a_request(:any, //)).not_to have_been_made
        end
      end
    end
  end

  it "rejects a zero or negative timeout at construction time" do
    expect do
      described_class.new(
        sdk_key: sdk_key,
        version: Confeature::VERSION,
        logger: silent_logger,
        request_timeout_seconds: 0
      )
    end.to raise_error(ArgumentError, /request_timeout_seconds/)
  end
end
