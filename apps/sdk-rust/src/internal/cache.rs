// SPDX-License-Identifier: MIT

//! Filesystem + memory cache for the latest `config_v6.json` body + ETag.
//!
//! Default cache dir: `directories::ProjectDirs::from("io", "confeature", "confeature")
//! .cache_dir()`. Customers override via [`crate::ClientBuilder::cache_directory`].
//!
//! On the first IO error during write, the implementation flips into
//! memory-only mode and emits a single WARNING line. Subsequent reads
//! and writes use the in-memory mirror — the filesystem is never
//! retried for this client (matches the Python / Go behaviour).

use crate::internal::sdk_key::{cache_key_tail, redact_sdk_key};
use crate::logger::Logger;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Sentinel cache directory string forcing memory-only mode.
pub(crate) const MEMORY_SENTINEL: &str = ":memory:";

/// One cache record. Mirrors the on-disk JSON shape across SDKs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CacheEntry {
    pub body: Value,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub fetched_at: f64,
}

impl CacheEntry {
    /// Returns the current epoch seconds as a `f64` — matches the
    /// Python / Go cache file `fetched_at` slot.
    pub(crate) fn now_seconds() -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    }
}

/// Cache interface. Implementations are `Send + Sync` so the same
/// instance can be shared between the AutoPoll task and the
/// foreground `get_value` path.
pub(crate) trait Cache: Send + Sync {
    fn read(&self) -> Option<CacheEntry>;
    fn write(&self, entry: &CacheEntry);
}

/// In-process cache. Also the fallback target when the filesystem
/// refuses writes.
pub(crate) struct InMemoryCache {
    slot: RwLock<Option<CacheEntry>>,
}

impl InMemoryCache {
    pub(crate) fn new() -> Self {
        Self {
            slot: RwLock::new(None),
        }
    }
}

impl Default for InMemoryCache {
    fn default() -> Self {
        Self::new()
    }
}

impl Cache for InMemoryCache {
    fn read(&self) -> Option<CacheEntry> {
        self.slot.read().ok().and_then(|g| g.clone())
    }
    fn write(&self, entry: &CacheEntry) {
        if let Ok(mut g) = self.slot.write() {
            *g = Some(entry.clone());
        }
    }
}

/// Filesystem cache. Persists `CacheEntry` as JSON at
/// `{dir}/confeature-{cacheKeyTail}.json`. Writes go via a temp file
/// plus atomic rename ([`tempfile::NamedTempFile::persist`]); on the
/// first IO error the cache flips into memory-only mode for the
/// remainder of the client's lifetime.
pub(crate) struct FilesystemCache {
    sdk_key: String,
    dir: PathBuf,
    file_path: PathBuf,
    memory: InMemoryCache,
    fallback: RwLock<bool>,
    logger: Arc<dyn Logger>,
}

impl FilesystemCache {
    pub(crate) fn new(
        dir: PathBuf,
        cache_key: &str,
        sdk_key: String,
        logger: Arc<dyn Logger>,
    ) -> Self {
        let tail = cache_key_tail(cache_key);
        let file_path = dir.join(format!("confeature-{tail}.json"));
        Self {
            sdk_key,
            dir,
            file_path,
            memory: InMemoryCache::new(),
            fallback: RwLock::new(false),
            logger,
        }
    }

    /// Returns the on-disk path the cache writes to. Used by tests
    /// that need to inspect or remove the file.
    #[allow(dead_code)]
    pub(crate) fn file_path(&self) -> &PathBuf {
        &self.file_path
    }

    fn in_fallback(&self) -> bool {
        self.fallback.read().map(|g| *g).unwrap_or(true)
    }

    fn trigger_fallback(&self, reason: &str) {
        if let Ok(mut g) = self.fallback.write() {
            *g = true;
        }
        self.logger.warning(&format!(
            "FilesystemCache: filesystem unwritable; falling back to memory-only cache \
             (path={}, sdkKey={}, reason={})",
            self.file_path.display(),
            redact_sdk_key(&self.sdk_key),
            reason,
        ));
    }
}

impl Cache for FilesystemCache {
    fn read(&self) -> Option<CacheEntry> {
        if self.in_fallback() {
            return self.memory.read();
        }
        match std::fs::read(&self.file_path) {
            Ok(raw) => match serde_json::from_slice::<CacheEntry>(&raw) {
                Ok(entry) => Some(entry),
                Err(err) => {
                    self.logger.warning(&format!(
                        "FilesystemCache.read: malformed cache file (path={}, sdkKey={}, reason={err})",
                        self.file_path.display(),
                        redact_sdk_key(&self.sdk_key)
                    ));
                    None
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => self.memory.read(),
            Err(err) => {
                self.logger.warning(&format!(
                    "FilesystemCache.read: failed to load file (path={}, sdkKey={}, reason={err})",
                    self.file_path.display(),
                    redact_sdk_key(&self.sdk_key)
                ));
                self.memory.read()
            }
        }
    }

    fn write(&self, entry: &CacheEntry) {
        // Mirror to memory first so a subsequent read after a failed
        // disk write still returns the entry.
        self.memory.write(entry);
        if self.in_fallback() {
            return;
        }
        if let Err(err) = std::fs::create_dir_all(&self.dir) {
            self.trigger_fallback(&err.to_string());
            return;
        }
        let payload = match serde_json::to_vec(entry) {
            Ok(p) => p,
            Err(err) => {
                self.trigger_fallback(&err.to_string());
                return;
            }
        };
        let tmp = match tempfile::NamedTempFile::new_in(&self.dir) {
            Ok(t) => t,
            Err(err) => {
                self.trigger_fallback(&err.to_string());
                return;
            }
        };
        if let Err(err) = std::fs::write(tmp.path(), &payload) {
            self.trigger_fallback(&err.to_string());
            return;
        }
        if let Err(err) = tmp.persist(&self.file_path) {
            self.trigger_fallback(&err.error.to_string());
        }
    }
}

/// Returns the default cache directory: `ProjectDirs::cache_dir()`
/// for the publisher / app pair, fall back to the system temp dir
/// if `ProjectDirs` fails to resolve (rare; only on truly broken
/// platforms).
pub(crate) fn default_cache_dir() -> PathBuf {
    ProjectDirs::from("io", "confeature", "confeature")
        .map(|p| p.cache_dir().to_path_buf())
        .unwrap_or_else(std::env::temp_dir)
}

/// Constructs the right cache flavour for the given `cache_dir`
/// argument:
/// - `Some(":memory:")` → [`InMemoryCache`].
/// - `Some(path)`       → [`FilesystemCache`] rooted at `path`.
/// - `None`             → [`FilesystemCache`] rooted at
///   [`default_cache_dir`].
pub(crate) fn make_cache(
    cache_dir: Option<PathBuf>,
    cache_key: &str,
    sdk_key: String,
    logger: Arc<dyn Logger>,
) -> Box<dyn Cache> {
    if let Some(p) = cache_dir.as_ref() {
        if p == std::path::Path::new(MEMORY_SENTINEL) {
            return Box::new(InMemoryCache::new());
        }
    }
    let dir = cache_dir.unwrap_or_else(default_cache_dir);
    Box::new(FilesystemCache::new(dir, cache_key, sdk_key, logger))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::LogFacadeLogger;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn in_memory_round_trip() {
        let c = InMemoryCache::new();
        assert!(c.read().is_none());
        let entry = CacheEntry {
            body: json!({"f": {}}),
            etag: "E".into(),
            fetched_at: 1.0,
        };
        c.write(&entry);
        let got = c.read().expect("entry");
        assert_eq!(got.etag, "E");
    }

    #[test]
    fn filesystem_round_trip() {
        let dir = TempDir::new().expect("tempdir");
        let cache_key = "confeature:cache:v1:abcdefghijklmnopqrstuvwxyz012345";
        let logger: Arc<dyn Logger> = Arc::new(LogFacadeLogger::default());
        let cache = FilesystemCache::new(
            dir.path().to_path_buf(),
            cache_key,
            "sdk-key".to_string(),
            logger,
        );
        let entry = CacheEntry {
            body: json!({"f": {}}),
            etag: "E".into(),
            fetched_at: 42.0,
        };
        cache.write(&entry);
        let got = cache.read().expect("entry");
        assert_eq!(got.etag, "E");
        // File name uses the 32-char tail.
        assert!(cache
            .file_path()
            .to_string_lossy()
            .ends_with("confeature-abcdefghijklmnopqrstuvwxyz012345.json"));
    }

    #[test]
    fn make_cache_memory_sentinel() {
        let logger: Arc<dyn Logger> = Arc::new(LogFacadeLogger::default());
        let c = make_cache(
            Some(PathBuf::from(MEMORY_SENTINEL)),
            "confeature:cache:v1:tail",
            "sdk-key".into(),
            logger,
        );
        assert!(c.read().is_none());
        c.write(&CacheEntry {
            body: json!({}),
            etag: "".into(),
            fetched_at: 0.0,
        });
        assert!(c.read().is_some());
    }
}
