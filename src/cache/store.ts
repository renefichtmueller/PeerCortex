/**
 * @module cache/store
 * SQLite-backed cache for API responses.
 *
 * Caches responses from PeeringDB, RIPE Stat, and other sources
 * to reduce API calls, improve response times, and enable offline use.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */

import Database from "better-sqlite3";
import type { DataSourceName, CacheEntry } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface CacheConfig {
  readonly dbPath?: string;
  readonly defaultTTLSeconds?: number;
}

// ── Cache Store ──────────────────────────────────────────

/**
 * SQLite-backed cache store.
 *
 * Provides get/set/invalidate operations with TTL-based expiration.
 * Each cached entry is tagged with its data source for selective invalidation.
 *
 * @example
 * ```typescript
 * const cache = createCacheStore({ dbPath: "./peercortex-cache.db" });
 * await cache.set("peeringdb:net:13335", networkData, "peeringdb", 3600);
 * const cached = await cache.get("peeringdb:net:13335");
 * ```
 */
export interface CacheStore {
  /** Get a cached value by key. Returns null if not found or expired. */
  get<T>(key: string): CacheEntry<T> | null;

  /** Set a cached value with optional TTL override. */
  set<T>(
    key: string,
    data: T,
    source: DataSourceName,
    ttlSeconds?: number
  ): void;

  /** Invalidate a specific cache entry. */
  invalidate(key: string): void;

  /** Invalidate all entries from a specific data source. */
  invalidateSource(source: DataSourceName): void;

  /** Invalidate all expired entries. */
  cleanup(): number;

  /** Get cache statistics. */
  stats(): CacheStats;

  /** Clear the entire cache. */
  clear(): void;

  /** Close the database connection. */
  close(): void;
}

/** Cache usage statistics */
export interface CacheStats {
  readonly totalEntries: number;
  readonly expiredEntries: number;
  readonly sizeBytes: number;
  readonly bySource: Record<string, number>;
}

/**
 * Create a new SQLite-backed cache store.
 *
 * @param config - Cache configuration
 * @returns A configured cache store instance
 */
export function createCacheStore(config: CacheConfig = {}): CacheStore {
  const dbPath = config.dbPath ?? "./peercortex-cache.db";
  const defaultTTLSeconds = config.defaultTTLSeconds ?? 3600;

  let db: Database.Database;

  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  } catch (error) {
    throw new PeerCortexError(
      `Failed to open cache database: ${error instanceof Error ? error.message : "Unknown error"}`,
      "CACHE_ERROR",
      undefined,
      error instanceof Error ? error : undefined
    );
  }

  // Create the cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      source TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_source ON cache(source);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
  `);

  // Prepare statements for performance
  const getStmt = db.prepare(
    "SELECT key, data, source, cached_at, expires_at FROM cache WHERE key = ? AND expires_at > ?"
  );
  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO cache (key, data, source, cached_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  );
  const deleteStmt = db.prepare("DELETE FROM cache WHERE key = ?");
  const deleteSourceStmt = db.prepare("DELETE FROM cache WHERE source = ?");
  const cleanupStmt = db.prepare("DELETE FROM cache WHERE expires_at <= ?");
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM cache");
  const expiredCountStmt = db.prepare(
    "SELECT COUNT(*) as count FROM cache WHERE expires_at <= ?"
  );
  const sourceCountStmt = db.prepare(
    "SELECT source, COUNT(*) as count FROM cache GROUP BY source"
  );

  return {
    get<T>(key: string): CacheEntry<T> | null {
      const now = new Date().toISOString();
      const row = getStmt.get(key, now) as
        | {
            key: string;
            data: string;
            source: string;
            cached_at: string;
            expires_at: string;
          }
        | undefined;

      if (!row) return null;

      try {
        return {
          key: row.key,
          data: JSON.parse(row.data) as T,
          source: row.source as DataSourceName,
          cachedAt: row.cached_at,
          expiresAt: row.expires_at,
        };
      } catch {
        // Corrupted cache entry — delete it
        deleteStmt.run(key);
        return null;
      }
    },

    set<T>(
      key: string,
      data: T,
      source: DataSourceName,
      ttlSeconds?: number
    ): void {
      const now = new Date();
      const ttl = ttlSeconds ?? defaultTTLSeconds;
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      setStmt.run(
        key,
        JSON.stringify(data),
        source,
        now.toISOString(),
        expiresAt.toISOString()
      );
    },

    invalidate(key: string): void {
      deleteStmt.run(key);
    },

    invalidateSource(source: DataSourceName): void {
      deleteSourceStmt.run(source);
    },

    cleanup(): number {
      const now = new Date().toISOString();
      const result = cleanupStmt.run(now);
      return result.changes;
    },

    stats(): CacheStats {
      const now = new Date().toISOString();
      const total = (countStmt.get() as { count: number }).count;
      const expired = (expiredCountStmt.get(now) as { count: number }).count;
      const sources = sourceCountStmt.all() as ReadonlyArray<{
        source: string;
        count: number;
      }>;

      const bySource: Record<string, number> = {};
      for (const row of sources) {
        bySource[row.source] = row.count;
      }

      // Get database file size
      let sizeBytes = 0;
      try {
        const sizeResult = db
          .prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
          .get() as { size: number } | undefined;
        sizeBytes = sizeResult?.size ?? 0;
      } catch {
        // Ignore size calculation errors
      }

      return {
        totalEntries: total,
        expiredEntries: expired,
        sizeBytes,
        bySource,
      };
    },

    clear(): void {
      db.exec("DELETE FROM cache");
    },

    close(): void {
      db.close();
    },
  };
}
