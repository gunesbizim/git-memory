import { join } from 'path';
import { VectorCollection } from './vector-store.js';
import type { CommitCategory, CommitRecord, CommitMetadata, GitMemoryConfig } from './types.js';
import type { IEmbeddingFunction } from './embeddings.js';

const DB_FILENAME = 'git_commit_context.db';

type LLMClient =
  | { type: 'ollama'; client: import('ollama').Ollama }
  | { type: 'openai'; client: import('openai').default };

export class ContextStore {
  private col: VectorCollection;
  private llm: LLMClient | null;
  private llmModel: string;

  private constructor(col: VectorCollection, llm: LLMClient | null, llmModel: string) {
    this.col = col;
    this.llm = llm;
    this.llmModel = llmModel;
  }

  /**
   * Async factory — opens (or creates) the local SQLite context store and detects LLM availability.
   * LLM detection order (matches Python _default_mem0_config() priority):
   *   1. OPENAI_API_KEY set → use OpenAI gpt-4o-mini
   *   2. otherwise → attempt Ollama at OLLAMA_URL
   *   3. Ollama fails → llm = null (graceful degradation)
   */
  static async create(config: GitMemoryConfig, embedFn: IEmbeddingFunction): Promise<ContextStore> {
    const dbPath = join(config.contextDir, DB_FILENAME);
    const col = VectorCollection.open(dbPath, 'git_commit_context', embedFn);

    let llm: LLMClient | null = null;

    if (config.openaiApiKey) {
      try {
        const { default: OpenAI } = await import('openai');
        const openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
        llm = { type: 'openai', client: openaiClient };
      } catch (e) {
        process.stderr.write(`ContextStore: OpenAI init failed — Layer 2 disabled: ${e}\n`);
      }
    } else {
      try {
        const { Ollama } = await import('ollama');
        const ollamaClient = new Ollama({ host: config.ollamaUrl });
        // Quick connectivity test
        await ollamaClient.list();
        llm = { type: 'ollama', client: ollamaClient };
      } catch (e) {
        process.stderr.write(`ContextStore: Ollama unavailable — Layer 2 (LLM context) disabled: ${e}\n`);
        process.stderr.write(`  To enable: install and start Ollama (https://ollama.com) or set OPENAI_API_KEY\n`);
      }
    }

    return new ContextStore(col, llm, config.llmModel);
  }

  /**
   * Extract LLM interpretation and store it.
   * Mirrors Python: memory.add(messages=[{"role":"user","content":summary}], metadata)
   *
   * Flow:
   *   1. If llm is null → no-op (graceful degradation)
   *   2. Dedup check — skip if hash already stored
   *   3. Extract 1–2 sentence interpretation via LLM
   *   4. Store extracted text + metadata in collection
   */
  async addCommit(params: {
    hash: string;
    summary: string;
    metadata: CommitMetadata;
    userId: string;
  }): Promise<void> {
    if (this.llm === null) return;

    try {
      if (this.col.has(params.hash)) return;

      const interpretation = await this.extractContext(params.summary);

      await this.col.add({
        id: params.hash,
        document: interpretation,
        metadata: {
          commit_hash:    params.hash,
          short_hash:     params.metadata.short_hash,
          author_name:    params.metadata.author_name,
          author_email:   params.metadata.author_email,
          committed_date: params.metadata.committed_date,
          category:       params.metadata.category,
          repo:           params.metadata.repo,
          files_str:      params.metadata.files_str,
          date_str:       params.metadata.date_str,
          user_id:        params.userId,
        },
      });
    } catch (e) {
      process.stderr.write(`ContextStore.addCommit failed for ${params.hash.slice(0, 8)}: ${e}\n`);
    }
  }

  /**
   * Semantic search on extracted context collection.
   * Returns CommitRecord[] with the LLM interpretation as the summary field.
   */
  async search(params: {
    query: string;
    userId: string;
    limit: number;
  }): Promise<CommitRecord[]> {
    try {
      const count = this.col.count();
      if (count === 0) return [];
      const nResults = Math.min(params.limit, Math.max(1, count));

      const raw = await this.col.query({
        queryTexts: [params.query],
        nResults,
      });

      return formatQueryResults(raw);
    } catch {
      return [];
    }
  }

  /**
   * Get all stored context entries (for latest_commits enrichment map).
   * Matches Python: mem.get_all(user_id=USER_ID)
   */
  async getAll(_userId: string): Promise<CommitRecord[]> {
    try {
      const raw = this.col.get({});
      return formatGetResults(raw);
    } catch {
      return [];
    }
  }

  /** Whether LLM context extraction is available. */
  get isActive(): boolean {
    return this.llm !== null;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Call LLM to extract a concise interpretation of a commit.
   * Prompt matches spirit of mem0's extraction: brief, why-focused.
   */
  private async extractContext(summary: string): Promise<string> {
    const prompt = `Summarize in 1-2 sentences what this commit achieves and why it matters:\n\n${summary}`;

    if (this.llm?.type === 'openai') {
      const response = await this.llm.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You extract concise commit interpretations for a code search index.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 120,
        temperature: 0,
      });
      return response.choices[0]?.message?.content?.trim() ?? summary;
    }

    if (this.llm?.type === 'ollama') {
      const response = await this.llm.client.chat({
        model: this.llmModel,
        messages: [
          { role: 'system', content: 'You extract concise commit interpretations for a code search index.' },
          { role: 'user', content: prompt },
        ],
      });
      return response.message?.content?.trim() ?? summary;
    }

    return summary;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    commit_hash:     String(metas[i]?.commit_hash   ?? hash),
    short_hash:      String(metas[i]?.short_hash    ?? hash.slice(0, 8)),
    author:          String(metas[i]?.author_name    ?? 'unknown'),
    date:            String(metas[i]?.committed_date ?? ''),
    category:        String(metas[i]?.category       ?? 'general') as CommitCategory,
    files_changed:   String(metas[i]?.files_str      ?? '').split('|').filter(Boolean),
    summary:         docs[i] ?? '',
    relevance_score: Math.round((1.0 - (dists[i] ?? 1.0)) * 10000) / 10000,
    source:          'context',
  }));
}

function formatGetResults(raw: {
  ids: string[];
  documents: string[];
  metadatas: Record<string, string | number>[];
}): CommitRecord[] {
  return raw.ids.map((hash, i) => ({
    commit_hash:     String(raw.metadatas[i]?.commit_hash   ?? hash),
    short_hash:      String(raw.metadatas[i]?.short_hash    ?? ''),
    author:          String(raw.metadatas[i]?.author_name    ?? ''),
    date:            String(raw.metadatas[i]?.committed_date ?? ''),
    category:        String(raw.metadatas[i]?.category       ?? 'general') as CommitCategory,
    files_changed:   String(raw.metadatas[i]?.files_str      ?? '').split('|').filter(Boolean),
    summary:         raw.documents[i] ?? '',
    relevance_score: 0,
    source:          'context',
  }));
}
