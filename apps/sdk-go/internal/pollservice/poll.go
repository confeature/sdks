// SPDX-License-Identifier: MIT

// Package pollservice implements the three polling strategies:
// AutoPoll (goroutine + time.Ticker), LazyLoad (on-demand staleness-
// driven fetch), ManualPoll (fetches only on ForceRefresh).
//
// Lifecycle (research §R2):
//   - Start(ctx, callback): idempotent. AutoPoll fetches once eagerly
//     then spawns its goroutine. LazyLoad / ManualPoll just record
//     the callback.
//   - ForceRefresh(ctx): invokes the callback under the supplied
//     context and returns RefreshResult.
//   - Stop(timeout): cancels the goroutine's context and waits up
//     to timeout for the done channel to close. sync.Once-guarded for
//     idempotency.
//
// Goroutine-leak gate (FR-031): a clean Stop returns runtime.NumGoroutine
// to baseline within 100ms. AutoPollService's goroutine exits via the
// ctx.Done() select arm.
package pollservice

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// RefreshResult is the outcome of a ForceRefresh call.
type RefreshResult struct {
	Success bool
	Error   error
}

// FetchResult is what the callback returns. Defined locally so
// internal/pollservice doesn't import internal/configfetcher
// (keeping a clean dependency graph; the client mediates).
type FetchResult struct {
	OK    bool
	Error string
}

// FetchCallback is the fetch primitive bound to the client's
// ConfigFetcher. Idempotent in the sense that calling it twice in
// quick succession is safe (the fetcher's HTTP client handles
// connection pooling).
type FetchCallback func(ctx context.Context) FetchResult

// Mode is the polling-strategy discriminator. Concrete options
// (AutoPollOptions, LazyLoadOptions, ManualPollOptions) implement
// this interface.
type Mode interface {
	isPollingMode()
}

// AutoPollOptions configures AutoPollService.
type AutoPollOptions struct {
	PollInterval    time.Duration
	MaxInitWaitTime time.Duration
}

func (AutoPollOptions) isPollingMode() {}

// LazyLoadOptions configures LazyLoadService.
type LazyLoadOptions struct {
	CacheRefreshInterval time.Duration
}

func (LazyLoadOptions) isPollingMode() {}

// ManualPollOptions configures ManualPollService (empty struct).
type ManualPollOptions struct{}

func (ManualPollOptions) isPollingMode() {}

// PollService is the polymorphic interface. AutoPollService,
// LazyLoadService, and ManualPollService implement it.
type PollService interface {
	// Start records the callback + (for AutoPoll) spawns the
	// goroutine. Idempotent.
	Start(ctx context.Context, cb FetchCallback)

	// Stop cancels the goroutine's context and waits up to timeout
	// for clean shutdown. Idempotent (sync.Once).
	Stop(timeout time.Duration) error

	// ForceRefresh invokes the fetch callback synchronously.
	ForceRefresh(ctx context.Context) RefreshResult

	// MaybeFetchForGetValue is the LazyLoad on-demand hook. Other
	// modes return immediately.
	MaybeFetchForGetValue(ctx context.Context)
}

// Make returns the right service flavour for the given polling mode.
func Make(mode Mode) PollService {
	switch m := mode.(type) {
	case AutoPollOptions:
		return newAutoPollService(m)
	case LazyLoadOptions:
		return newLazyLoadService(m)
	case ManualPollOptions:
		return newManualPollService()
	default:
		// Defensive default — should be unreachable since Mode is
		// a sealed interface within this package. Treat as Manual.
		return newManualPollService()
	}
}

// ---- AutoPollService ----------------------------------------------------

type autoPollService struct {
	options AutoPollOptions

	startOnce sync.Once
	stopOnce  sync.Once
	mu        sync.RWMutex
	callback  FetchCallback

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func newAutoPollService(opts AutoPollOptions) *autoPollService {
	if opts.PollInterval <= 0 {
		opts.PollInterval = 60 * time.Second
	}
	if opts.MaxInitWaitTime < 0 {
		opts.MaxInitWaitTime = 0
	}
	return &autoPollService{
		options: opts,
		done:    make(chan struct{}),
	}
}

func (s *autoPollService) Start(parentCtx context.Context, cb FetchCallback) {
	s.startOnce.Do(func() {
		s.mu.Lock()
		s.callback = cb
		s.ctx, s.cancel = context.WithCancel(parentCtx)
		s.mu.Unlock()

		// Eager initial fetch — bounded by the MaxInitWaitTime
		// if positive, so a slow first fetch doesn't block NewClient
		// for longer than the customer asked.
		s.runInitialFetch()

		go s.loop()
	})
}

func (s *autoPollService) runInitialFetch() {
	if s.options.MaxInitWaitTime <= 0 {
		s.callCallback(s.ctx)
		return
	}
	initCtx, cancel := context.WithTimeout(s.ctx, s.options.MaxInitWaitTime)
	defer cancel()
	s.callCallback(initCtx)
}

func (s *autoPollService) callCallback(ctx context.Context) {
	s.mu.RLock()
	cb := s.callback
	s.mu.RUnlock()
	if cb == nil {
		return
	}
	defer func() {
		// Belt-and-braces: the callback is fail-closed already, but
		// if anything panics we don't want it killing the goroutine.
		_ = recover()
	}()
	_ = cb(ctx)
}

func (s *autoPollService) loop() {
	defer close(s.done)
	ticker := time.NewTicker(s.options.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.callCallback(s.ctx)
		}
	}
}

func (s *autoPollService) Stop(timeout time.Duration) error {
	var ctxNonNil bool
	s.stopOnce.Do(func() {
		s.mu.RLock()
		cancel := s.cancel
		s.mu.RUnlock()
		if cancel != nil {
			cancel()
			ctxNonNil = true
		}
	})
	if !ctxNonNil {
		// Never started, or Stop already ran.
		return nil
	}
	if timeout <= 0 {
		<-s.done
		return nil
	}
	select {
	case <-s.done:
		return nil
	case <-time.After(timeout):
		return context.DeadlineExceeded
	}
}

func (s *autoPollService) ForceRefresh(ctx context.Context) RefreshResult {
	s.mu.RLock()
	cb := s.callback
	s.mu.RUnlock()
	if cb == nil {
		return RefreshResult{Success: false, Error: errNotStarted}
	}
	r := cb(ctx)
	if !r.OK {
		return RefreshResult{Success: false}
	}
	return RefreshResult{Success: true}
}

func (s *autoPollService) MaybeFetchForGetValue(_ context.Context) {}

// ---- LazyLoadService ----------------------------------------------------

type lazyLoadService struct {
	options       LazyLoadOptions
	mu            sync.Mutex
	callback      FetchCallback
	lastFetchedAt atomic.Int64 // unix-nano
}

func newLazyLoadService(opts LazyLoadOptions) *lazyLoadService {
	if opts.CacheRefreshInterval <= 0 {
		opts.CacheRefreshInterval = 60 * time.Second
	}
	return &lazyLoadService{options: opts}
}

func (s *lazyLoadService) Start(_ context.Context, cb FetchCallback) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.callback = cb
}

func (s *lazyLoadService) Stop(_ time.Duration) error { return nil }

func (s *lazyLoadService) ForceRefresh(ctx context.Context) RefreshResult {
	s.mu.Lock()
	cb := s.callback
	s.mu.Unlock()
	if cb == nil {
		return RefreshResult{Success: false, Error: errNotStarted}
	}
	r := cb(ctx)
	if !r.OK {
		return RefreshResult{Success: false}
	}
	s.lastFetchedAt.Store(time.Now().UnixNano())
	return RefreshResult{Success: true}
}

func (s *lazyLoadService) MaybeFetchForGetValue(ctx context.Context) {
	s.mu.Lock()
	cb := s.callback
	s.mu.Unlock()
	if cb == nil {
		return
	}
	last := s.lastFetchedAt.Load()
	if last != 0 && time.Since(time.Unix(0, last)) < s.options.CacheRefreshInterval {
		return
	}
	r := cb(ctx)
	if r.OK {
		s.lastFetchedAt.Store(time.Now().UnixNano())
	}
}

// ---- ManualPollService --------------------------------------------------

type manualPollService struct {
	mu       sync.Mutex
	callback FetchCallback
}

func newManualPollService() *manualPollService {
	return &manualPollService{}
}

func (s *manualPollService) Start(_ context.Context, cb FetchCallback) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.callback = cb
}

func (s *manualPollService) Stop(_ time.Duration) error { return nil }

func (s *manualPollService) ForceRefresh(ctx context.Context) RefreshResult {
	s.mu.Lock()
	cb := s.callback
	s.mu.Unlock()
	if cb == nil {
		return RefreshResult{Success: false, Error: errNotStarted}
	}
	r := cb(ctx)
	if !r.OK {
		return RefreshResult{Success: false}
	}
	return RefreshResult{Success: true}
}

func (s *manualPollService) MaybeFetchForGetValue(_ context.Context) {}

// errNotStarted is the sentinel returned by ForceRefresh on services
// whose callback hasn't been registered yet.
var errNotStarted = &notStartedErr{}

type notStartedErr struct{}

func (*notStartedErr) Error() string { return "confeature: poll service not started" }
