import { simpleGit } from 'simple-git';
import { GitMemoryIndexer } from './indexer.js';
import { isRelevant } from './filters.js';
import { configFromEnv } from './types.js';

/**
 * Store a single commit into ChromaDB + ContextStore.
 * Called by CLI `git-memory store [commit-ref]`.
 *
 * Matches Python store.py exactly:
 *   - Accepts a commit ref (default: HEAD)
 *   - Quick relevance check before creating full indexer
 *   - Returns true if stored, false if skipped
 *
 * Exit codes are handled by the CLI (0 = stored, 1 = skipped).
 */
export async function storeCommit(
  commitRef = 'HEAD',
  opts: { repoPath?: string; userId?: string; force?: boolean } = {},
): Promise<boolean> {
  const config = configFromEnv();
  if (opts.repoPath) config.repoPath = opts.repoPath;
  if (opts.userId)   config.userId   = opts.userId;

  const git = simpleGit(config.repoPath);

  // Resolve ref to full hash
  let hash: string;
  try {
    hash = (await git.revparse([commitRef])).trim();
  } catch (e) {
    process.stderr.write(`store: failed to resolve ref '${commitRef}': ${e}\n`);
    return false;
  }

  // Quick relevance check before creating the full indexer (matches Python store.py:22-23)
  if (!opts.force) {
    try {
      const log = await git.log({ from: `${hash}~1`, to: hash, maxCount: 1 });
      const msg = log.latest?.message ?? '';
      if (!isRelevant(msg)) return false;
    } catch {
      // Root commit or shallow clone — skip check, let indexer decide
    }
  }

  const indexer = await GitMemoryIndexer.create(config);
  return indexer.indexCommit(hash, opts.force);
}
