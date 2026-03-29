/**
 * git-memory — Semantic Git history index for Claude Code
 * Node.js port of claude-memory (Python)
 *
 * Public API matches Python __init__.py exports.
 */

export { ChromaCommitIndex } from './chroma-index.js';
export { GitMemoryIndexer } from './indexer.js';
export { ContextStore } from './context-store.js';
export { storeCommit } from './store.js';

export {
  isRelevant,
  categorize,
  buildMetadata,
  buildDocument,
  summarizeCommit,
  buildStatsStr,
  RELEVANT_KEYWORDS,
  MAX_FILES_PER_COMMIT,
} from './filters.js';

export {
  createEmbeddingFunction,
  type IEmbeddingFunction,
} from './embeddings.js';

export {
  configFromEnv,
  type CommitRecord,
  type CommitMetadata,
  type IndexMetadata,
  type CommitCategory,
  type IndexStats,
  type EmbedProvider,
  type GitMemoryConfig,
} from './types.js';
