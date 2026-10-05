// SPDX-License-Identifier: MIT

package confeature

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/cache"
	"github.com/confeature/sdks/apps/sdk-go/internal/configfetcher"
	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
	"github.com/confeature/sdks/apps/sdk-go/internal/overrideeval"
	"github.com/confeature/sdks/apps/sdk-go/internal/pollservice"
	"github.com/confeature/sdks/apps/sdk-go/internal/sdkkey"
)

// RefreshResult is returned by ForceRefresh / ForceRefreshWithContext.
// Success=true means the underlying fetch returned 200 or 304.
type RefreshResult struct {
	Success bool
	Error   error
}

// Client is the top-level entry point. Construct via NewClient.
//
// Concurrency: GetValue / GetValueWithContext / Snapshot / ForceRefresh
// are safe for concurrent use. Close is idempotent (sync.Once).
type Client struct {
	sdkKey        string
	cacheKey      string
	logger        Logger
	flagOverrides *FlagOverrides
	defaultUser   *User
	hooks         *Hooks

	fetcher *configfetcher.Fetcher
	cache   cache.Cache
	poll    pollservice.PollService

	// config holds the latest successfully-fetched parsed JSON. Stored
	// as *map[string]any inside an atomic.Pointer so reads are
	// lock-free in the GetValue hot path.
	config atomic.Pointer[map[string]any]
	etag   atomic.Pointer[string]

	// fetchTime is the wall-clock time at which the active config
	// was last successfully fetched (StatusFetched or
	// StatusNotModified) OR restored from cache (parsed from
	// Entry.FetchedAt). nil pointer until the first fetch lands;
	// read by Get<T>ValueDetails to populate
	// EvaluationDetailsData.FetchTime. See spec 075 §R3.
	fetchTime atomic.Pointer[time.Time]

	closeOnce sync.Once
	closed    atomic.Bool

	// Spec 101 / #267 — mirrors configcat-go-sdk's offline flag.
	offline atomic.Bool

	ctx    context.Context
	cancel context.CancelFunc
}

// NewClient constructs a Client. sdkKey is required; empty returns
// ErrInvalidSDKKey. All other configuration flows through Options.
//
// Validation:
//   - Empty sdkKey       → ErrInvalidSDKKey.
//   - Invalid key format → logged INVALID_SDK_KEY (redacted), continues.
//   - WithRequestTimeout ≤ 0 → wrapped ErrInvalidOption.
//   - FlagOverrides with nil DataSource → wrapped ErrInvalidOption.
//
// Side-effects:
//   - Derives the cache key (sdkkey.DeriveCacheKey).
//   - Constructs the cache (file or memory).
//   - Restores any existing cache entry into in-memory state.
//   - Starts the poll service. AutoPoll runs its first fetch eagerly
//     (bounded by MaxInitWaitTime).
//   - Installs a runtime.SetFinalizer to call Close as a safety net.
func NewClient(sdkKey string, options ...Option) (*Client, error) {
	if sdkKey == "" {
		return nil, ErrInvalidSDKKey
	}
	opts := defaultOptions()
	for _, opt := range options {
		opt(&opts)
	}
	if err := opts.validate(); err != nil {
		return nil, err
	}

	logger := opts.logger
	if logger == nil {
		logger = NewDefaultLogger()
	}

	if !sdkkey.IsValidConfeatureKeyFormat(sdkKey) {
		logger.Warning(
			"INVALID_SDK_KEY format; continuing — runtime is lenient",
			"sdkKey", sdkkey.RedactSdkKey(sdkKey),
		)
	}

	cacheKey := sdkkey.DeriveCacheKey(sdkKey)
	cacheImpl := cache.Make(opts.cacheDir, cacheKey, sdkKey, loggerCacheAdapter{logger})

	ctx, cancel := context.WithCancel(context.Background())

	fetcher := configfetcher.New(
		opts.baseURL,
		sdkKey,
		Version,
		opts.requestTimeout,
		loggerFetcherAdapter{logger},
	)
	poll := pollservice.Make(opts.pollMode)

	c := &Client{
		sdkKey:        sdkKey,
		cacheKey:      cacheKey,
		logger:        logger,
		flagOverrides: opts.flagOverrides,
		defaultUser:   opts.defaultUser,
		hooks:         opts.hooks,
		fetcher:       fetcher,
		cache:         cacheImpl,
		poll:          poll,
		ctx:           ctx,
		cancel:        cancel,
	}

	// Restore any persisted cache entry so the first GetValue can
	// resolve against on-disk state before the first fetch lands.
	if entry, ok := cacheImpl.Read(); ok {
		body := entry.Body
		c.config.Store(&body)
		etag := entry.ETag
		c.etag.Store(&etag)
		// Parse Entry.FetchedAt (float64 seconds with fractional) into
		// time.Time so the typed value-details path can report the
		// cache-restore time as the active config's fetch time.
		if entry.FetchedAt > 0 {
			ft := time.Unix(0, int64(entry.FetchedAt*float64(time.Second)))
			c.fetchTime.Store(&ft)
		}
	}

	// Skip starting the poll service when LocalOnly overrides are in
	// effect — the override-eval path handles every call, no fetch
	// needed (matches Python's offline-LocalOnly behaviour).
	if c.flagOverrides == nil || c.flagOverrides.Behaviour != LocalOnly {
		poll.Start(ctx, c.fetchAndApply)
	}

	// Safety-net finaliser. The customer SHOULD call Close explicitly;
	// the finaliser handles the case where they don't.
	runtime.SetFinalizer(c, func(c *Client) { _ = c.Close() })

	return c, nil
}

// fetchAndApply is the FetchCallback handed to the poll service. It
// runs the configured Fetcher, persists the new entry to the cache,
// and stores the new body + ETag in-memory.
func (c *Client) fetchAndApply(ctx context.Context) pollservice.FetchResult {
	if c.offline.Load() {
		// Spec 101 / #267 — no HTTP while offline. Covers AutoPoll
		// goroutine, LazyLoad on-demand fetch, ManualPoll force_refresh.
		return pollservice.FetchResult{OK: false, Error: "OFFLINE_MODE"}
	}
	// Read the prior ETag for conditional GET.
	var prevETag string
	if e := c.etag.Load(); e != nil {
		prevETag = *e
	}
	r := c.fetcher.Fetch(ctx, prevETag)
	switch r.Status {
	case configfetcher.StatusFetched:
		body := r.Body
		etag := r.ETag
		c.config.Store(&body)
		c.etag.Store(&etag)
		now := time.Now()
		c.fetchTime.Store(&now)
		c.cache.Write(&cache.Entry{
			Body:      body,
			ETag:      etag,
			FetchedAt: cache.NowSeconds(),
		})
		// OnConfigChanged fires on a successful NEW config.json fetch
		// (FETCHED path only — a 304 Not Modified below does NOT fire it).
		// Mirrors upstream config_fetcher.go's
		// `go f.hooks.OnConfigChanged()`.
		c.hooks.fireConfigChanged()
		return pollservice.FetchResult{OK: true}
	case configfetcher.StatusNotModified:
		if r.ETag != "" {
			etag := r.ETag
			c.etag.Store(&etag)
		}
		// The active config is still current as of "now"; matches
		// upstream's RefreshWithContext semantics where a 304 updates
		// the fetch time (spec 075 §R3).
		now := time.Now()
		c.fetchTime.Store(&now)
		return pollservice.FetchResult{OK: true}
	default:
		// OnError fires on a failed fetch — mirrors upstream, where the
		// fetch error path routes through logger.Errorf →
		// `go log.hooks.OnError(...)`. r.Error is the fetcher's
		// stringly-typed reason (never carries the raw SDK key).
		c.hooks.fireError(fmt.Errorf("confeature: config fetch failed: %s", r.Error))
		return pollservice.FetchResult{OK: false, Error: r.Error}
	}
}

// GetValue resolves key with the supplied default. Equivalent to
// GetValueWithContext(context.Background(), ...).
//
// The four-type evaluator (SettingType ∈ {boolean, string, int,
// double}; see internal/evaluator) resolves every defaultValue whose
// Go type matches the cached setting's type. Returns defaultValue +
// logs a WARNING when:
//   - The client is closed.
//   - The flag's setting type is unknown (not 0/1/2/3 — UNSUPPORTED_TYPE).
//   - The default's Go type does not match the cached setting's type
//     (TYPE_MISMATCH). The four supported defaults are bool / string /
//     int / float64.
//
// The return type is `any` — Confeature's untyped surface for v0.1.
//
// Deprecated: use GetBoolValue / GetStringValue / GetIntValue /
// GetFloatValue (or their *ValueDetails siblings) for type safety
// and a ConfigCat-Go-SDK-conforming surface. GetValue is kept for
// backward compatibility and existing callers; new code should
// prefer the typed accessors.
//
// Override resolution runs BEFORE the cache-driven eval (spec-036
// correctness — synchronous since day one for the Go SDK).
func (c *Client) GetValue(key string, defaultValue any, user *User) any {
	return c.GetValueWithContext(context.Background(), key, defaultValue, user)
}

// GetValueWithContext is the context-aware variant. ctx controls
// LazyLoad's on-demand fetch (if any) and any future async work.
// In the v1 evaluator's hot path the ctx is otherwise unused.
//
// See GetValue for the four-type resolution semantics (bool / string /
// int / float64) — this entry point shares the same Result envelope
// produced by the underlying evaluator.
//
// Deprecated: use GetBoolValueWithContext / GetStringValueWithContext
// / GetIntValueWithContext / GetFloatValueWithContext (or their
// *ValueDetails siblings) for type safety and a
// ConfigCat-Go-SDK-conforming surface. GetValueWithContext is kept
// for backward compatibility.
func (c *Client) GetValueWithContext(
	ctx context.Context,
	key string,
	defaultValue any,
	user *User,
) any {
	value, _ := c.evaluateWithContext(ctx, key, defaultValue, user)
	return value
}

// evaluateWithContext is the shared internal resolver used by GetValue,
// the typed getters, and the typed *ValueDetails accessors. It returns
// the resolved value plus the evaluator's diagnostic envelope:
//
//   - value is the cached typed value on the happy path, otherwise the
//     supplied defaultValue.
//   - errCode is the evaluator's string error code ("" on happy path,
//     "KEY_NOT_FOUND" / "TYPE_MISMATCH" / ... otherwise). Bridged to
//     a Go error via errorFromCode at the typed-details boundary.
//   - isDefault is true on every failure branch (and on a closed
//     client) — fed to EvaluationDetailsData.IsDefaultValue.
//   - variationID is currently always "" — v1 ships no variation IDs.
//   - errClosed is true when the client was closed and the call was
//     served defaults; bridged to ErrClientClosed.
func (c *Client) evaluateWithContext(
	ctx context.Context,
	key string,
	defaultValue any,
	user *User,
) (value any, info evalInfo) {
	if c.closed.Load() {
		c.logger.Warning(
			"GetValue called after Close",
			"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
			"key", key,
		)
		info.IsDefault = true
		info.ClientClosed = true
		return defaultValue, info
	}

	// OnFlagEvaluated fires for every evaluation that produces an
	// EvaluationDetails — mirrors upstream snapshot.go's
	// `go snap.hooks.OnFlagEvaluated(...)`. A deferred fire keeps the
	// single emission point correct across all the result-producing
	// return branches below (override full-config, override sync,
	// cache-driven). The closed-client guard above returns first and is
	// NOT an evaluation, so it does not fire. effectiveUser captures the
	// user actually used (post default-user fallback) for the details.
	var effectiveUser *User
	defer func() {
		if c.hooks == nil || c.hooks.OnFlagEvaluated == nil {
			return
		}
		c.hooks.fireFlagEvaluated(&EvaluationDetails{
			Value: value,
			Data:  c.buildDetailsData(key, effectiveUser, info),
		})
	}()
	effectiveUser = c.resolveUser(user)

	// Override path FIRST (spec-036 correctness inherited from day one).
	if c.flagOverrides != nil {
		// Full-config override source (spec 135 / #433): route the FULL
		// {p, f, s} config through the real evaluator so targeting rules /
		// segments / prerequisites / percentage options resolve offline. The
		// flat-map / custom source keeps the byte-identical EvaluateSync path.
		if src, isFull := fullConfigSource(c.flagOverrides); isFull {
			r := evaluator.EvaluateForUser(
				src.Config(), key, defaultValue, toEvalUser(c.resolveUser(user)),
			)
			info.ErrorCode = r.Error
			info.VariationID = r.VariationID
			info.IsDefault = r.Error != ""
			info.MatchedTargetingRule = r.MatchedTargetingRule
			info.MatchedPercentageOption = r.MatchedPercentageOption
			return r.Value, info
		}
		if v, ok := overrideeval.EvaluateSync(
			c.overrideInternal(),
			key,
			defaultValue,
		); ok {
			// Override-eval surfaces either the typed override candidate
			// (happy path — Branch 7) or the supplied default (Branches
			// 4-6: LocalOnly contract). For the typed *ValueDetails
			// path we need to distinguish the two and surface an
			// evaluator-equivalent error code on the default branches.
			info.ErrorCode = classifyOverrideOutcome(
				c.overrideInternal(), key, defaultValue, v,
			)
			info.IsDefault = info.ErrorCode != ""
			return v, info
		}
		// Non-LocalOnly behaviours: log the deferral and fall back to
		// default. Mirrors the Python deferral pattern.
		if c.flagOverrides.Behaviour != LocalOnly {
			c.logger.Warning(
				"override behaviour not implemented",
				"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
				"behaviour", c.flagOverrides.Behaviour.String(),
				"err", ErrOverrideBehaviourNotImplemented.Error(),
			)
		}
	}

	// LazyLoad: trigger an on-demand fetch if stale.
	c.poll.MaybeFetchForGetValue(ctx)

	// Cache-driven evaluation.
	var configMap map[string]any
	if p := c.config.Load(); p != nil {
		configMap = *p
	}
	user = c.resolveUser(user)
	r := evaluator.EvaluateForUser(configMap, key, defaultValue, toEvalUser(user))
	info.ErrorCode = r.Error
	info.VariationID = r.VariationID
	info.IsDefault = r.Error != ""
	info.MatchedTargetingRule = r.MatchedTargetingRule
	info.MatchedPercentageOption = r.MatchedPercentageOption
	return r.Value, info
}

// evalInfo is the internal diagnostic envelope produced by
// evaluateWithContext. Consumed by GetValue (drops it),
// Get<T>Value (drops it), and Get<T>ValueDetails (maps it onto
// EvaluationDetailsData).
type evalInfo struct {
	ErrorCode               string
	VariationID             string
	IsDefault               bool
	ClientClosed            bool
	MatchedTargetingRule    map[string]any
	MatchedPercentageOption map[string]any
}

// toEvalUser adapts the public *User to the evaluator's internal user shape. A
// nil *User threads through as nil ("no targeting context"). The public Custom
// map carries ConfigCat's typed UserAttributeValue family (string / number /
// bool / []string / time.Time, mirroring configcat/go-sdk v9) and threads into
// the evaluator unchanged — non-string values are converted to ConfigCat's
// canonical form inside the comparators (Principle II).
func toEvalUser(u *User) *evaluator.User {
	if u == nil {
		return nil
	}
	eu := &evaluator.User{
		Identifier: u.Identifier,
		Email:      u.Email,
		Country:    u.Country,
	}
	if len(u.Custom) > 0 {
		eu.Custom = make(map[string]any, len(u.Custom))
		for k, v := range u.Custom {
			eu.Custom[k] = v
		}
	}
	return eu
}

// classifyOverrideOutcome inspects the override-eval result to decide
// what evaluator-equivalent error code (if any) to surface on the typed
// *ValueDetails path. The override-eval 7-branch tree (research §R3)
// returns:
//
//   - Branch 4 (key absent in overrides) → defaultValue, ok=true.
//     We map this to KEY_NOT_FOUND.
//   - Branch 5 (all four override slots nil) → defaultValue, ok=true.
//     We map this to MALFORMED_VALUE (the override entry is malformed).
//   - Branch 6 (TYPE_MISMATCH between override slot and default) →
//     defaultValue, ok=true. We map this to TYPE_MISMATCH.
//   - Branch 7 (happy path) → typed candidate, ok=true. We return "".
//
// Note: override-eval returns the supplied default verbatim on 4-6,
// so distinguishing them after the fact requires re-inspecting the
// override map. The Confeature override-eval is internal so this
// trade is acceptable — the typed-details path is the one customer
// surface that needs the discriminator.
func classifyOverrideOutcome(
	fo *overrideeval.Overrides,
	key string,
	defaultValue, candidate any,
) string {
	// If override-eval was nil or non-LocalOnly we never reached
	// classify; ok was false in that case. Safety only.
	if fo == nil || fo.DataSource == nil {
		return ""
	}
	m := fo.DataSource.GetOverridesSync()
	if m == nil {
		return ""
	}
	raw, present := m[key]
	if !present {
		// Branch 4 — key absent in the overrides map.
		return "KEY_NOT_FOUND"
	}
	// Branch 5 — all four slots nil → malformed override entry.
	if raw.B == nil && raw.S == nil && raw.I == nil && raw.D == nil {
		return "MALFORMED_VALUE"
	}
	// If override-eval returned a value distinct from the supplied
	// default, this is Branch 7 — happy path.
	if !overrideValueEqualsDefault(candidate, defaultValue) {
		return ""
	}
	// At this point override-eval returned the default verbatim. The
	// only remaining branch from the LocalOnly contract is Branch 6
	// (TYPE_MISMATCH between override slot and default). Verify by
	// re-running the type comparison the override-eval helper uses.
	if defaultValue == nil {
		return ""
	}
	// Branch 6 — override slot type differs from default type.
	// Confirmed if the picked candidate type differs from the default.
	pickedType := overridePickedType(raw)
	defaultType := goTypeOf(defaultValue)
	if pickedType != "" && pickedType != defaultType {
		return "TYPE_MISMATCH"
	}
	// Defensive fallback: override returned default but no
	// discriminator branch matched. Surface as MALFORMED_VALUE — the
	// override entry produced an unusable candidate.
	return "MALFORMED_VALUE"
}

// overrideValueEqualsDefault checks identity for the four supported
// primitive types. Used by classifyOverrideOutcome to detect Branch 7
// (the override candidate happened to equal the supplied default).
func overrideValueEqualsDefault(a, b any) bool {
	switch av := a.(type) {
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case int:
		bv, ok := b.(int)
		return ok && av == bv
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	}
	return false
}

// overridePickedType returns the Go type name of the candidate the
// override-eval helper would pick from a SettingValue. Mirrors
// overrideeval.pickCandidate's slot order (B → S → I → D).
func overridePickedType(raw overrideeval.SettingValue) string {
	switch {
	case raw.B != nil:
		return "bool"
	case raw.S != nil:
		return "string"
	case raw.I != nil:
		return "int"
	case raw.D != nil:
		return "float64"
	}
	return ""
}

// goTypeOf returns a stable string for the four supported Go primitive
// types. Other types collapse to "" — the override-eval helper rejects
// them at construction time, so a "" here is genuinely unexpected.
func goTypeOf(v any) string {
	switch v.(type) {
	case bool:
		return "bool"
	case string:
		return "string"
	case int:
		return "int"
	case float64:
		return "float64"
	}
	return ""
}

// ── Typed getters (FR-001..FR-004) — ConfigCat-Go-SDK drop-in surface ─
//
// The four typed getters and their *WithContext siblings (D2 YES —
// additive Confeature divergence) mirror configcat-go-sdk v9's
// signature 1:1 EXCEPT for the *User pointer (FR-009). Each is a thin
// wrapper around evaluateWithContext; the typed return ensures the
// caller never sees an any value.

// GetBoolValue returns the value of a boolean-typed feature flag, or
// defaultValue if the key is missing, the cached value's type does
// not match, or the client is closed. Mirrors configcat-go-sdk v9's
// (*Client).GetBoolValue 1:1 (FR-009: user is *User, not interface{}).
func (c *Client) GetBoolValue(key string, defaultValue bool, user *User) bool {
	return c.GetBoolValueWithContext(context.Background(), key, defaultValue, user)
}

// GetBoolValueWithContext is the context-aware sibling of GetBoolValue.
// Confeature-only additive extension (upstream lacks *WithContext on
// the typed surface; D2 YES — documented as ADDITIVE DIVERGENCE in
// api_surface_conformance_test.go).
func (c *Client) GetBoolValueWithContext(
	ctx context.Context, key string, defaultValue bool, user *User,
) bool {
	v, _ := c.evaluateWithContext(ctx, key, defaultValue, user)
	if b, ok := v.(bool); ok {
		return b
	}
	return defaultValue
}

// GetStringValue returns the value of a string-typed feature flag, or
// defaultValue on any failure branch. Mirrors configcat-go-sdk v9's
// (*Client).GetStringValue 1:1 (FR-009).
func (c *Client) GetStringValue(key string, defaultValue string, user *User) string {
	return c.GetStringValueWithContext(context.Background(), key, defaultValue, user)
}

// GetStringValueWithContext is the context-aware sibling of
// GetStringValue (D2 YES — Confeature additive divergence).
func (c *Client) GetStringValueWithContext(
	ctx context.Context, key string, defaultValue string, user *User,
) string {
	v, _ := c.evaluateWithContext(ctx, key, defaultValue, user)
	if s, ok := v.(string); ok {
		return s
	}
	return defaultValue
}

// GetIntValue returns the value of an int-typed feature flag, or
// defaultValue on any failure branch. Mirrors configcat-go-sdk v9's
// (*Client).GetIntValue 1:1 (FR-009).
func (c *Client) GetIntValue(key string, defaultValue int, user *User) int {
	return c.GetIntValueWithContext(context.Background(), key, defaultValue, user)
}

// GetIntValueWithContext is the context-aware sibling of GetIntValue
// (D2 YES — Confeature additive divergence).
func (c *Client) GetIntValueWithContext(
	ctx context.Context, key string, defaultValue int, user *User,
) int {
	v, _ := c.evaluateWithContext(ctx, key, defaultValue, user)
	if i, ok := v.(int); ok {
		return i
	}
	return defaultValue
}

// GetFloatValue returns the value of a float64-typed feature flag, or
// defaultValue on any failure branch. Mirrors configcat-go-sdk v9's
// (*Client).GetFloatValue 1:1 (FR-009).
func (c *Client) GetFloatValue(key string, defaultValue float64, user *User) float64 {
	return c.GetFloatValueWithContext(context.Background(), key, defaultValue, user)
}

// GetFloatValueWithContext is the context-aware sibling of GetFloatValue
// (D2 YES — Confeature additive divergence).
func (c *Client) GetFloatValueWithContext(
	ctx context.Context, key string, defaultValue float64, user *User,
) float64 {
	v, _ := c.evaluateWithContext(ctx, key, defaultValue, user)
	if f, ok := v.(float64); ok {
		return f
	}
	return defaultValue
}

// ── Typed value-details accessors (FR-005, FR-006) ───────────────────
//
// Each accessor constructs a typed *EvaluationDetails struct wrapping
// the resolved value and an EvaluationDetailsData metadata block. The
// metadata block carries Key / VariationID / User / IsDefaultValue /
// Error / FetchTime / MatchedTargetingRule / MatchedPercentageOption.

// GetBoolValueDetails returns the value + evaluation metadata for a
// boolean-typed feature flag. Mirrors configcat-go-sdk v9's
// BoolEvaluationDetails return shape (FR-005, FR-006, FR-009).
func (c *Client) GetBoolValueDetails(
	key string, defaultValue bool, user *User,
) BoolEvaluationDetails {
	return c.GetBoolValueDetailsWithContext(
		context.Background(), key, defaultValue, user,
	)
}

// GetBoolValueDetailsWithContext is the context-aware sibling (D2 YES).
func (c *Client) GetBoolValueDetailsWithContext(
	ctx context.Context, key string, defaultValue bool, user *User,
) BoolEvaluationDetails {
	v, info := c.evaluateWithContext(ctx, key, defaultValue, user)
	value := defaultValue
	if b, ok := v.(bool); ok {
		value = b
	} else if !info.IsDefault && !info.ClientClosed && info.ErrorCode == "" {
		// Evaluator returned a non-bool happy-path value — unreachable
		// in the current 4-type evaluator, but defend against future
		// drift. Surface as TYPE_MISMATCH.
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return BoolEvaluationDetails{
		Value: value,
		Data:  c.buildDetailsData(key, user, info),
	}
}

// GetStringValueDetails returns the value + evaluation metadata for a
// string-typed feature flag.
func (c *Client) GetStringValueDetails(
	key string, defaultValue string, user *User,
) StringEvaluationDetails {
	return c.GetStringValueDetailsWithContext(
		context.Background(), key, defaultValue, user,
	)
}

// GetStringValueDetailsWithContext is the context-aware sibling (D2 YES).
func (c *Client) GetStringValueDetailsWithContext(
	ctx context.Context, key string, defaultValue string, user *User,
) StringEvaluationDetails {
	v, info := c.evaluateWithContext(ctx, key, defaultValue, user)
	value := defaultValue
	if s, ok := v.(string); ok {
		value = s
	} else if !info.IsDefault && !info.ClientClosed && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return StringEvaluationDetails{
		Value: value,
		Data:  c.buildDetailsData(key, user, info),
	}
}

// GetIntValueDetails returns the value + evaluation metadata for an
// int-typed feature flag.
func (c *Client) GetIntValueDetails(
	key string, defaultValue int, user *User,
) IntEvaluationDetails {
	return c.GetIntValueDetailsWithContext(
		context.Background(), key, defaultValue, user,
	)
}

// GetIntValueDetailsWithContext is the context-aware sibling (D2 YES).
func (c *Client) GetIntValueDetailsWithContext(
	ctx context.Context, key string, defaultValue int, user *User,
) IntEvaluationDetails {
	v, info := c.evaluateWithContext(ctx, key, defaultValue, user)
	value := defaultValue
	if i, ok := v.(int); ok {
		value = i
	} else if !info.IsDefault && !info.ClientClosed && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return IntEvaluationDetails{
		Value: value,
		Data:  c.buildDetailsData(key, user, info),
	}
}

// GetFloatValueDetails returns the value + evaluation metadata for a
// float64-typed feature flag.
func (c *Client) GetFloatValueDetails(
	key string, defaultValue float64, user *User,
) FloatEvaluationDetails {
	return c.GetFloatValueDetailsWithContext(
		context.Background(), key, defaultValue, user,
	)
}

// GetFloatValueDetailsWithContext is the context-aware sibling (D2 YES).
func (c *Client) GetFloatValueDetailsWithContext(
	ctx context.Context, key string, defaultValue float64, user *User,
) FloatEvaluationDetails {
	v, info := c.evaluateWithContext(ctx, key, defaultValue, user)
	value := defaultValue
	if f, ok := v.(float64); ok {
		value = f
	} else if !info.IsDefault && !info.ClientClosed && info.ErrorCode == "" {
		info.ErrorCode = "TYPE_MISMATCH"
		info.IsDefault = true
	}
	return FloatEvaluationDetails{
		Value: value,
		Data:  c.buildDetailsData(key, user, info),
	}
}

// buildDetailsData assembles EvaluationDetailsData from the shared
// evalInfo envelope. Reads c.fetchTime once per call. v1 leaves
// MatchedTargetingRule / MatchedPercentageOption nil (FR-007) and the
// VariationID empty (Confeature has no variation IDs in v1).
func (c *Client) buildDetailsData(
	key string, user *User, info evalInfo,
) EvaluationDetailsData {
	var fetchTime time.Time
	if p := c.fetchTime.Load(); p != nil {
		fetchTime = *p
	}
	var err error
	if info.ClientClosed {
		err = ErrClientClosed
	} else {
		err = errorFromCode(info.ErrorCode)
	}
	var matchedRule *TargetingRule
	if info.MatchedTargetingRule != nil {
		matchedRule = &TargetingRule{}
	}
	var matchedOption *PercentageOption
	if info.MatchedPercentageOption != nil {
		matchedOption = &PercentageOption{}
	}
	return EvaluationDetailsData{
		Key:                     key,
		VariationID:             info.VariationID,
		User:                    user,
		IsDefaultValue:          info.IsDefault,
		Error:                   err,
		FetchTime:               fetchTime,
		MatchedTargetingRule:    matchedRule,
		MatchedPercentageOption: matchedOption,
	}
}

// Snapshot returns an immutable view of the last-fetched config + a
// reference to the FlagOverrides bundle. The snapshot honours
// overrides synchronously (spec-036 correctness).
//
// fetchTime is captured at Snapshot() time and stays stable across
// later fetches (spec-036 immutability). Read by the typed
// value-details accessors on *Snapshot.
func (c *Client) Snapshot() *Snapshot {
	var configMap map[string]any
	if p := c.config.Load(); p != nil {
		configMap = *p
	}
	var fetchTime time.Time
	if p := c.fetchTime.Load(); p != nil {
		fetchTime = *p
	}
	return &Snapshot{
		config:        configMap,
		flagOverrides: c.flagOverrides,
		defaultUser:   c.defaultUser,
		fetchTime:     fetchTime,
	}
}

// ForceRefresh triggers an immediate fetch. Synchronous; returns when
// the fetch completes. Idempotent — multiple in-flight refreshes are
// serialised by the underlying http.Client + the poll service.
func (c *Client) ForceRefresh() RefreshResult {
	return c.ForceRefreshWithContext(context.Background())
}

// ForceRefreshWithContext is the context-aware variant.
func (c *Client) ForceRefreshWithContext(ctx context.Context) RefreshResult {
	if c.closed.Load() {
		return RefreshResult{Success: false, Error: ErrClientClosed}
	}
	if c.flagOverrides != nil && c.flagOverrides.Behaviour == LocalOnly {
		// LocalOnly never fetches; treat refresh as a no-op success.
		return RefreshResult{Success: true}
	}
	if c.offline.Load() {
		// Spec 101 / #267 — no HTTP while offline.
		return RefreshResult{Success: false, Error: ErrOffline}
	}
	r := c.poll.ForceRefresh(ctx)
	return RefreshResult{Success: r.Success, Error: r.Error}
}

// SetOnline re-enables HTTP polling. Idempotent.
//
// Mirrors configcat-go-sdk's Client.SetOnline (spec 101 / #267 slice 13/14). Closed clients
// log a warning + no-op. LocalOnly clients log a warning + no-op (LocalOnly never polls —
// the flag has no effect).
func (c *Client) SetOnline() {
	if c.closed.Load() {
		c.logger.Warning(fmt.Sprintf(
			"SetOnline called after Close (sdkKey=%s)",
			sdkkey.RedactSdkKey(c.sdkKey),
		))
		return
	}
	if c.flagOverrides != nil && c.flagOverrides.Behaviour == LocalOnly {
		c.logger.Warning(fmt.Sprintf(
			"Client is configured to use the LocalOnly override behaviour, thus SetOnline has "+
				"no effect (sdkKey=%s)",
			sdkkey.RedactSdkKey(c.sdkKey),
		))
		return
	}
	c.offline.Store(false)
}

// SetOffline suspends HTTP polling; serves the cached config. Idempotent.
//
// Mirrors configcat-go-sdk's Client.SetOffline (spec 101 / #267 slice 13/14). Closed clients
// log a warning + no-op. LocalOnly clients are a silent no-op (LocalOnly never polls).
func (c *Client) SetOffline() {
	if c.closed.Load() {
		c.logger.Warning(fmt.Sprintf(
			"SetOffline called after Close (sdkKey=%s)",
			sdkkey.RedactSdkKey(c.sdkKey),
		))
		return
	}
	if c.flagOverrides != nil && c.flagOverrides.Behaviour == LocalOnly {
		return
	}
	c.offline.Store(true)
}

// IsOffline returns true when HTTP polling is suspended.
//
// Mirrors configcat-go-sdk's Client.IsOffline (spec 101 / #267 slice 13/14). Closed clients
// return true. LocalOnly clients return true (LocalOnly never polls — always offline w.r.t.
// remote config).
func (c *Client) IsOffline() bool {
	if c.closed.Load() {
		return true
	}
	if c.flagOverrides != nil && c.flagOverrides.Behaviour == LocalOnly {
		return true
	}
	return c.offline.Load()
}

// Close cancels the poll goroutine's context, waits up to 5s for the
// goroutine to exit, and releases idle HTTP connections. Idempotent
// (sync.Once + atomic closed flag): the first call closes; subsequent
// calls return ErrClientClosed.
func (c *Client) Close() error {
	if c.closed.Swap(true) {
		return ErrClientClosed
	}
	var stopErr error
	c.closeOnce.Do(func() {
		// Cancel any context-bound work in-flight before stopping
		// the poll service so an in-progress fetch unwinds cleanly.
		if c.cancel != nil {
			c.cancel()
		}
		if c.poll != nil {
			if err := c.poll.Stop(5 * time.Second); err != nil {
				stopErr = err
				c.logger.Warning(
					"poll service stop returned an error",
					"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
					"err", err.Error(),
				)
			}
		}
		if c.fetcher != nil {
			c.fetcher.Close()
		}
		// Clear the finaliser so the safety-net doesn't fire again.
		runtime.SetFinalizer(c, nil)
	})
	return stopErr
}

// resolveUser falls back to the default User when the caller passes nil.
func (c *Client) resolveUser(u *User) *User {
	if u != nil {
		return u
	}
	return c.defaultUser
}

// overrideInternal converts the public FlagOverrides to the internal
// overrideeval.Overrides shape (which is decoupled from the public
// package to keep internal/overrideeval free of public-package
// imports).
func (c *Client) overrideInternal() *overrideeval.Overrides {
	if c.flagOverrides == nil {
		return nil
	}
	if c.flagOverrides.DataSource == nil {
		return nil
	}
	return &overrideeval.Overrides{
		DataSource: dataSourceAdapter{c.flagOverrides.DataSource},
		Behaviour:  overrideeval.Behaviour(c.flagOverrides.Behaviour),
	}
}

// dataSourceAdapter bridges the public OverrideDataSource to the
// internal overrideeval.Settings interface. The conversion of
// SettingValue pointers is shallow — we reuse the same underlying
// pointers since the map is read-only on the override-eval path.
type dataSourceAdapter struct {
	src OverrideDataSource
}

func (a dataSourceAdapter) GetOverridesSync() map[string]overrideeval.SettingValue {
	m := a.src.GetOverridesSync()
	if m == nil {
		return nil
	}
	out := make(map[string]overrideeval.SettingValue, len(m))
	for k, v := range m {
		out[k] = overrideeval.SettingValue{
			B: v.B,
			S: v.S,
			I: v.I,
			D: v.D,
		}
	}
	return out
}

// loggerCacheAdapter and loggerFetcherAdapter satisfy the internal
// minimal Logger interfaces declared by the internal/cache and
// internal/configfetcher packages.

type loggerCacheAdapter struct{ inner Logger }

func (l loggerCacheAdapter) Warning(msg string, args ...any) {
	l.inner.Warning(msg, args...)
}

type loggerFetcherAdapter struct{ inner Logger }

func (l loggerFetcherAdapter) Error(msg string, args ...any) {
	l.inner.Error(msg, args...)
}

func (l loggerFetcherAdapter) Warning(msg string, args ...any) {
	l.inner.Warning(msg, args...)
}
