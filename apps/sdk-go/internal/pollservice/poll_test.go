// SPDX-License-Identifier: MIT

package pollservice_test

import (
	"context"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/pollservice"
)

func waitForGoroutineBaseline(t *testing.T, baseline int) {
	t.Helper()
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= baseline {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("goroutine count did not return to baseline=%d within 200ms (current=%d)",
		baseline, runtime.NumGoroutine())
}

func TestAutoPoll_SpawnsAndStops(t *testing.T) {
	baseline := runtime.NumGoroutine()
	var calls atomic.Int32
	cb := func(_ context.Context) pollservice.FetchResult {
		calls.Add(1)
		return pollservice.FetchResult{OK: true}
	}
	svc := pollservice.Make(pollservice.AutoPollOptions{
		PollInterval:    20 * time.Millisecond,
		MaxInitWaitTime: 50 * time.Millisecond,
	})
	svc.Start(context.Background(), cb)
	// Initial fetch is eager, so calls >= 1 by the time Start returns.
	// Wait long enough for at least one ticker tick.
	time.Sleep(60 * time.Millisecond)
	if got := calls.Load(); got < 2 {
		t.Errorf("expected at least 2 fetches (initial + 1 tick); got %d", got)
	}
	if err := svc.Stop(500 * time.Millisecond); err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}
	waitForGoroutineBaseline(t, baseline)
}

func TestAutoPoll_StopIdempotent(t *testing.T) {
	svc := pollservice.Make(pollservice.AutoPollOptions{
		PollInterval: 50 * time.Millisecond,
	})
	svc.Start(context.Background(), func(_ context.Context) pollservice.FetchResult {
		return pollservice.FetchResult{OK: true}
	})
	if err := svc.Stop(time.Second); err != nil {
		t.Fatalf("first Stop: %v", err)
	}
	// Second Stop must not panic or block.
	if err := svc.Stop(time.Second); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}

func TestAutoPoll_ForceRefresh(t *testing.T) {
	var calls atomic.Int32
	cb := func(_ context.Context) pollservice.FetchResult {
		calls.Add(1)
		return pollservice.FetchResult{OK: true}
	}
	svc := pollservice.Make(pollservice.AutoPollOptions{
		PollInterval:    time.Hour, // Don't tick during the test.
		MaxInitWaitTime: time.Second,
	})
	svc.Start(context.Background(), cb)
	defer func() { _ = svc.Stop(time.Second) }()
	before := calls.Load()
	r := svc.ForceRefresh(context.Background())
	if !r.Success {
		t.Errorf("ForceRefresh failed: %v", r.Error)
	}
	if calls.Load() <= before {
		t.Errorf("ForceRefresh did not invoke callback")
	}
}

func TestLazyLoad_FetchesOnFirstGetValue(t *testing.T) {
	var calls atomic.Int32
	cb := func(_ context.Context) pollservice.FetchResult {
		calls.Add(1)
		return pollservice.FetchResult{OK: true}
	}
	svc := pollservice.Make(pollservice.LazyLoadOptions{
		CacheRefreshInterval: 50 * time.Millisecond,
	})
	svc.Start(context.Background(), cb)
	defer func() { _ = svc.Stop(time.Second) }()
	// First call → must trigger a fetch.
	svc.MaybeFetchForGetValue(context.Background())
	if got := calls.Load(); got != 1 {
		t.Errorf("first MaybeFetchForGetValue calls = %d; want 1", got)
	}
	// Second call within freshness window → no fetch.
	svc.MaybeFetchForGetValue(context.Background())
	if got := calls.Load(); got != 1 {
		t.Errorf("second MaybeFetchForGetValue (within freshness) calls = %d; want 1", got)
	}
	// Sleep past staleness.
	time.Sleep(80 * time.Millisecond)
	svc.MaybeFetchForGetValue(context.Background())
	if got := calls.Load(); got != 2 {
		t.Errorf("third MaybeFetchForGetValue (after staleness) calls = %d; want 2", got)
	}
}

func TestManualPoll_OnlyFetchesOnForceRefresh(t *testing.T) {
	var calls atomic.Int32
	cb := func(_ context.Context) pollservice.FetchResult {
		calls.Add(1)
		return pollservice.FetchResult{OK: true}
	}
	svc := pollservice.Make(pollservice.ManualPollOptions{})
	svc.Start(context.Background(), cb)
	defer func() { _ = svc.Stop(time.Second) }()
	svc.MaybeFetchForGetValue(context.Background())
	if got := calls.Load(); got != 0 {
		t.Errorf("ManualPoll MaybeFetch must not fetch; calls = %d", got)
	}
	r := svc.ForceRefresh(context.Background())
	if !r.Success {
		t.Errorf("ForceRefresh failed: %v", r.Error)
	}
	if got := calls.Load(); got != 1 {
		t.Errorf("ForceRefresh calls = %d; want 1", got)
	}
}

func TestForceRefresh_NotStarted(t *testing.T) {
	svc := pollservice.Make(pollservice.ManualPollOptions{})
	r := svc.ForceRefresh(context.Background())
	if r.Success {
		t.Error("ForceRefresh without Start must fail")
	}
	if r.Error == nil {
		t.Error("ForceRefresh without Start must populate Error")
	}
}

func TestAutoPoll_StopTimeout(t *testing.T) {
	// Construct a callback that never returns to verify Stop's timeout path.
	blocker := make(chan struct{})
	cb := func(ctx context.Context) pollservice.FetchResult {
		select {
		case <-blocker:
		case <-ctx.Done():
		}
		return pollservice.FetchResult{OK: true}
	}
	svc := pollservice.Make(pollservice.AutoPollOptions{
		PollInterval:    20 * time.Millisecond,
		MaxInitWaitTime: 10 * time.Millisecond,
	})
	svc.Start(context.Background(), cb)
	// Stop should still complete in time because ctx cancellation
	// propagates to the callback, which unblocks via ctx.Done().
	err := svc.Stop(500 * time.Millisecond)
	if err != nil {
		t.Errorf("Stop with cancellable callback timed out unexpectedly: %v", err)
	}
	close(blocker)
}
