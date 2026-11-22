# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "json"
require "net/http"
require "uri"
require "minitest/autorun"
require "webmock"
require "confeature_openfeature"
require "open_feature/sdk/isolated"

class HttpConsumerTest < Minitest::Test
  include WebMock::API

  SDK = OpenFeature::SDK
  KEY = JSON.parse(File.read(File.join(__dir__, "http-seed.json"))).fetch("keys").first.fetch("sdkKey")
  ORIGIN = URI(ENV.fetch("LIVE_HARNESS_URL"))

  unless ENV["CONFEATURE_LIVE"] == "1" && ORIGIN.scheme == "http" && ORIGIN.host == "127.0.0.1" &&
         ORIGIN.port > 1023 && ORIGIN.userinfo.nil? && ["", "/"].include?(ORIGIN.path) &&
         ORIGIN.query.nil? && ORIGIN.fragment.nil?
    raise "Run this suite through the local live-contract harness."
  end

  def setup
    %w[http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY].each { |key| ENV.delete(key) }
    WebMock.enable!
    WebMock.disable_net_connect!(allow: lambda do |uri|
      uri.scheme == ORIGIN.scheme && uri.host == ORIGIN.host && uri.port == ORIGIN.port
    end)
    @before = requests.size
  end

  def teardown
    @api&.shutdown
    @native&.close
    WebMock.reset!
  end

  def test_manual_poll_does_not_fetch_until_native_refresh
    start_client(Confeature::PollingMode.manual_poll)
    cold = evaluate
    assert_equal [true, "PROVIDER_NOT_READY"], [cold.value, cold.error_code]
    assert_empty new_requests

    assert @native.force_refresh.success
    assert_rollout evaluate("manual-subject")
    assert_equal 1, new_requests.size

    @api.shutdown
    refute @native.get_value("identity", true)
    assert_equal 1, new_requests.size
  end

  def test_auto_poll_fetches_once_and_isolates_concurrent_contexts
    start_client(Confeature::PollingMode.auto_poll(poll_interval: 3600))
    assert_equal 1, new_requests.size

    results = ["auto-subject", nil, "", nil].map do |identity|
      Thread.new { evaluate(identity) }
    end.map(&:value)
    assert_equal ["rollout", "baseline", "rollout", "baseline"], results.map(&:variant)
    assert_equal [true, false, true, false], results.map(&:value)
    assert_equal 1, new_requests.size
  end

  def test_lazy_load_serves_cached_values_offline_and_revalidates_when_online
    start_client(Confeature::PollingMode.lazy_load(cache_refresh_interval: 0))
    assert_empty new_requests
    assert_rollout evaluate("lazy-subject")
    assert_equal 1, new_requests.size

    @native.set_offline
    assert_rollout evaluate("lazy-subject")
    assert_equal 1, new_requests.size

    @native.set_online
    assert_rollout evaluate("lazy-subject")
    assert_equal 2, new_requests.size
    assert_equal '"ruby-provider"', new_requests.last.fetch("ifNoneMatch")
  end

  def test_network_guard_rejects_other_local_ports_before_connecting
    assert_raises(WebMock::NetConnectNotAllowedError) do
      Net::HTTP.get_response(URI("http://127.0.0.1:1/"))
    end
  end

  def test_native_refresh_does_not_follow_an_out_of_origin_redirect
    start_client(Confeature::PollingMode.manual_poll)
    config_url = ORIGIN + "/configuration-files/#{KEY}/config_v6.json"
    redirect = stub_request(:get, config_url).to_return(
      status: 302, headers: { "Location" => "http://127.0.0.1:1/" }
    )

    refresh = @native.force_refresh
    assert_equal [false, "HTTP 302"], [refresh.success, refresh.error]
    assert_requested redirect, times: 1
    cold = evaluate
    assert_equal [true, "PROVIDER_NOT_READY"], [cold.value, cold.error_code]
    assert_empty new_requests
  end

  private

  def start_client(mode)
    @native = Confeature::Client.new(sdk_key: KEY, base_url: ORIGIN.to_s, polling_mode: mode,
                                     cache_directory: :memory, request_timeout_seconds: 3)
    @api = SDK::Isolated.create_api
    @api.set_provider_and_wait(ConfeatureOpenFeature::Provider.new(client: @native), domain: "loopback")
    @client = @api.build_client(domain: "loopback")
  end

  def evaluate(identity = nil)
    context = identity.nil? ? nil : SDK::EvaluationContext.new(targeting_key: identity)
    @client.fetch_boolean_details(flag_key: "identity", default_value: true, evaluation_context: context)
  end

  def assert_rollout(result)
    assert_equal [true, "rollout", "SPLIT", nil], [result.value, result.variant, result.reason, result.error_code]
  end

  def requests
    url = ORIGIN + "/admin/requests"
    url.query = URI.encode_www_form(sdkKey: KEY)
    response = Net::HTTP.get_response(url)
    assert_equal "200", response.code
    JSON.parse(response.body).fetch("requests")
  end

  def new_requests
    requests.drop(@before)
  end
end
