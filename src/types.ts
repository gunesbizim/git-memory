import { homedir } from 'os';
import { join } from 'path';

/** Metadata stored per-commit in ChromaDB. Matches Python version field-for-field. */
export interface CommitMetadata {
  short_hash: string;           // commit_hash[:8]
  author_name: string;
  author_email: string;
  committed_date: string;       // ISO 8601 with timezone
  category: CommitCategory;
  repo: string;                 // repository directory name
  files_str: string;            // "|"-separated, max 20 files
  date_str: string;             // YYYY-MM-DD
}

/** Metadata used during indexing (superset of CommitMetadata). Matches Python build_metadata(). */
export interface IndexMetadata extends CommitMetadata {
  type: 'git_commit';           // constant
  commit_hash: string;          // full SHA
  files_changed: string[];      // array form of files_str
}

export type CommitCategory =
  | 'fix'
  | 'feat'
  | 'refactor'
  | 'arch'
  | 'perf'
  | 'security'
  | 'migration'
  | 'general';

/**
 * A commit record returned by all 5 MCP tools.
 * Field names match Python MCP response shape exactly:
 *   - "author" (not "author_name")
 *   - "date" (not "committed_date")
 */
export interface CommitRecord {
  commit_hash: string;
  short_hash: string;
  author: string;
  date: string;
  category: CommitCategory | string;
  files_changed: string[];
  summary: string;
  relevance_score: number;
  source?: string;
  learned_context?: string[];
  in_chroma_index?: boolean;
}

export interface IndexStats {
  total_evaluated: number;
  stored: number;
  skipped_irrelevant: number;
  skipped_duplicate: number;
  errors: number;
}

export type EmbedProvider = 'ollama' | 'openai' | 'fastembed';

export interface GitMemoryConfig {
  repoPath: string;
  userId: string;
  chromaDir: string;
  contextDir: string;
  embedProvider: EmbedProvider;
  embedModel: string;
  ollamaUrl: string;
  llmModel: string;
  openaiApiKey?: string;
}

/** Build config from environment variables with sensible defaults. */
export function configFromEnv(): GitMemoryConfig {
  const home = homedir();
  const provider = (process.env.GIT_MEMORY_EMBED_PROVIDER || 'ollama') as EmbedProvider;

  // Default model differs per provider — matches Python behaviour
  let defaultEmbedModel = 'nomic-embed-text';
  if (provider === 'openai') defaultEmbedModel = 'text-embedding-3-small';
  if (provider === 'fastembed') defaultEmbedModel = 'BAAI/bge-small-en-v1.5';

  return {
    repoPath:      process.env.GIT_MEMORY_REPO_PATH    || process.cwd(),
    userId:        process.env.GIT_MEMORY_USER_ID       || 'git_memory_system',
    chromaDir:     process.env.GIT_MEMORY_CHROMA_DIR    || join(home, '.cache', 'git_memory', 'chroma_commits'),
    contextDir:    process.env.GIT_MEMORY_CONTEXT_DIR   || join(home, '.cache', 'git_memory', 'chroma_context'),
    embedProvider: provider,
    embedModel:    process.env.GIT_MEMORY_EMBED_MODEL   || defaultEmbedModel,
    ollamaUrl:     process.env.OLLAMA_URL               || 'http://localhost:11434',
    llmModel:      process.env.GIT_MEMORY_LLM_MODEL     || 'qwen2.5',
    openaiApiKey:  process.env.OPENAI_API_KEY,
  };
}
