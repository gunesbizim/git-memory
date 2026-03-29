import { simpleGit, type SimpleGit } from 'simple-git';
import { basename } from 'path';
import { ChromaCommitIndex } from './chroma-index.js';
import { ContextStore } from './context-store.js';
import { createEmbeddingFunction } from './embeddings.js';
import { isRelevant, buildMetadata, buildDocument, summarizeCommit, buildStatsStr } from './filters.js';
import { type GitMemoryConfig, type IndexStats, configFromEnv } from './types.js';

interface CommitDetails {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  message: string;
  files: string[];
  insertions: number;
  deletions: number;
  fileCount: number;
}

export class GitMemoryIndexer {
  private git: SimpleGit;
  private repoName: string;
  private chromaIndex: ChromaCommitIndex;
  private contextStore: ContextStore;
  private userId: string;

  private constructor(
    git: SimpleGit,
    repoName: string,
    chromaIndex: ChromaCommitIndex,
    contextStore: ContextStore,
    userId: string,
  ) {
    this.git = git;
    this.repoName = repoName;
    this.chromaIndex = chromaIndex;
    this.contextStore = contextStore;
    this.userId = userId;
  }

  /** Async factory — initialises git, ChromaDB (Layer 1), and ContextStore (Layer 2). */
  static async create(config: GitMemoryConfig): Promise<GitMemoryIndexer> {
    const git = simpleGit(config.repoPath);

    let repoName: string;
    try {
      const root = await git.revparse(['--show-toplevel']);
      repoName = basename(root.trim());
    } catch {
      repoName = basename(config.repoPath);
    }

    const embedFn = await createEmbeddingFunction(
      config.embedProvider,
      config.embedModel,
      config.ollamaUrl,
      config.openaiApiKey,
    );

    const chromaIndex = await ChromaCommitIndex.create(config.chromaDir, embedFn);
    const contextStore = await ContextStore.create(config, embedFn);

    return new GitMemoryIndexer(git, repoName, chromaIndex, contextStore, config.userId);
  }

  /** Convenience factory using environment variables. */
  static async fromEnv(): Promise<GitMemoryIndexer> {
    return GitMemoryIndexer.create(configFromEnv());
  }

  /**
   * Index a single commit by hash.
   * Matches Python index_commit() exactly:
   *   1. Get commit details
   *   2. isRelevant() check — skip if false (unless force)
   *   3. Build metadata + document
   *   4. Layer 1: chromaIndex.upsertCommit() — returns false if duplicate
   *   5. If Layer 1 returned false and !force → return false
   *   6. Layer 2: contextStore.addCommit() — no-throw
   *   7. Return true
   */
  async indexCommit(hash: string, force = false): Promise<boolean> {
    let details: CommitDetails;
    try {
      details = await this.getCommitDetails(hash);
    } catch (e) {
      process.stderr.write(`indexCommit: failed to get details for ${hash.slice(0, 8)}: ${e}\n`);
      return false;
    }

    if (!isRelevant(details.message) && !force) return false;

    const meta = buildMetadata({
      hash:       details.hash,
      authorName: details.authorName,
      authorEmail:details.authorEmail,
      date:       details.date,
      message:    details.message,
      files:      details.files,
      repoName:   this.repoName,
    });

    const statsStr = buildStatsStr(details.insertions, details.deletions);

    let inserted: boolean;
    try {
      inserted = await this.chromaIndex.upsertCommit({
        commitHash:    details.hash,
        authorName:    meta.author_name,
        authorEmail:   meta.author_email,
        committedDate: meta.committed_date,
        message:       details.message,
        category:      meta.category,
        files:         meta.files_changed,
        statsStr,
        repo:          this.repoName,
      });
    } catch (e) {
      process.stderr.write(`Chroma insert failed ${details.hash.slice(0, 8)}: ${e}\n`);
      inserted = false;
    }

    if (!inserted && !force) return false;

    // Layer 2 — fire-and-forget, no-throw
    const summary = summarizeCommit({
      hash:        details.hash,
      authorName:  details.authorName,
      authorEmail: details.authorEmail,
      date:        details.date,
      message:     details.message,
      insertions:  details.insertions,
      deletions:   details.deletions,
      fileCount:   details.fileCount,
      files:       details.files,
    });

    this.contextStore.addCommit({
      hash:     details.hash,
      summary,
      metadata: meta,
      userId:   this.userId,
    }).catch((e: unknown) => {
      process.stderr.write(`Mem0-equiv failed for ${details.hash.slice(0, 8)} (Chroma OK): ${e}\n`);
    });

    return true;
  }

  /**
   * Index all commits on a branch.
   * Matches Python index_all() exactly:
   *   - Iterates commits, skips irrelevant, logs progress every 100
   *   - Returns IndexStats
   */
  async indexAll(params: {
    branch?: string;
    limit?: number;
    dryRun?: boolean;
  } = {}): Promise<IndexStats> {
    const branch = params.branch ?? 'HEAD';
    const stats: IndexStats = {
      total_evaluated: 0,
      stored: 0,
      skipped_irrelevant: 0,
      skipped_duplicate: 0,
      errors: 0,
    };

    const logOptions: Parameters<SimpleGit['log']>[0] = {
      format: { hash: '%H', message: '%s' },
    };
    if (params.limit) (logOptions as Record<string, unknown>).maxCount = params.limit;
    if (branch !== 'HEAD') (logOptions as Record<string, unknown>).from = branch;

    let commits: { hash: string; message: string }[];
    try {
      const log = await this.git.log(logOptions as Parameters<SimpleGit['log']>[0]);
      commits = log.all as { hash: string; message: string }[];
    } catch (e) {
      process.stderr.write(`indexAll: git log failed: ${e}\n`);
      return stats;
    }

    process.stderr.write(`Found ${commits.length} commits to evaluate\n`);
    stats.total_evaluated = commits.length;

    for (let i = 0; i < commits.length; i++) {
      if ((i + 1) % 100 === 0) {
        process.stderr.write(`Progress: ${i + 1} / ${commits.length}\n`);
      }

      const { hash, message } = commits[i];

      if (!isRelevant(message)) {
        stats.skipped_irrelevant++;
        continue;
      }

      if (params.dryRun) {
        process.stderr.write(`[DRY-RUN] ${hash.slice(0, 8)}  ${message.slice(0, 72)}\n`);
        stats.stored++;
        continue;
      }

      try {
        const stored = await this.indexCommit(hash);
        if (stored) {
          stats.stored++;
        } else {
          stats.skipped_duplicate++;
        }
      } catch (e) {
        process.stderr.write(`Error ${hash.slice(0, 8)}: ${e}\n`);
        stats.errors++;
      }
    }

    process.stderr.write(`Done. ${JSON.stringify(stats)}\n`);
    return stats;
  }

  /**
   * Get full commit details via git show + diff-tree.
   * Uses git show for author/date/message, diff-tree for exact file list.
   */
  private async getCommitDetails(hash: string): Promise<CommitDetails> {
    // Get author, date, message
    const showRaw = await this.git.raw([
      'show',
      '--no-patch',
      '--format=%H%n%an%n%ae%n%aI%n%s',
      hash,
    ]);
    const lines = showRaw.trim().split('\n');
    const authorName  = lines[1]?.trim() ?? 'Unknown';
    const authorEmail = lines[2]?.trim() ?? '';
    const dateStr     = lines[3]?.trim() ?? new Date().toISOString();
    const message     = lines[4]?.trim() ?? '';

    // Get file list
    let files: string[] = [];
    try {
      const filesRaw = await this.git.raw([
        'diff-tree', '--no-commit-id', '-r', '--name-only', hash,
      ]);
      files = filesRaw.trim().split('\n').filter(Boolean);
    } catch { /* root commit or shallow clone — leave empty */ }

    // Get stat numbers
    let insertions = 0;
    let deletions = 0;
    let fileCount = files.length;
    try {
      const statRaw = await this.git.raw([
        'show', '--stat', '--format=', hash,
      ]);
      // Last line: "N files changed, N insertions(+), N deletions(-)"
      const statLines = statRaw.trim().split('\n');
      const summaryLine = statLines[statLines.length - 1] ?? '';
      const insMatch = summaryLine.match(/(\d+) insertion/);
      const delMatch = summaryLine.match(/(\d+) deletion/);
      const fileMatch = summaryLine.match(/(\d+) file/);
      if (insMatch) insertions = parseInt(insMatch[1], 10);
      if (delMatch) deletions  = parseInt(delMatch[1], 10);
      if (fileMatch) fileCount = parseInt(fileMatch[1], 10);
    } catch { /* leave zeros */ }

    return {
      hash,
      authorName,
      authorEmail,
      date:     new Date(dateStr),
      message,
      files,
      insertions,
      deletions,
      fileCount,
    };
  }

  get name(): string { return this.repoName; }
  get chroma(): ChromaCommitIndex { return this.chromaIndex; }
}
