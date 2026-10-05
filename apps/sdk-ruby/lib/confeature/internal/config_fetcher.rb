# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "json"
require "net/http"
require "uri"

require_relative "sdk_key"

module Confeature
  module Internal
    # HTTP layer for fetching `config_v6.json` from a Confeature CDN.
    #
    # Wraps stdlib `Net::HTTP` with:
    #   - User-Agent: `confeature-ruby-sdk/{VERSION}` (FR-012).
    #   - If-None-Match support for 304 reuse (FR-011).
    #   - Configurable request timeout (default 30 s, FR-007).
    #   - SDK key redaction in every log line (FR-013): the raw key is
    #     NEVER interpolated into messages; `SdkKey.redact` is the only
    #     path.
    #
    # `FetchResult.status` is one of:
    #   - :fetched      — HTTP 200, fresh body + new ETag.
    #   - :not_modified — HTTP 304, caller keeps its cached body.
    #   - :failed       — network error / non-2xx / timeout. `error`
    #     carries a FIXED, key-free reason code (#803 FR-002).
    #
    # The request URL carries the SDK key, as in every ConfigCat SDK —
    # the `configcat` gem builds `<base>/configuration-files/<sdk_key>/
    # config_v6.json` (configcat-8.0.1 `lib/configcat/configfetcher.rb:168`).
    # So no exception text is ever passed on (it may quote the URL): only
    # the exception's class picks a fixed reason code.
    class ConfigFetcher
      DEFAULT_BASE_URL = "https://cdn-global.confeature.io"

      # Reason code when the key cannot be placed in a path segment
      # ("", "." or "..") — the fetcher refuses to fetch (#803 FR-001).
      INVALID_SDK_KEY = "INVALID_SDK_KEY"

      # Reason code when the base URL cannot form an absolute http(s)
      # URL — no request is made (#803 FR-002; sdk-go's code).
      INVALID_REQUEST = "invalid_request"

      # Transport failures -> fixed, key-free reason codes (#803 FR-002;
      # mirrors sdk-go's `classifyError`). Order matters: a timeout is
      # checked first (`Net::OpenTimeout` etc. descend from
      # `Timeout::Error`).
      TIMEOUT_ERRORS = [Timeout::Error].freeze
      CONNECTION_RESET_ERRORS = [
        EOFError, Errno::ECONNRESET, Errno::ECONNABORTED, Errno::EPIPE, IOError
      ].freeze

      # Bytes kept as-is in a path segment — Go's `url.PathEscape` set:
      # unreserved chars plus `$ & + : = @`. Everything else
      # (including `/`, `?`, `;`, `,`, `%`) is percent-encoded.
      PATH_SEGMENT_UNSAFE = /[^A-Za-z0-9\-_.~$&+:=@]/n

      FetchResult = Struct.new(:status, :body, :etag, :error, keyword_init: true)

      attr_reader :url, :user_agent

      def initialize(sdk_key:, version:, logger:, base_url: nil, request_timeout_seconds: 30.0)
        raise ArgumentError, "request_timeout_seconds must be > 0" if request_timeout_seconds <= 0

        @sdk_key = sdk_key
        @logger = logger
        @timeout = request_timeout_seconds
        @user_agent = "confeature-ruby-sdk/#{version}"
        # Every trailing "/" goes, so `<base>//configuration-files` never
        # happens. The URL is NOT parsed here: a bad base URL must not
        # raise from the constructor (a `URI::InvalidURIError` quotes the
        # whole URL, key included). `fetch` parses it and maps a failure
        # to the fixed `invalid_request` code (#803 FR-002).
        @base_url = (base_url || DEFAULT_BASE_URL).to_s.sub(%r{/+\z}, "")
        @url = self.class.config_url(@base_url, sdk_key)
      end

      # The ONE function that builds the config URL (#803 FR-001) —
      # ConfigCat's `<base>/configuration-files/<sdkKey>/config_v6.json`.
      #
      #   - A key matching the shared shape (`sdk-key-shapes.json`) goes
      #     in RAW: split on `/`, each part path-segment-escaped (a no-op
      #     for a valid key), so `configcat-sdk-1/<22>/<22>` is three
      #     segments — the stock `configcat` gem's exact bytes.
      #   - Any other key is escaped into ONE segment (Go's
      #     `url.PathEscape`). When that segment is "", "." or "..", no
      #     escaper keeps it in place: returns nil and the fetcher refuses
      #     to fetch.
      def self.config_url(base_url, sdk_key)
        key = sdk_key.to_s
        segments =
          if SdkKey.valid_confeature_key_format?(key)
            key.split("/").map { |part| escape_path_segment(part) }
          else
            segment = escape_path_segment(key)
            return nil if ["", ".", ".."].include?(segment)

            [segment]
          end
        "#{base_url}/configuration-files/#{segments.join("/")}/config_v6.json"
      end

      def self.escape_path_segment(part)
        part.b.gsub(PATH_SEGMENT_UNSAFE) { |byte| format("%%%02X", byte.ord) }
      end

      # Reduce a transport / body-read exception to a FIXED, key-free
      # reason code (#803 FR-002). The message is never read.
      def self.classify_error(exc)
        return "timeout" if TIMEOUT_ERRORS.any? { |klass| exc.is_a?(klass) }
        return "connection_reset" if CONNECTION_RESET_ERRORS.any? { |klass| exc.is_a?(klass) }

        "network_error"
      end

      # Fetch the config. Never raises — fail-closed.
      def fetch(etag = nil)
        return refuse_invalid_key if @url.nil?

        uri = request_uri
        return fail_with(INVALID_REQUEST) if uri.nil?

        http = build_http(uri)
        request = Net::HTTP::Get.new(uri.request_uri, build_headers(etag))
        response = http.request(request)
        parse(response)
      rescue StandardError => e
        handle_exception(e)
      end

      # No persistent connection in v1 (one connection per fetch keeps
      # the implementation tiny and matches the synchronous polling
      # semantics). Method retained for API symmetry with the other
      # SDKs and to give future connection-pooling somewhere to land.
      def close
        # No-op in v1.
      end

      private

      # The parsed request URL, or nil when the base URL cannot form an
      # absolute http(s) URL. The `URI::Error` is dropped here, unread:
      # its message quotes the whole URL, key included.
      #
      # The key path `config_url` builds never holds a raw `?` or `#` (a
      # well-shaped key has none; `escape_path_segment` escapes them), so
      # a query or fragment here can only come from a base URL holding
      # `?` or `#` — which would move the key out of the path, into the
      # query string (sent, and logged by proxies as a parameter) or the
      # fragment (never sent). Such a base is refused: no request (as
      # sdk-dart's `_parseTarget`).
      def request_uri
        uri = URI.parse(@url)
        return nil unless uri.is_a?(URI::HTTP) && !uri.host.to_s.empty?
        return nil unless uri.query.nil? && uri.fragment.nil?

        uri
      rescue URI::Error
        nil
      end

      def build_http(uri)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == "https"
        http.open_timeout = @timeout
        http.read_timeout = @timeout
        http.write_timeout = @timeout if http.respond_to?(:write_timeout=)
        http
      end

      def build_headers(etag)
        headers = {
          "User-Agent" => @user_agent,
          "Accept" => "application/json"
        }
        headers["If-None-Match"] = etag if etag && !etag.empty?
        headers
      end

      def parse(response)
        case response
        when Net::HTTPNotModified
          FetchResult.new(status: :not_modified, etag: response["etag"])
        when Net::HTTPSuccess
          parse_success(response)
        else
          reason = "HTTP #{response.code}"
          @logger.error(
            "ConfigFetcher: fetch failed for sdkKey=#{SdkKey.redact(@sdk_key)} reason=#{reason}"
          )
          FetchResult.new(status: :failed, error: reason)
        end
      end

      def parse_success(response)
        body = JSON.parse(response.body)
        unless body.is_a?(Hash)
          @logger.error(
            "ConfigFetcher: fetch returned non-object JSON for " \
            "sdkKey=#{SdkKey.redact(@sdk_key)}"
          )
          return FetchResult.new(status: :failed, error: "MALFORMED_JSON")
        end

        # Shape validation: a valid `config_v6.json` carries the
        # `{p, f, s}` top-level shape. sdk-node / sdk-python / sdk-go
        # tightened the same check so the corpus-wide
        # `wire-cases.json::wrong-shape-200` case surfaces the same
        # `parseFailed` everywhere (epic #146 / issue #148). A 200
        # with a body that does not match the contract is a stronger
        # signal of CDN drift than a 5xx and deserves its own typed
        # error class. Probing the `f` key alone is sufficient — it
        # is the only mandatory top-level key in the schema.
        unless body.key?("f")
          @logger.error(
            "ConfigFetcher: fetch returned JSON without 'f' key for " \
            "sdkKey=#{SdkKey.redact(@sdk_key)}"
          )
          return FetchResult.new(status: :failed, error: "MALFORMED_JSON")
        end

        FetchResult.new(status: :fetched, body: body, etag: response["etag"])
      rescue JSON::ParserError => e
        @logger.error(
          "ConfigFetcher: fetch returned non-JSON body for " \
          "sdkKey=#{SdkKey.redact(@sdk_key)}: #{e.class}"
        )
        FetchResult.new(status: :failed, error: "MALFORMED_JSON")
      end

      def refuse_invalid_key
        @logger.error(
          "ConfigFetcher: #{INVALID_SDK_KEY} for sdkKey=#{SdkKey.redact(@sdk_key)} " \
          "— the key cannot form a request path; not fetching"
        )
        FetchResult.new(status: :failed, error: INVALID_SDK_KEY)
      end

      def handle_exception(exc)
        # The URL holds the SDK key and exception messages may quote it:
        # only the exception's class picks a fixed reason code.
        fail_with(self.class.classify_error(exc))
      end

      def fail_with(reason)
        @logger.error(
          "ConfigFetcher: fetch failed for sdkKey=#{SdkKey.redact(@sdk_key)} reason=#{reason}"
        )
        FetchResult.new(status: :failed, error: reason)
      end
    end
  end
end
