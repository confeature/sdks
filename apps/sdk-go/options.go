// SPDX-License-Identifier: MIT

package confeature

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/pollservice"
)

// Option mutates the internal clientOptions struct accumulated by
// NewClient. Idiomatic functional-options pattern (research §R8).
type Option func(*clientOptions)

// clientOptions is the unexported bag NewClient consumes. Customers
// never see it; they configure via Option constructors below.
type clientOptions struct {
	pollMode       pollservice.Mode
	cacheDir       string
	requestTimeout time.Duration
	baseURL        string
	logger         Logger
	flagOverrides  *FlagOverrides
	defaultUser    *User
	hooks          *Hooks
}

func defaultOptions() clientOptions {
	return clientOptions{
		pollMode: pollservice.AutoPollOptions{
			PollInterval:    60 * time.Second,
			MaxInitWaitTime: 5 * time.Second,
		},
		cacheDir:       "",
		requestTimeout: 30 * time.Second,
		baseURL:        "",
		logger:         nil,
		flagOverrides:  nil,
		defaultUser:    nil,
		hooks:          nil,
	}
}

// WithAutoPoll selects the AutoPoll polling strategy. pollInterval is
// the cadence of background refreshes; maxInitWaitTime bounds the
// eager fetch performed during NewClient.
//
// Defaults when omitted: 60s + 5s — same as configcat-go-sdk v9.
// Negative or zero values fall back to the defaults.
func WithAutoPoll(pollInterval, maxInitWaitTime time.Duration) Option {
	return func(o *clientOptions) {
		o.pollMode = pollservice.AutoPollOptions{
			PollInterval:    pollInterval,
			MaxInitWaitTime: maxInitWaitTime,
		}
	}
}

// WithLazyLoad selects the LazyLoad polling strategy. The config is
// fetched on the first GetValue past the staleness threshold.
func WithLazyLoad(cacheRefreshInterval time.Duration) Option {
	return func(o *clientOptions) {
		o.pollMode = pollservice.LazyLoadOptions{
			CacheRefreshInterval: cacheRefreshInterval,
		}
	}
}

// WithManualPoll selects the ManualPoll polling strategy. The config
// is fetched only when ForceRefresh is called explicitly.
func WithManualPoll() Option {
	return func(o *clientOptions) {
		o.pollMode = pollservice.ManualPollOptions{}
	}
}

// WithCacheDir sets the filesystem cache directory.
//
// Special values:
//   - ""              → use the default (os.UserCacheDir() + /confeature).
//   - ":memory:"      → force memory-only mode; no filesystem writes.
//   - "<custom path>" → use the supplied directory.
func WithCacheDir(path string) Option {
	return func(o *clientOptions) {
		o.cacheDir = path
	}
}

// WithRequestTimeout sets the per-fetch HTTP timeout. Must be > 0.
// Values ≤ 0 cause NewClient to return ErrInvalidOption.
func WithRequestTimeout(d time.Duration) Option {
	return func(o *clientOptions) {
		o.requestTimeout = d
	}
}

// WithBaseURL overrides the CDN base URL. Empty falls back to
// the production default. Use this for self-hosted Confeature
// deployments.
func WithBaseURL(url string) Option {
	return func(o *clientOptions) {
		o.baseURL = url
	}
}

// WithLogger installs a custom Logger. nil reverts to the default
// slog-wrapping logger.
func WithLogger(l Logger) Option {
	return func(o *clientOptions) {
		o.logger = l
	}
}

// WithSlogLogger is a convenience that wraps a slog.Logger at the
// given level. Equivalent to WithLogger(NewSlogLogger(l, level)).
func WithSlogLogger(l *slog.Logger, level LogLevel) Option {
	return func(o *clientOptions) {
		if l == nil {
			o.logger = nil
			return
		}
		o.logger = NewSlogLogger(l, level)
	}
}

// WithFlagOverrides installs a FlagOverrides bundle. Only LocalOnly is
// wired in v1; LocalOverRemote / RemoteOverLocal accept at the type
// level but emit ErrOverrideBehaviourNotImplemented at eval time.
func WithFlagOverrides(fo FlagOverrides) Option {
	return func(o *clientOptions) {
		cpy := fo
		o.flagOverrides = &cpy
	}
}

// WithDefaultUser sets a default User consulted when GetValue's user
// argument is nil.
func WithDefaultUser(u *User) Option {
	return func(o *clientOptions) {
		o.defaultUser = u
	}
}

// WithHooks installs an event Hooks bundle (OnFlagEvaluated / OnError /
// OnConfigChanged). Mirrors configcat-go-sdk v9's Config.Hooks field —
// the functional-options analogue for Confeature's option-based
// constructor. nil reverts to no hooks. Each callback is nil-guarded at
// emission time, so a Hooks with only some fields set is valid.
func WithHooks(h *Hooks) Option {
	return func(o *clientOptions) {
		o.hooks = h
	}
}

// validate runs after all options are applied. Returns a wrapped
// ErrInvalidOption on the first failure.
func (o *clientOptions) validate() error {
	if o.requestTimeout <= 0 {
		return fmt.Errorf("%w: request timeout must be > 0; got %s",
			ErrInvalidOption, o.requestTimeout)
	}
	if o.flagOverrides != nil && o.flagOverrides.DataSource == nil {
		return fmt.Errorf("%w: flag overrides DataSource is nil", ErrInvalidOption)
	}
	return nil
}
