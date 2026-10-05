// SPDX-License-Identifier: MIT

// Package cache provides the filesystem + memory cache for the latest
// config_v6.json body + ETag.
//
// Default cache dir: os.UserCacheDir() + "/confeature". Customers
// override via WithCacheDir (FR-011). When the cache directory or file
// is not writable, the implementation emits a single WARNING-level
// log entry and falls back to a process-local memory cache without
// further filesystem attempts (FR-012).
//
// MemorySentinel (":memory:") forces memory-only mode at construction
// time — no filesystem writes are ever attempted (FR-013).
package cache

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/confeature/sdks/apps/sdk-go/internal/sdkkey"
)

// MemorySentinel is the cacheDir value that forces memory-only mode.
const MemorySentinel = ":memory:"

// Entry is one cache record. Mirrors the on-disk JSON shape.
type Entry struct {
	Body      map[string]any `json:"body"`
	ETag      string         `json:"etag"`
	FetchedAt float64        `json:"fetched_at"`
}

// Cache is the read/write interface implemented by both FileCache and
// MemoryCache.
type Cache interface {
	Read() (*Entry, bool)
	Write(*Entry)
}

// Logger is the minimal logging surface the cache needs.
type Logger interface {
	Warning(msg string, args ...any)
}

// MemoryCache is an in-process cache. Also the fallback target when
// the filesystem refuses writes.
type MemoryCache struct {
	mu    sync.RWMutex
	entry *Entry
}

// NewMemoryCache returns an empty MemoryCache.
func NewMemoryCache() *MemoryCache {
	return &MemoryCache{}
}

// Read returns the current entry, or (nil, false) when empty.
func (c *MemoryCache) Read() (*Entry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.entry == nil {
		return nil, false
	}
	// Return a copy so callers can't mutate the cached payload.
	cpy := *c.entry
	return &cpy, true
}

// Write stores the entry (copy semantics).
func (c *MemoryCache) Write(e *Entry) {
	if e == nil {
		return
	}
	cpy := *e
	c.mu.Lock()
	c.entry = &cpy
	c.mu.Unlock()
}

// FileCache persists Entry as JSON at "{dir}/confeature-{cacheKeyTail}.json".
//
// On the first OSError during write, the instance flips into memory-
// only mode and emits a single WARNING log entry. Subsequent reads
// and writes use the in-memory entry — the filesystem is never
// retried for this client (matches Python's FR-012 behaviour).
type FileCache struct {
	logger   Logger
	sdkKey   string
	dir      string
	filePath string
	mem      *MemoryCache
	mu       sync.Mutex
	fallback bool
}

// NewFileCache constructs a FileCache. Logger may be nil for tests
// (the constructor swaps in a no-op logger in that case).
func NewFileCache(dir, cacheKey, sdkKey string, logger Logger) *FileCache {
	if logger == nil {
		logger = noopLogger{}
	}
	// Strip the envelope prefix for the filename: only the 32-char
	// tail goes on disk, mirroring sdk-node + sdk-python.
	tail := cacheKey
	if idx := strings.LastIndex(cacheKey, ":"); idx >= 0 && idx < len(cacheKey)-1 {
		tail = cacheKey[idx+1:]
	}
	return &FileCache{
		logger:   logger,
		sdkKey:   sdkKey,
		dir:      dir,
		filePath: filepath.Join(dir, "confeature-"+tail+".json"),
		mem:      NewMemoryCache(),
	}
}

// FilePath returns the on-disk path the cache writes to. Useful for
// tests that need to inspect or remove the file.
func (c *FileCache) FilePath() string {
	return c.filePath
}

// Read returns the latest entry. Falls through to the in-memory mirror
// on OSError or when the file is missing.
func (c *FileCache) Read() (*Entry, bool) {
	c.mu.Lock()
	fallback := c.fallback
	c.mu.Unlock()
	if fallback {
		return c.mem.Read()
	}
	raw, err := os.ReadFile(c.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return c.mem.Read()
		}
		c.logger.Warning(
			"FileCache.Read: failed to load file",
			"path", c.filePath,
			"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
			"reason", err.Error(),
		)
		return c.mem.Read()
	}
	var entry Entry
	if err := json.Unmarshal(raw, &entry); err != nil {
		c.logger.Warning(
			"FileCache.Read: malformed cache file",
			"path", c.filePath,
			"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
			"reason", err.Error(),
		)
		return nil, false
	}
	return &entry, true
}

// Write persists the entry. Always mirrors to memory first so a
// subsequent Read after a failed disk write still returns the entry.
func (c *FileCache) Write(e *Entry) {
	if e == nil {
		return
	}
	c.mem.Write(e)

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fallback {
		return
	}

	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		c.triggerFallback(err)
		return
	}
	payload, err := json.Marshal(e)
	if err != nil {
		c.triggerFallback(err)
		return
	}
	tmp := c.filePath + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		c.triggerFallback(err)
		return
	}
	if err := os.Rename(tmp, c.filePath); err != nil {
		c.triggerFallback(err)
		return
	}
}

func (c *FileCache) triggerFallback(err error) {
	c.fallback = true
	c.logger.Warning(
		"FileCache.Write: filesystem unwritable; falling back to memory-only cache",
		"path", c.filePath,
		"sdkKey", sdkkey.RedactSdkKey(c.sdkKey),
		"reason", err.Error(),
	)
}

// noopLogger is used when the caller passes nil.
type noopLogger struct{}

func (noopLogger) Warning(string, ...any) {}

// Make constructs the right cache flavour for the given cacheDir
// argument:
//   - cacheDir == MemorySentinel (":memory:") → MemoryCache.
//   - cacheDir == ""                          → FileCache rooted at
//     os.UserCacheDir() + "/confeature" (memory-fallback if probing
//     UserCacheDir returns an error).
//   - cacheDir == "<path>"                    → FileCache rooted at <path>.
func Make(cacheDir, cacheKey, sdkKey string, logger Logger) Cache {
	if cacheDir == MemorySentinel {
		return NewMemoryCache()
	}
	if cacheDir == "" {
		userCache, err := os.UserCacheDir()
		if err != nil {
			if logger != nil {
				logger.Warning(
					"cache.Make: os.UserCacheDir() failed; using memory-only cache",
					"sdkKey", sdkkey.RedactSdkKey(sdkKey),
					"reason", err.Error(),
				)
			}
			return NewMemoryCache()
		}
		cacheDir = filepath.Join(userCache, "confeature")
	}
	return NewFileCache(cacheDir, cacheKey, sdkKey, logger)
}

// NowSeconds returns the current Unix time as float seconds. Used for
// Entry.FetchedAt — matches the Python on-disk shape.
func NowSeconds() float64 {
	return float64(time.Now().UnixNano()) / float64(time.Second)
}

// Compile-time assertions: both impls satisfy Cache.
var (
	_ Cache = (*MemoryCache)(nil)
	_ Cache = (*FileCache)(nil)
)

// Sanity: the package has no exported Errorf path that would interpolate
// the SDK key without redaction. Future contributors: keep it that way.
var _ = fmt.Sprintf
