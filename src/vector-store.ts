/**
 * Local SQLite-backed vector store.
 * Replaces ChromaDB (JS client only supports HTTP servers, not local embedded).
 * Stores embeddings as JSON blobs, performs cosine similarity in JS.
 *
 * API surface mirrors Python ChromaDB PersistentClient to keep the rest
 * of the codebase consistent with the plan.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { IEmbeddingFunction } from './embeddings.js';

export interface VectorRecord {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
  embedding: number[];
}

export interface SearchResult {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
  distance: number;
}

export class VectorCollection {
  private db: Database.Database;
  private embedFn: IEmbeddingFunction;
  private name: string;

  private constructor(db: Database.Database, name: string, embedFn: IEmbeddingFunction) {
    this.db = db;
    this.name = name;
    this.embedFn = embedFn;
    this.init();
  }

  /** Create or open a collection backed by a SQLite file at dbPath. */
  static open(dbPath: string, name: string, embedFn: IEmbeddingFunction): VectorCollection {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    return new VectorCollection(db, name, embedFn);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id        TEXT PRIMARY KEY,
        document  TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_metadata ON vectors(metadata);
    `);
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /** Check if an id already exists. */
  has(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM vectors WHERE id = ?').get(id);
    return row !== undefined;
  }

  /** Add a document. Does nothing if id already exists (explicit dedup gate). */
  async add(params: {
    id: string;
    document: string;
    metadata: Record<string, string | number>;
  }): Promise<void> {
    if (this.has(params.id)) return;

    const [embedding] = await this.embedFn.generate([params.document]);
    this.db.prepare(`
      INSERT OR IGNORE INTO vectors (id, document, embedding, metadata)
      VALUES (?, ?, ?, ?)
    `).run(
      params.id,
      params.document,
      JSON.stringify(embedding),
      JSON.stringify(params.metadata),
    );
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM vectors').get() as { n: number };
    return row.n;
  }

  /** Get records by ids or all records if no ids specified. */
  get(params: {
    ids?: string[];
    where?: Record<string, unknown>;
    limit?: number;
  } = {}): { ids: string[]; documents: string[]; metadatas: Record<string, string | number>[] } {
    let rows: { id: string; document: string; metadata: string }[];

    if (params.ids && params.ids.length > 0) {
      const placeholders = params.ids.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT id, document, metadata FROM vectors WHERE id IN (${placeholders})`).all(...params.ids) as typeof rows;
    } else if (params.limit) {
      rows = this.db.prepare('SELECT id, document, metadata FROM vectors LIMIT ?').all(params.limit) as typeof rows;
    } else {
      rows = this.db.prepare('SELECT id, document, metadata FROM vectors').all() as typeof rows;
    }

    // Apply where filter in JS (mirrors Python chromadb behaviour for simple equality)
    let filtered = rows;
    if (params.where) {
      filtered = rows.filter(row => {
        const meta = JSON.parse(row.metadata) as Record<string, string | number>;
        return matchesWhere(meta, params.where!);
      });
    }

    return {
      ids:       filtered.map(r => r.id),
      documents: filtered.map(r => r.document),
      metadatas: filtered.map(r => JSON.parse(r.metadata) as Record<string, string | number>),
    };
  }

  /**
   * Semantic search — cosine similarity between query embedding and all stored vectors.
   * Returns top nResults sorted by ascending distance (0 = identical, 1 = opposite).
   */
  async query(params: {
    queryTexts: string[];
    nResults: number;
    where?: Record<string, unknown>;
    include?: string[];
  }): Promise<{
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, string | number>[][];
    distances: number[][];
  }> {
    const [queryEmbedding] = await this.embedFn.generate(params.queryTexts);

    const all = this.db.prepare('SELECT id, document, embedding, metadata FROM vectors').all() as {
      id: string; document: string; embedding: string; metadata: string;
    }[];

    let candidates = all;

    // JS-side where filter
    if (params.where) {
      candidates = all.filter(row => {
        const meta = JSON.parse(row.metadata) as Record<string, string | number>;
        return matchesWhere(meta, params.where!);
      });
    }

    // Compute cosine distances
    const scored = candidates.map(row => {
      const embedding = JSON.parse(row.embedding) as number[];
      const distance  = cosineDistance(queryEmbedding, embedding);
      const metadata  = JSON.parse(row.metadata) as Record<string, string | number>;
      return { id: row.id, document: row.document, metadata, distance };
    });

    // Sort ascending by distance, take top N
    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, params.nResults);

    return {
      ids:       [top.map(r => r.id)],
      documents: [top.map(r => r.document)],
      metadatas: [top.map(r => r.metadata)],
      distances: [top.map(r => r.distance)],
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

/**
 * Matches a metadata record against a chromadb-style where clause.
 * Supports: { field: { $eq: val } }, { $and: [...] }
 */
function matchesWhere(meta: Record<string, string | number>, where: Record<string, unknown>): boolean {
  if ('$and' in where) {
    return (where.$and as Record<string, unknown>[]).every(c => matchesWhere(meta, c));
  }
  for (const [key, cond] of Object.entries(where)) {
    if (typeof cond === 'object' && cond !== null && '$eq' in cond) {
      if (meta[key] !== (cond as { $eq: unknown }).$eq) return false;
    }
  }
  return true;
}
