/**
 * Memory Index Manager
 *
 * SQLite-based cache layer for memory retrieval. Agent never touches this directly.
 * Markdown files are the single source of truth; SQLite can be rebuilt at any time.
 *
 * Cache invalidation: mtime + sha256 hash, checked lazily before each search call.
 *
 * Dependencies: better-sqlite3 is a regular project dependency (package.json),
 * loaded via createRequire. If unavailable, all operations degrade gracefully (no-op).
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemorySource = "MEMORY" | "knowledge" | "daily" | "experience";

export interface FileChunk {
  path: string;
  chunkId: number;
  content: string;
  startLine: number;
  endLine: number;
}

export interface SearchResult {
  path: string;
  lineRange: [number, number];
  snippet: string;
  score: number;
  source: MemorySource;
  links?: string[];
  backlinks?: string[];
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE_LINES = 40;
const CHUNK_OVERLAP_LINES = 5;

// ─── SQLite loader (graceful degrade if package unavailable) ─────────────────

// Minimal type stubs for better-sqlite3 to avoid requiring @types/better-sqlite3
interface BetterSqliteDatabase {
  pragma(src: string): unknown;
  exec(src: string): void;
  prepare(sql: string): BetterSqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}
interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
type DatabaseConstructor = new (path: string) => BetterSqliteDatabase;
type Database = BetterSqliteDatabase;

let _sqliteAvailable: boolean | null = null;
let BetterSqlite3: DatabaseConstructor | null = null;

/**
 * Load better-sqlite3 via standard Node module resolution.
 * Instance init prepends team/shared/lib/node_modules to NODE_PATH before
 * any tools are loaded, so createRequire(import.meta.url) finds the package without
 * any manual path computation.
 */
function tryLoadSqlite(): DatabaseConstructor | null {
  if (_sqliteAvailable !== null) return BetterSqlite3;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("better-sqlite3") as { default?: DatabaseConstructor } | DatabaseConstructor;
    BetterSqlite3 = (typeof mod === "function" ? mod : (mod as { default?: DatabaseConstructor }).default ?? mod) as DatabaseConstructor;
    _sqliteAvailable = true;
  } catch {
    _sqliteAvailable = false;
    BetterSqlite3 = null;
  }
  return BetterSqlite3;
}

// ─── MemoryIndexManager ───────────────────────────────────────────────────────

export class MemoryIndexManager {
  private homeDir: string;
  private dbPath: string;
  private db: Database | null = null;
  embeddingProvider: EmbeddingProvider | null = null;

  constructor(homeDir: string, embeddingProvider?: EmbeddingProvider) {
    this.homeDir = homeDir;
    this.dbPath = join(homeDir, ".memory", "index.sqlite");
    this.embeddingProvider = embeddingProvider ?? null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ensure index is initialized and up-to-date.
   * Performs lazy mtime+hash validation across all memory markdown files.
   */
  async ensureIndex(): Promise<void> {
    const Sqlite = tryLoadSqlite();
    if (!Sqlite) return;

    await this.openDb(Sqlite);
    if (!this.db) return;

    const allFiles = await this.collectMemoryFiles();
    await this.validateAndRebuildStale(allFiles);
    await this.backfillMissingEmbeddings(allFiles);
  }

  /**
   * Full-text search using FTS5 BM25 (trigram tokenizer).
   * For queries shorter than 3 characters, falls back to a linear scan with
   * JS string includes(), since trigram requires a minimum of 3 chars.
   */
  async searchFts(
    query: string,
    sources: MemorySource[],
    maxResults: number,
    temporalDecay: boolean,
  ): Promise<SearchResult[]> {
    if (!this.db) return [];

    const sourcePlaceholders = sources.map(() => "?").join(", ");
    const queryTrimmed = query.trim();

    let rows: Array<{ path: string; chunk_id: number; content: string; start_line: number; end_line: number; source: MemorySource; rank: number }>;

    // trigram requires >= 3 chars; for shorter queries do a linear contains scan
    if ([...queryTrimmed].length < 3) {
      try {
        const allRows = this.db
          .prepare(
            `SELECT f.path, f.chunk_id, f.content, f.start_line, f.end_line, m.source, 0 as rank
             FROM chunks_fts f
             JOIN files_meta m ON f.path = m.path
             WHERE m.source IN (${sourcePlaceholders})`,
          )
          .all(...sources) as typeof rows;
        rows = allRows.filter((r) => r.content.includes(queryTrimmed));
      } catch {
        return [];
      }
    } else {
      const ftsQuery = this.escapeFtsQuery(queryTrimmed);
      try {
        rows = this.db
          .prepare(
            `SELECT f.path, f.chunk_id, f.content, f.start_line, f.end_line, m.source, rank
             FROM chunks_fts f
             JOIN files_meta m ON f.path = m.path
             WHERE chunks_fts MATCH ? AND m.source IN (${sourcePlaceholders})
             ORDER BY rank
             LIMIT ?`,
          )
          .all(ftsQuery, ...sources, maxResults * 3) as typeof rows;
      } catch {
        return [];
      }
    }

    let results: SearchResult[] = rows.map((r) => ({
      path: r.path,
      lineRange: [r.start_line, r.end_line] as [number, number],
      snippet: r.content.slice(0, 700),
      score: Math.abs(r.rank),
      source: r.source,
    }));

    if (temporalDecay) {
      results = this.applyTemporalDecay(results);
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Semantic search using embedding similarity (cosine).
   * Falls back to empty array if no embedding provider.
   */
  async searchSemantic(
    query: string,
    sources: MemorySource[],
    maxResults: number,
  ): Promise<SearchResult[]> {
    if (!this.db || !this.embeddingProvider) return [];

    let queryVec: number[];
    try {
      const vecs = await this.embeddingProvider.embed([query]);
      queryVec = vecs[0];
    } catch {
      return [];
    }

    const sourcePlaceholders = sources.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT cv.path, cv.chunk_id, cv.embedding, m.source
         FROM chunks_vec cv
         JOIN files_meta m ON cv.path = m.path
         WHERE m.source IN (${sourcePlaceholders})`,
      )
      .all(...sources) as Array<{ path: string; chunk_id: number; embedding: Buffer; source: MemorySource }>;

    const scored: Array<{ path: string; chunkId: number; score: number; source: MemorySource }> = [];
    for (const row of rows) {
      const vec = bufferToFloat32Array(row.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      scored.push({ path: row.path, chunkId: row.chunk_id, score: sim, source: row.source });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxResults);

    const results: SearchResult[] = [];
    for (const item of top) {
      const chunk = this.db
        .prepare(`SELECT content, start_line, end_line FROM chunks_vec_content WHERE path = ? AND chunk_id = ?`)
        .get(item.path, item.chunkId) as { content: string; start_line: number; end_line: number } | undefined;
      if (!chunk) continue;
      results.push({
        path: item.path,
        lineRange: [chunk.start_line, chunk.end_line],
        snippet: chunk.content.slice(0, 700),
        score: item.score,
        source: item.source,
      });
    }
    return results;
  }

  /**
   * Merge FTS and semantic results using Reciprocal Rank Fusion (RRF).
   */
  mergeResults(
    ftsResults: SearchResult[],
    semanticResults: SearchResult[],
    maxResults: number,
    weights = { fts: 0.6, semantic: 0.4 },
  ): SearchResult[] {
    const k = 60;
    const scoreMap = new Map<string, { result: SearchResult; score: number }>();

    const addResults = (results: SearchResult[], weight: number) => {
      results.forEach((r, idx) => {
        const key = `${r.path}:${r.lineRange[0]}`;
        const rrfScore = weight * (1 / (k + idx + 1));
        const existing = scoreMap.get(key);
        if (existing) {
          existing.score += rrfScore;
        } else {
          scoreMap.set(key, { result: r, score: rrfScore });
        }
      });
    };

    addResults(ftsResults, weights.fts);
    addResults(semanticResults, weights.semantic);

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => ({ ...item.result, score: item.score }));
  }

  /**
   * Return the most recently modified memory files (one entry per file),
   * ordered by mtime descending. Used when query is omitted to browse recent memories.
   */
  getRecent(sources: MemorySource[], maxResults: number): SearchResult[] {
    if (!this.db) return [];

    const sourcePlaceholders = sources.map(() => "?").join(", ");
    try {
      const rows = this.db
        .prepare(
          `SELECT c.path, c.chunk_id, c.content, c.start_line, c.end_line,
                  m.source, m.mtime_ms
           FROM chunks_vec_content c
           JOIN files_meta m ON c.path = m.path
           WHERE m.source IN (${sourcePlaceholders})
           ORDER BY m.mtime_ms DESC, c.chunk_id ASC
           LIMIT ?`,
        )
        .all(...sources, maxResults * 3) as Array<{
          path: string; chunk_id: number; content: string;
          start_line: number; end_line: number; source: MemorySource; mtime_ms: number;
        }>;

      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const r of rows) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        results.push({
          path: r.path,
          lineRange: [r.start_line, r.end_line],
          snippet: r.content.slice(0, 700),
          score: r.mtime_ms,
          source: r.source,
        });
        if (results.length >= maxResults) break;
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Fetch backlinks and forward links for a given file path (relative to homeDir).
   */
  getLinks(relPath: string): { links: string[]; backlinks: string[] } {
    if (!this.db) return { links: [], backlinks: [] };

    const links = (
      this.db.prepare(`SELECT to_slug FROM links WHERE from_path = ?`).all(relPath) as Array<{ to_slug: string }>
    ).map((r) => r.to_slug);

    const backlinks = (
      this.db.prepare(`SELECT from_path FROM backlinks WHERE to_path = ?`).all(relPath) as Array<{ from_path: string }>
    ).map((r) => r.from_path);

    return { links, backlinks };
  }

  /**
   * Resolve a wikilink slug to an absolute path under homeDir, if it exists.
   * e.g. "database/schema" → homeDir/memories/knowledge/database/schema.md
   */
  resolveWikilink(slug: string): string | null {
    const relPath = this.resolveSlugPath(slug);
    return relPath ? join(this.homeDir, relPath) : null;
  }

  // ─── Private: DB setup ──────────────────────────────────────────────────────

  private async openDb(Sqlite: DatabaseConstructor): Promise<void> {
    if (this.db) return;
    const dir = dirname(this.dbPath);
    await mkdir(dir, { recursive: true });
    this.db = new Sqlite(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();
  }

  private initSchema(): void {
    if (!this.db) return;

    // Schema version: bump this when schema changes require a full re-index.
    const SCHEMA_VERSION = 2;
    const currentVersion = (this.db.pragma("user_version") as Array<{ user_version: number }>)[0]?.user_version ?? 0;
    if (currentVersion < SCHEMA_VERSION) {
      // Drop link tables so they are recreated with UNIQUE constraints and all
      // files are re-indexed from scratch on next ensureIndex() call.
      this.db.exec(`
        DROP TABLE IF EXISTS links;
        DROP TABLE IF EXISTS backlinks;
        DROP TABLE IF EXISTS files_meta;
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files_meta (
        path         TEXT PRIMARY KEY,
        mtime_ms     INTEGER,
        content_hash TEXT,
        indexed_at   INTEGER,
        source       TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        path UNINDEXED, chunk_id UNINDEXED, content, start_line UNINDEXED, end_line UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS chunks_vec (
        path      TEXT,
        chunk_id  INTEGER,
        embedding BLOB,
        PRIMARY KEY (path, chunk_id)
      );

      CREATE TABLE IF NOT EXISTS chunks_vec_content (
        path       TEXT,
        chunk_id   INTEGER,
        content    TEXT,
        start_line INTEGER,
        end_line   INTEGER,
        PRIMARY KEY (path, chunk_id)
      );

      CREATE TABLE IF NOT EXISTS links (
        from_path TEXT,
        to_slug   TEXT,
        UNIQUE(from_path, to_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_path);

      CREATE TABLE IF NOT EXISTS backlinks (
        to_path   TEXT,
        from_path TEXT,
        UNIQUE(to_path, from_path)
      );
      CREATE INDEX IF NOT EXISTS idx_backlinks_to ON backlinks(to_path);
    `);
  }

  // ─── Private: file discovery ────────────────────────────────────────────────

  private async collectMemoryFiles(): Promise<Array<{ absPath: string; relPath: string; source: MemorySource }>> {
    const results: Array<{ absPath: string; relPath: string; source: MemorySource }> = [];

    const memoryMdPath = join(this.homeDir, "MEMORY.md");
    if (existsSync(memoryMdPath)) {
      results.push({ absPath: memoryMdPath, relPath: "MEMORY.md", source: "MEMORY" });
    }

    const sourceDirs: Array<{ dir: string; source: MemorySource }> = [
      { dir: join(this.homeDir, "memories", "knowledge"), source: "knowledge" },
      { dir: join(this.homeDir, "memories", "daily"), source: "daily" },
      { dir: join(this.homeDir, "memories", "experience"), source: "experience" },
    ];

    for (const { dir, source } of sourceDirs) {
      if (!existsSync(dir)) continue;
      const files = await this.walkDir(dir);
      for (const f of files) {
        if (extname(f) !== ".md") continue;
        results.push({ absPath: f, relPath: relative(this.homeDir, f), source });
      }
    }

    return results;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const fullPath = join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...(await this.walkDir(fullPath)));
      } else if (e.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  // ─── Private: cache invalidation (mtime + hash) ─────────────────────────────

  private async validateAndRebuildStale(
    files: Array<{ absPath: string; relPath: string; source: MemorySource }>,
  ): Promise<void> {
    if (!this.db) return;

    const getMeta = this.db.prepare(`SELECT mtime_ms, content_hash FROM files_meta WHERE path = ?`);
    const now = Date.now();

    for (const file of files) {
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(file.absPath);
      } catch {
        continue;
      }
      const currentMtime = fileStat.mtimeMs;
      const cached = getMeta.get(file.relPath) as { mtime_ms: number; content_hash: string } | undefined;

      if (cached && cached.mtime_ms === currentMtime) {
        continue;
      }

      // mtime changed — compute content hash to confirm actual change
      const content = await readFile(file.absPath, "utf-8");
      const contentHash = sha256(content);

      if (cached && cached.content_hash === contentHash) {
        // Only mtime changed (e.g. touch), update meta without rebuilding index
        this.db.prepare(`UPDATE files_meta SET mtime_ms = ?, indexed_at = ? WHERE path = ?`).run(
          currentMtime,
          now,
          file.relPath,
        );
        continue;
      }

      // Content changed — rebuild index for this file
      await this.rebuildFileIndex(file.relPath, file.source, content, currentMtime, contentHash, now);
    }

    // Handle deleted files
    const allIndexed = this.db.prepare(`SELECT path FROM files_meta`).all() as Array<{ path: string }>;
    const currentPaths = new Set(files.map((f) => f.relPath));
    for (const { path } of allIndexed) {
      if (!currentPaths.has(path)) {
        this.removeFileFromIndex(path);
      }
    }
  }

  private async rebuildFileIndex(
    relPath: string,
    source: MemorySource,
    content: string,
    mtimeMs: number,
    contentHash: string,
    now: number,
  ): Promise<void> {
    if (!this.db) return;

    // Remove old entries
    this.removeFileFromIndex(relPath);

    // Chunk the file
    const chunks = chunkMarkdown(content, relPath, CHUNK_SIZE_LINES, CHUNK_OVERLAP_LINES);

    const insertFts = this.db.prepare(
      `INSERT INTO chunks_fts(path, chunk_id, content, start_line, end_line) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertVecContent = this.db.prepare(
      `INSERT INTO chunks_vec_content(path, chunk_id, content, start_line, end_line) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMeta = this.db.prepare(
      `INSERT OR REPLACE INTO files_meta(path, mtime_ms, content_hash, indexed_at, source) VALUES (?, ?, ?, ?, ?)`,
    );

    const txn = this.db.transaction(() => {
      for (const chunk of chunks) {
        insertFts.run(relPath, chunk.chunkId, chunk.content, chunk.startLine, chunk.endLine);
        // Store vec content for all layers — embedding is applied to all sources when provider is available
        insertVecContent.run(relPath, chunk.chunkId, chunk.content, chunk.startLine, chunk.endLine);
      }
      insertMeta.run(relPath, mtimeMs, contentHash, now, source);
    });
    txn();

    // Parse wikilinks and update links/backlinks
    if (source === "knowledge" || source === "experience") {
      this.rebuildLinksForFile(relPath, content);
    }

    // Embed all layers when embedding provider is available
    if (this.embeddingProvider) {
      await this.embedFileChunks(relPath, chunks);
    }
  }

  private removeFileFromIndex(relPath: string): void {
    if (!this.db) return;
    this.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(relPath);
    this.db.prepare(`DELETE FROM chunks_vec WHERE path = ?`).run(relPath);
    this.db.prepare(`DELETE FROM chunks_vec_content WHERE path = ?`).run(relPath);
    this.db.prepare(`DELETE FROM links WHERE from_path = ?`).run(relPath);
    // Only remove backlinks that THIS file contributed (from_path = relPath).
    // Backlinks pointing TO this file (to_path = relPath) come from other files
    // and must not be deleted here — they remain valid as long as those source
    // files still contain the wikilink.
    this.db.prepare(`DELETE FROM backlinks WHERE from_path = ?`).run(relPath);
    this.db.prepare(`DELETE FROM files_meta WHERE path = ?`).run(relPath);
  }

  // ─── Private: link parsing ──────────────────────────────────────────────────

  private rebuildLinksForFile(relPath: string, content: string): void {
    if (!this.db) return;
    const slugs = extractWikilinks(content);
    if (slugs.length === 0) return;

    const insertLink = this.db.prepare(`INSERT OR IGNORE INTO links(from_path, to_slug) VALUES (?, ?)`);
    const insertBacklink = this.db.prepare(`INSERT OR IGNORE INTO backlinks(to_path, from_path) VALUES (?, ?)`);

    const txn = this.db.transaction(() => {
      for (const slug of slugs) {
        insertLink.run(relPath, slug);
        // Resolve slug to actual path for backlink index
        const resolved = this.resolveSlugPath(slug);
        if (resolved) {
          insertBacklink.run(resolved, relPath);
        }
      }
    });
    txn();
  }

  private resolveSlugPath(slug: string): string | null {
    const candidates = [
      `memories/knowledge/${slug}.md`,
      `memories/knowledge/${slug}/index.md`,
      `memories/experience/${slug}.md`,
      `${slug}.md`,
    ];
    for (const c of candidates) {
      if (existsSync(join(this.homeDir, c))) return c;
    }
    return null;
  }

  // ─── Private: embedding ──────────────────────────────────────────────────────

  private async embedFileChunks(relPath: string, chunks: FileChunk[]): Promise<void> {
    if (!this.db || !this.embeddingProvider) return;

    try {
      const texts = chunks.map((c) => c.content);
      const embeddings = await this.embeddingProvider.embed(texts);
      const insertVec = this.db.prepare(
        `INSERT OR REPLACE INTO chunks_vec(path, chunk_id, embedding) VALUES (?, ?, ?)`,
      );
      const txn = this.db.transaction(() => {
        chunks.forEach((chunk, i) => {
          insertVec.run(relPath, chunk.chunkId, float32ArrayToBuffer(embeddings[i]));
        });
      });
      txn();
    } catch {
      // Embedding failure is non-fatal; FTS5 will still work
    }
  }

  /**
   * Backfill embedding vectors for files that were indexed under FTS-only mode.
   * Reads chunks from chunks_vec_content (always populated), embeds them, and
   * writes to chunks_vec. Skips files that already have vectors.
   */
  private async backfillMissingEmbeddings(
    files: Array<{ absPath: string; relPath: string; source: MemorySource }>,
  ): Promise<void> {
    if (!this.db || !this.embeddingProvider) return;

    const hasVec = this.db.prepare(
      `SELECT 1 FROM chunks_vec WHERE path = ? LIMIT 1`,
    );
    const getChunks = this.db.prepare(
      `SELECT chunk_id, content FROM chunks_vec_content WHERE path = ? ORDER BY chunk_id`,
    );

    for (const file of files) {
      if (hasVec.get(file.relPath)) continue;

      const rows = getChunks.all(file.relPath) as Array<{ chunk_id: number; content: string }>;
      if (rows.length === 0) continue;

      try {
        const texts = rows.map((r) => r.content);
        const embeddings = await this.embeddingProvider.embed(texts);
        const insertVec = this.db!.prepare(
          `INSERT OR REPLACE INTO chunks_vec(path, chunk_id, embedding) VALUES (?, ?, ?)`,
        );
        const txn = this.db!.transaction(() => {
          rows.forEach((row, i) => {
            insertVec.run(file.relPath, row.chunk_id, float32ArrayToBuffer(embeddings[i]));
          });
        });
        txn();
      } catch {
        // Non-fatal — FTS still works, will retry on next ensureIndex call
      }
    }
  }

  // ─── Private: temporal decay ────────────────────────────────────────────────

  private applyTemporalDecay(results: SearchResult[]): SearchResult[] {
    const now = Date.now();
    return results.map((r) => {
      const dateMatch = r.path.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) return r;
      const fileDate = new Date(dateMatch[1]).getTime();
      if (isNaN(fileDate)) return r;
      const ageMs = now - fileDate;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      // Decay: score * exp(-0.05 * ageDays) — half-life ~14 days
      const decayed = r.score * Math.exp(-0.05 * ageDays);
      return { ...r, score: decayed };
    });
  }

  // ─── Private: FTS query escaping ────────────────────────────────────────────

  private escapeFtsQuery(query: string): string {
    const trimmed = query.trim();
    // trigram tokenizer: pass the query string as-is (no phrase quoting needed).
    // Only escape double-quotes to avoid FTS5 syntax errors from user input.
    // Trigram handles CJK substrings and English n-grams natively.
    return trimmed.replace(/"/g, '""');
  }
}

// ─── Helper functions ──────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Split markdown content into overlapping chunks of fixed line count.
 * Tries to split on markdown headings (##) when possible.
 */
export function chunkMarkdown(
  content: string,
  _path: string,
  chunkSize = CHUNK_SIZE_LINES,
  overlap = CHUNK_OVERLAP_LINES,
): FileChunk[] {
  const lines = content.split("\n");
  const chunks: FileChunk[] = [];
  let chunkId = 0;
  let start = 0;

  while (start < lines.length) {
    const end = Math.min(start + chunkSize, lines.length);
    const chunkLines = lines.slice(start, end);
    const chunkContent = chunkLines.join("\n").trim();

    if (chunkContent.length > 0) {
      chunks.push({
        path: _path,
        chunkId: chunkId++,
        content: chunkContent,
        startLine: start + 1,
        endLine: end,
      });
    }

    if (end >= lines.length) break;
    start = end - overlap;
  }

  return chunks;
}

/** Extract [[wikilink]] slugs from markdown content. */
export function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g);
  const slugs: string[] = [];
  for (const m of matches) {
    slugs.push(m[1].trim());
  }
  return [...new Set(slugs)];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function float32ArrayToBuffer(arr: number[]): Buffer {
  const fa = new Float32Array(arr);
  return Buffer.from(fa.buffer);
}

function bufferToFloat32Array(buf: Buffer): number[] {
  const fa = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(fa);
}

// ─── Singleton per homeDir ─────────────────────────────────────────────────────

const managers = new Map<string, MemoryIndexManager>();

export function getMemoryIndexManager(
  homeDir: string,
  embeddingProvider?: EmbeddingProvider,
): MemoryIndexManager {
  const existing = managers.get(homeDir);
  if (existing) {
    existing.embeddingProvider = embeddingProvider ?? null;
    return existing;
  }
  const mgr = new MemoryIndexManager(homeDir, embeddingProvider);
  managers.set(homeDir, mgr);
  return mgr;
}
