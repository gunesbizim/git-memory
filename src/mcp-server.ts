#!/usr/bin/env node
/**
 * git-memory MCP server
 * Exposes 5 tools to Claude Code via stdio transport.
 * All logging goes to stderr — stdout is reserved for JSON-RPC protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { basename, dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
import { simpleGit, type SimpleGit, type DefaultLogFields } from 'simple-git';
import { ChromaCommitIndex } from './chroma-index.js';
import { ContextStore } from './context-store.js';
import { createEmbeddingFunction } from './embeddings.js';
import { configFromEnv, type CommitRecord } from './types.js';

// ── Logging (stderr only — stdout is the MCP channel) ────────────────────────
function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(' ') + '\n');
}

// ── Lazy-initialised singletons ───────────────────────────────────────────────
const config = configFromEnv();
let _chroma: ChromaCommitIndex | null = null;
let _context: ContextStore | null = null;
let _git: SimpleGit | undefined;
let _repoName: string = basename(config.repoPath);

async function getChroma(): Promise<ChromaCommitIndex> {
  if (!_chroma) {
    const embedFn = await createEmbeddingFunction(
      config.embedProvider, config.embedModel, config.ollamaUrl, config.openaiApiKey,
    );
    _chroma = await ChromaCommitIndex.create(config.chromaDir, embedFn);
    try {
      const git = simpleGit(config.repoPath);
      _repoName = basename((await git.revparse(['--show-toplevel'])).trim());
    } catch { /* keep basename fallback */ }
  }
  return _chroma;
}

async function getContext(): Promise<ContextStore | null> {
  if (_context === null) {
    try {
      const embedFn = await createEmbeddingFunction(
        config.embedProvider, config.embedModel, config.ollamaUrl, config.openaiApiKey,
      );
      _context = await ContextStore.create(config, embedFn);
    } catch (e) {
      log('ContextStore init failed (Layer 2 disabled):', e);
    }
  }
  return _context;
}

function getGit(): SimpleGit {
  if (!_git) _git = simpleGit(config.repoPath) as SimpleGit;
  return _git as SimpleGit;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Deduplicate by commit_hash, keep highest relevance_score. Matches Python _dedupe(). */
function dedup(records: CommitRecord[]): CommitRecord[] {
  const seen = new Map<string, CommitRecord>();
  for (const r of records) {
    const h = r.commit_hash ?? 'unknown';
    const existing = seen.get(h);
    if (!existing || (r.relevance_score ?? 0) > (existing.relevance_score ?? 0)) {
      seen.set(h, r);
    }
  }
  return [...seen.values()];
}

/**
 * Merge ChromaDB facts with ContextStore learned context.
 * Matches Python _merge_results() exactly.
 */
function mergeResults(chromaRecords: CommitRecord[], contextRecords: CommitRecord[]): CommitRecord[] {
  const merged = new Map<string, CommitRecord>();

  for (const r of chromaRecords) {
    merged.set(r.commit_hash ?? 'unknown', { ...r, learned_context: [] });
  }

  for (const r of contextRecords) {
    const h = r.commit_hash ?? 'unknown';
    const contextText = r.summary ?? '';
    const existing = merged.get(h);
    if (existing) {
      existing.learned_context = existing.learned_context ?? [];
      existing.learned_context.push(contextText);
    } else {
      merged.set(h, { ...r, learned_context: [contextText], source: 'context_only' });
    }
  }

  const results = [...merged.values()];
  results.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
  return results;
}

/** commitRow helper for commits_touching_file — matches Python _commit_row(). */
function commitRow(c: DefaultLogFields): CommitRecord {
  return {
    commit_hash:     c.hash,
    short_hash:      c.hash.slice(0, 8),
    author:          c.author_name,
    date:            c.date,
    category:        'general',
    files_changed:   [],
    summary:         c.message.trim(),
    relevance_score: 0,
  };
}

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Tool schemas ──────────────────────────────────────────────────────────────
const tools = [
  {
    name: 'search_git_history',
    description: 'Semantically search the indexed Git history for commits related to a topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:    { type: 'string', description: 'Natural-language description of what you are looking for' },
        limit:    { type: 'number', description: 'Max results (default 10, max 50)', default: 10 },
        category: { type: 'string', description: 'Optional filter: fix|feat|refactor|arch|perf|security|migration|general' },
      },
      required: ['query'],
    },
  },
  {
    name: 'latest_commits',
    description: 'Retrieve the most-recently indexed commits from memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Number of recent commits (default 10, max 100)', default: 10 },
      },
    },
  },
  {
    name: 'commits_touching_file',
    description: 'Find commits that modified a specific file. Partial path match supported.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: 'File path relative to repo root (partial match supported)' },
        limit:    { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
      },
      required: ['filename'],
    },
  },
  {
    name: 'bug_fix_history',
    description: 'Retrieve bug-fix and security commits related to a component or topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component:        { type: 'string', description: 'Component name, module path, or topic keyword' },
        limit:            { type: 'number', description: 'Max commits (default 15, max 100)', default: 15 },
        include_security: { type: 'boolean', description: 'Include security-category commits (default true)', default: true },
      },
      required: ['component'],
    },
  },
  {
    name: 'architecture_decisions',
    description: 'Surface architectural decision commits — refactors, migrations, design changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Optional topic to narrow the search', default: '' },
        limit: { type: 'number', description: 'Max commits (default 10, max 50)', default: 10 },
      },
    },
  },
];

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'git-memory', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {

    // ── Tool 1: search_git_history ────────────────────────────────────────────
    case 'search_git_history': {
      const { query, limit: rawLimit = 10, category } = args as { query: string; limit?: number; category?: string };
      const limit = Math.min(Math.max(1, rawLimit), 50);

      const chroma = await getChroma();
      const chromaResults = await chroma.search({ query, nResults: limit, category, repo: _repoName });

      let contextResults: CommitRecord[] = [];
      const ctx = await getContext();
      if (ctx) {
        try {
          contextResults = dedup(await ctx.search({ query, userId: config.userId, limit }));
        } catch (e) { log('ContextStore search failed:', e); }
      }

      let results = mergeResults(chromaResults, contextResults);
      if (category) results = results.filter(r => r.category === category);

      if (results.length === 0) {
        return ok([{ message: `No commits found matching '${query}'` }]);
      }
      return ok(results.slice(0, limit));
    }

    // ── Tool 2: latest_commits ────────────────────────────────────────────────
    case 'latest_commits': {
      const { limit: rawLimit = 10 } = args as { limit?: number };
      const limit = Math.min(Math.max(1, rawLimit), 100);

      const chroma = await getChroma();
      const records = await chroma.getLatest({ n: limit, repo: _repoName });

      const contextMap = new Map<string, string[]>();
      const ctx = await getContext();
      if (ctx) {
        try {
          for (const r of dedup(await ctx.getAll(config.userId))) {
            if (r.commit_hash) {
              const arr = contextMap.get(r.commit_hash) ?? [];
              arr.push(r.summary ?? '');
              contextMap.set(r.commit_hash, arr);
            }
          }
        } catch { /* ignore */ }
      }

      for (const r of records) {
        r.learned_context = contextMap.get(r.commit_hash) ?? [];
      }

      return ok(records);
    }

    // ── Tool 3: commits_touching_file ─────────────────────────────────────────
    case 'commits_touching_file': {
      const { filename, limit: rawLimit = 20 } = args as { filename: string; limit?: number };
      const limit = Math.min(Math.max(1, rawLimit), 100);
      const git = getGit();

      let gitCommits: CommitRecord[] = [];

      // 1. Exact path match (fast)
      try {
        const log = await git.log({ file: filename, maxCount: limit * 3 });
        gitCommits = log.all.map(commitRow);
      } catch { /* ignore */ }

      // 2. Fallback: basename scan across 500 recent commits
      if (gitCommits.length === 0) {
        const needle = filename.toLowerCase();
        try {
          const allLog = await git.log({ maxCount: 500 });
          for (const c of allLog.all) {
            const filesRaw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-only', c.hash]);
            if (filesRaw.toLowerCase().includes(needle)) {
              gitCommits.push(commitRow(c));
              if (gitCommits.length >= limit * 3) break;
            }
          }
        } catch (e) {
          return ok([{ error: String(e) }]);
        }
      }

      if (gitCommits.length === 0) {
        return ok([{ message: `No commits found touching '${filename}'` }]);
      }

      // 3. ChromaDB: category enrichment
      const chroma = await getChroma();
      const chromaMap = new Map(
        (await chroma.searchByFile({ filename, nResults: limit * 2, repo: _repoName }))
          .map(r => [r.commit_hash, r]),
      );

      // 4. ContextStore: learned_context enrichment
      const contextMap = new Map<string, string[]>();
      const ctx = await getContext();
      if (ctx) {
        try {
          for (const r of dedup(await ctx.search({ query: `changes to ${filename}`, userId: config.userId, limit: 50 }))) {
            if (r.commit_hash) {
              const arr = contextMap.get(r.commit_hash) ?? [];
              arr.push(r.summary ?? '');
              contextMap.set(r.commit_hash, arr);
            }
          }
        } catch { /* ignore */ }
      }

      // 5. Enrich and return
      const enriched = gitCommits.slice(0, limit).map(gc => ({
        ...gc,
        category:        chromaMap.get(gc.commit_hash)?.category ?? 'general',
        in_chroma_index: chromaMap.has(gc.commit_hash),
        learned_context: contextMap.get(gc.commit_hash) ?? [],
      }));

      return ok(enriched);
    }

    // ── Tool 4: bug_fix_history ───────────────────────────────────────────────
    case 'bug_fix_history': {
      const { component, limit: rawLimit = 15, include_security = true } = args as {
        component: string; limit?: number; include_security?: boolean;
      };
      const limit = Math.min(Math.max(1, rawLimit), 100);

      const targetCategories = new Set(['fix', 'bug', 'hotfix', 'patch', 'revert']);
      if (include_security) targetCategories.add('security');

      const chroma = await getChroma();
      const chromaResults: CommitRecord[] = [];
      for (const cat of targetCategories) {
        chromaResults.push(
          ...await chroma.search({ query: `${component} ${cat}`, nResults: limit, category: cat, repo: _repoName }),
        );
      }

      let contextResults: CommitRecord[] = [];
      const ctx = await getContext();
      if (ctx) {
        try {
          for (const q of [`bug fix ${component}`, `security ${component}`]) {
            contextResults.push(...await ctx.search({ query: q, userId: config.userId, limit: 20 }));
          }
        } catch (e) { log('ContextStore bug_fix search failed:', e); }
      }

      const merged = mergeResults(chromaResults, dedup(contextResults));
      let filtered = merged.filter(r => targetCategories.has(r.category));
      if (filtered.length < 3) filtered = merged;

      if (filtered.length === 0) {
        return ok([{ message: `No bug-fix history found for component '${component}'` }]);
      }
      return ok(filtered.slice(0, limit));
    }

    // ── Tool 5: architecture_decisions ───────────────────────────────────────
    case 'architecture_decisions': {
      const { topic = '', limit: rawLimit = 10 } = args as { topic?: string; limit?: number };
      const limit = Math.min(Math.max(1, rawLimit), 50);

      // Python uses 5 categories: arch, architecture, refactor, migration, redesign
      const archCategories = new Set(['arch', 'architecture', 'refactor', 'migration', 'redesign']);
      const query = `architecture design decision ${topic}`.trim();

      const chroma = await getChroma();

      // Pass 1: category-filtered
      const chromaArch: CommitRecord[] = [];
      for (const cat of archCategories) {
        chromaArch.push(...await chroma.search({ query, nResults: limit, category: cat, repo: _repoName }));
      }

      // Pass 2: broad semantic (catches significant feat commits)
      const chromaBroad = await chroma.search({ query, nResults: limit, repo: _repoName });
      const archHashes = new Set(chromaArch.map(r => r.commit_hash));
      const chromaResults = [
        ...chromaArch,
        ...chromaBroad.filter(r => !archHashes.has(r.commit_hash)),
      ];

      let contextResults: CommitRecord[] = [];
      const ctx = await getContext();
      if (ctx) {
        try {
          contextResults = dedup(await ctx.search({ query, userId: config.userId, limit: limit * 2 }));
        } catch (e) { log('ContextStore arch search failed:', e); }
      }

      const merged = mergeResults(chromaResults, contextResults);
      const archFirst = merged.filter(r => archCategories.has(r.category));
      const others    = merged.filter(r => !archCategories.has(r.category));
      const combined  = [...archFirst, ...others].slice(0, limit);

      if (combined.length === 0) {
        return ok([{ message: 'No architectural commits found' }]);
      }
      return ok(combined);
    }

    default:
      return ok([{ error: `Unknown tool: ${name}` }]);
  }
});

// ── Entry point ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`git-memory MCP server started (repo: ${config.repoPath}, user: ${config.userId})`);
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e}\n`);
  process.exit(1);
});
