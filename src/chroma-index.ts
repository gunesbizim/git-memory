import { join } from 'path';
import { VectorCollection } from './vector-store.js';
import { buildDocument } from './filters.js';
import type { CommitCategory, CommitRecord } from './types.js';
import type { IEmbeddingFunction } from './embeddings.js';

const DB_FILENAME = 'git_commits.db';

export class ChromaCommitIndex {
  private col: VectorCollection;

  private constructor(col: VectorCollection) {
    this.col = col;
  }

  /** Async factory — opens (or creates) the local SQLite vector store. */
  static async create(chromaDir: string, embedFn: IEmbeddingFunction): Promise<ChromaCommitIndex> {
    const dbPath = join(chromaDir, DB_FILENAME);
    const col = VectorCollection.open(dbPath, 'git_commits', embedFn);
    return new ChromaCommitIndex(col);
  }

  /**
   * Insert a commit if not already indexed. Returns false if duplicate.
   * Exact port of Python upsert_commit():
   *   1. Check existence (col.has)
   *   2. Build document text
   *   3. col.add() with metadata
   */
  async upsertCommit(params: {
    commitHash: string;
    authorName: string;
    authorEmail: string;
    committedDate: string;
    message: string;
    category: CommitCategory;
    files: string[];
    statsStr: string;
    repo: string;
  }): Promise<boolean> {
    if (this.col.has(params.commitHash)) return false;

    const document = buildDocument(
      params.message,
      params.authorName,
      params.authorEmail,
      params.committedDate.slice(0, 10),
      params.statsStr,
      params.files,
    );

    await this.col.add({
      id: params.commitHash,
      document,
      metadata: {
        short_hash:     params.commitHash.slice(0, 8),
        author_name:    params.authorName,
        author_email:   params.authorEmail,
        committed_date: params.committedDate,
        category:       params.category,
        repo:           params.repo,
        files_str:      params.files.join('|'),
        date_str:       params.committedDate.slice(0, 10),
      },
    });
    return true;
  }

  /**
   * Semantic cosine similarity search.
   * Clamps nResults to collection count (matches Python behaviour).
   */
  async search(params: {
    query: string;
    nResults?: number;
    category?: string;
    repo?: string;
  }): Promise<CommitRecord[]> {
    const count = this.col.count();
    if (count === 0) return [];
    const nResults = Math.min(params.nResults ?? 10, Math.max(1, count));
    const where = buildWhere(params.category, params.repo);

    try {
      const raw = await this.col.query({
        queryTexts: [params.query],
        nResults,
        ...(where ? { where } : {}),
      });
      return formatQueryResults(raw);
    } catch (e) {
      process.stderr.write(`VectorStore search error: ${e}\n`);
      return [];
    }
  }

  /**
   * Get N most recent commits sorted by committed_date descending.
   * Matches Python get_latest():
   *   - Fetches min(count, max(n*3, 50)) — bounded window
   *   - Sorts by date in JS
   *   - Returns first n
   */
  async getLatest(params: { n?: number; repo?: string }): Promise<CommitRecord[]> {
    const n = params.n ?? 10;
    const count = this.col.count();
    if (count === 0) return [];

    const fetchLimit = Math.min(count, Math.max(n * 3, 50));
    const where = buildWhere(undefined, params.repo);

    const raw = this.col.get({ limit: fetchLimit, where });
    const records = formatGetResults(raw);
    records.sort((a, b) => b.date.localeCompare(a.date));
    return records.slice(0, n);
  }

  /**
   * Find commits that touched a file.
   * Matches Python search_by_file():
   *   1. Fetch ALL docs (with optional repo filter)
   *   2. JS-side string matching: filename in files_str
   *   3. Sort by date, return first n_results
   *   4. Fallback: semantic search
   */
  async searchByFile(params: {
    filename: string;
    nResults?: number;
    repo?: string;
  }): Promise<CommitRecord[]> {
    const nResults = params.nResults ?? 20;
    const needle = params.filename.toLowerCase();
    const where = buildWhere(undefined, params.repo);

    const all = this.col.get({ where });
    const matched: CommitRecord[] = [];

    for (let i = 0; i < all.ids.length; i++) {
      const filesStr = String(all.metadatas[i]?.files_str ?? '');
      if (filesStr.toLowerCase().includes(needle)) {
        matched.push(makeGetRecord(all.ids[i], all.documents[i], all.metadatas[i]));
      }
    }

    if (matched.length > 0) {
      matched.sort((a, b) => b.date.localeCompare(a.date));
      return matched.slice(0, nResults);
    }

    return this.search({ query: `changes to ${params.filename}`, nResults, repo: params.repo });
  }

  /** Count indexed commits, optionally filtered by repo. */
  async count(repo?: string): Promise<number> {
    if (!repo) return this.col.count();
    const where = buildWhere(undefined, repo);
    const result = this.col.get({ where });
    return result.ids.length;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWhere(category?: string, repo?: string): Record<string, unknown> | undefined {
  const conds: Record<string, unknown>[] = [];
  if (category) conds.push({ category: { $eq: category } });
  if (repo)     conds.push({ repo:     { $eq: repo } });
  if (conds.length === 0) return undefined;
  if (conds.length === 1) return conds[0];
  return { $and: conds };
}

function formatQueryResults(raw: {
  ids: string[][];
  documents: string[][];
  metadatas: Record<string, string | number>[][];
  distances: number[][];
}): CommitRecord[] {
  const ids   = raw.ids?.[0]       ?? [];
  const docs  = raw.documents?.[0] ?? [];
  const metas = raw.metadatas?.[0] ?? [];
  const dists = raw.distances?.[0] ?? [];

  return ids.map((hash, i) => ({
    commit_hash:     hash,
    short_hash:      String(metas[i]?.short_hash    ?? hash.slice(0, 8)),
    author:          String(metas[i]?.author_name    ?? 'unknown'),
    date:            String(metas[i]?.committed_date ?? ''),
    category:        String(metas[i]?.category       ?? 'general') as CommitCategory,
    files_changed:   String(metas[i]?.files_str      ?? '').split('|').filter(Boolean),
    summary:         docs[i] ?? '',
    relevance_score: Math.round((1.0 - (dists[i] ?? 1.0)) * 10000) / 10000,
    source:          'chroma',
  }));
}

function formatGetResults(raw: {
  ids: string[];
  documents: string[];
  metadatas: Record<string, string | number>[];
}): CommitRecord[] {
  return raw.ids.map((hash, i) => makeGetRecord(hash, raw.documents[i], raw.metadatas[i]));
}

function makeGetRecord(
  hash: string,
  doc: string,
  meta: Record<string, string | number>,
): CommitRecord {
  return {
    commit_hash:     hash,
    short_hash:      String(meta?.short_hash    ?? ''),
    author:          String(meta?.author_name    ?? ''),
    date:            String(meta?.committed_date ?? ''),
    category:        String(meta?.category       ?? 'general') as CommitCategory,
    files_changed:   String(meta?.files_str      ?? '').split('|').filter(Boolean),
    summary:         doc ?? '',
    relevance_score: 0,
    source:          'chroma',
  };
}
