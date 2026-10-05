# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Internal::PollService do
  let(:fetched_result) do
    Confeature::Internal::ConfigFetcher::FetchResult.new(
      status: :fetched, body: { "f" => {} }, etag: "v1"
    )
  end

  describe described_class::AutoPollService do
    it "kicks off an eager initial fetch and joins on stop" do
      calls = 0
      callback = lambda do
        calls += 1
        fetched_result
      end

      service = described_class.new(
        Confeature::PollingMode.auto_poll(poll_interval: 60, max_init_wait_time: 1)
      )
      service.start(callback)
      service.stop(timeout: 2)

      expect(calls).to be >= 1
    end

    it "is idempotent on start" do
      calls = 0
      callback = lambda {
        calls += 1
        fetched_result
      }
      service = described_class.new(
        Confeature::PollingMode.auto_poll(poll_interval: 60, max_init_wait_time: 1)
      )
      service.start(callback)
      service.start(callback)
      service.stop(timeout: 2)
      # Eager fetch only happened once.
      expect(calls).to eq(1)
    end

    it "returns NOT_STARTED on force_refresh before start" do
      service = described_class.new(
        Confeature::PollingMode.auto_poll(poll_interval: 60, max_init_wait_time: 1)
      )
      result = service.force_refresh
      expect(result.success).to be(false)
      expect(result.error).to eq("NOT_STARTED")
    end
  end

  describe described_class::LazyLoadService do
    it "fetches on the first get_value past the staleness threshold" do
      calls = 0
      callback = lambda {
        calls += 1
        fetched_result
      }
      service = described_class.new(
        Confeature::PollingMode.lazy_load(cache_refresh_interval: 0.0)
      )
      service.start(callback)
      service.maybe_fetch_for_get_value
      service.maybe_fetch_for_get_value
      expect(calls).to be >= 2
    end

    it "force_refresh succeeds when the callback returns :fetched" do
      callback = -> { fetched_result }
      service = described_class.new(
        Confeature::PollingMode.lazy_load(cache_refresh_interval: 60)
      )
      service.start(callback)
      result = service.force_refresh
      expect(result.success).to be(true)
    end
  end

  describe described_class::ManualPollService do
    it "returns NOT_STARTED before start" do
      service = described_class.new
      expect(service.force_refresh.success).to be(false)
      expect(service.force_refresh.error).to eq("NOT_STARTED")
    end

    it "invokes the callback on every force_refresh" do
      calls = 0
      callback = lambda {
        calls += 1
        fetched_result
      }
      service = described_class.new
      service.start(callback)
      service.force_refresh
      service.force_refresh
      expect(calls).to eq(2)
    end
  end

  describe ".build" do
    it "returns AutoPollService for an AutoPoll value" do
      svc = described_class.build(Confeature::PollingMode.auto_poll)
      expect(svc).to be_a(described_class::AutoPollService)
    end

    it "returns LazyLoadService for a LazyLoad value" do
      svc = described_class.build(Confeature::PollingMode.lazy_load)
      expect(svc).to be_a(described_class::LazyLoadService)
    end

    it "returns ManualPollService for a ManualPoll value" do
      svc = described_class.build(Confeature::PollingMode.manual_poll)
      expect(svc).to be_a(described_class::ManualPollService)
    end

    it "raises ArgumentError for an unknown mode" do
      expect { described_class.build(Object.new) }.to raise_error(ArgumentError)
    end
  end
end
