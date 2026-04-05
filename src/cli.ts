#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { simpleGit } from 'simple-git';
import { GitMemoryIndexer } from './indexer.js';
import { ChromaCommitIndex } from './chroma-index.js';
import { createEmbeddingFunction } from './embeddings.js';
import { configFromEnv } from './types.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── CLAUDE.md template ────────────────────────────────────────────────────────
const MARKER_START = '<!-- git-memory:start -->';
const MARKER_END   = '<!-- git-memory:end -->';

const CLAUDE_MD_BLOCK = `${MARKER_START}

# Git Memory System

This project uses **git-memory** — a semantic index over Git commit history for Claude Code.

## Always Start Here

When beginning any task in this repository:

1. Call \`latest_commits(5)\` to understand what changed recently
2. Call \`search_git_history(<relevant topic>)\` before touching any module with history
3. After fixing a bug, call \`bug_fix_history(<component>)\` to check for prior regressions

## Available Skills

| Task | Skill |
|------|-------|
| Search commit history for a topic | \`.claude/skills/git-memory/git-memory-search/SKILL.md\` |
| Index a new repository | \`.claude/skills/git-memory/git-memory-index/SKILL.md\` |
| Debug why a component behaves a certain way | \`.claude/skills/git-memory/git-memory-debug/SKILL.md\` |
| Check what's currently indexed | \`.claude/skills/git-memory/git-memory-status/SKILL.md\` |

## MCP Tools Reference

| Tool | What it gives you | When to use |
|------|-------------------|-------------|
| \`search_git_history(query, limit, category)\` | Commits semantically related to a topic | Before editing any significant module |
| \`latest_commits(limit)\` | N most-recent indexed commits | Session start, before investigating regressions |
| \`commits_touching_file(filename, limit)\` | All commits that modified a file | Before editing a file |
| \`bug_fix_history(component, include_security)\` | Bug/security fixes for a component | Before adding new code near known bug areas |
| \`architecture_decisions(topic, limit)\` | Refactors, migrations, design decisions | Understanding why code is structured a certain way |

## Proactive Usage Rules

**Always call before editing:**
\`\`\`
commits_touching_file("PaymentService.ts")  # know what's changed here before
bug_fix_history("auth")                      # avoid re-introducing fixed bugs
\`\`\`

**Always call at session start:**
\`\`\`
latest_commits(10)   # what changed while you were away?
\`\`\`

## Category Filter Values

Use \`category=\` in \`search_git_history()\` to narrow results:

| Category | Matches |
|----------|---------|
| \`fix\`    | Bug fixes, hotfixes, patches |
| \`feat\`   | New features |
| \`security\` | Security-related changes |
| \`refactor\` | Code refactors |
| \`migration\` | Database/schema migrations |
| \`arch\`   | Architecture decisions |
| \`perf\`   | Performance improvements |

${MARKER_END}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function installClaudeMd(repoPath: string): void {
  const mdPath = resolve(repoPath, 'CLAUDE.md');

  if (existsSync(mdPath)) {
    const existing = readFileSync(mdPath, 'utf-8');

    if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
      // Replace existing block in-place
      const pattern = new RegExp(
        escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END),
      );
      const updated = existing.replace(pattern, CLAUDE_MD_BLOCK);
      writeFileSync(mdPath, updated, 'utf-8');
      console.log(`✓ Updated git-memory block in ${mdPath}`);
    } else {
      // Prepend block to existing file
      writeFileSync(mdPath, CLAUDE_MD_BLOCK + '\n\n' + existing, 'utf-8');
      console.log(`✓ Prepended git-memory block to ${mdPath}`);
    }
  } else {
    writeFileSync(mdPath, CLAUDE_MD_BLOCK + '\n', 'utf-8');
    console.log(`✓ Created ${mdPath}`);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locate the bundled skills directory. */
function findSkillsDir(): string {
  // When running from dist/cli.js, skills/ is two levels up (project root)
  const fromDist = resolve(__dirname, '..', 'skills');
  if (existsSync(fromDist)) return fromDist;
  // When running via tsx src/cli.ts
  const fromSrc = resolve(__dirname, '..', 'skills');
  if (existsSync(fromSrc)) return fromSrc;
  throw new Error('Skills directory not found. Reinstall git-memory.');
}

/** Find the git-memory binary path. */
function findBin(): string {
  try {
    return execSync('which git-memory').toString().trim();
  } catch {
    return 'npx git-memory';
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function indexCmd(opts: {
  repoPath: string;
  userId?: string;
  branch: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<void> {
  const config = configFromEnv();
  config.repoPath = resolve(opts.repoPath);
  if (opts.userId) config.userId = opts.userId;

  const indexer = await GitMemoryIndexer.create(config);
  const stats = await indexer.indexAll({
    branch:  opts.branch,
    limit:   opts.limit,
    dryRun:  opts.dryRun,
  });

  console.log('\n── Indexing Summary ─────────────────────────────');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k.padEnd(25)} ${v}`);
  }
  console.log();
}

async function serveCmd(): Promise<void> {
  // Import and run mcp-server.ts — it has its own main()
  await import('./mcp-server.js');
}

async function storeCmd(
  commitRef: string,
  opts: { repoPath: string; userId?: string; force?: boolean },
): Promise<void> {
  const { storeCommit } = await import('./store.js');
  const stored = await storeCommit(commitRef ?? 'HEAD', {
    repoPath: resolve(opts.repoPath),
    userId:   opts.userId,
    force:    opts.force,
  });
  process.exit(stored ? 0 : 1);
}

async function statusCmd(opts: { repoPath: string }): Promise<void> {
  const repoPath = resolve(opts.repoPath);
  const config = configFromEnv();
  config.repoPath = repoPath;

  const embedFn = await createEmbeddingFunction(
    config.embedProvider, config.embedModel, config.ollamaUrl, config.openaiApiKey,
  );
  const chroma = await ChromaCommitIndex.create(config.chromaDir, embedFn);

  const git = simpleGit(repoPath);
  let totalCommits: number | string = '?';
  let repoName = basename(repoPath);
  try {
    const root = await git.revparse(['--show-toplevel']);
    repoName = basename(root.trim());
    const log = await git.log();
    totalCommits = log.total;
  } catch { /* use fallbacks */ }

  const count    = await chroma.count(repoName);
  const countAll = await chroma.count();

  console.log('\n── git-memory status ──────────────────────────');
  console.log(`  Repo          : ${repoName}`);
  console.log(`  Chroma docs   : ${count} (this repo) / ${countAll} (all repos)`);
  console.log(`  Total commits : ${totalCommits}`);
  if (typeof totalCommits === 'number' && totalCommits > 0) {
    console.log(`  Coverage      : ${Math.round(count / totalCommits * 100)}%`);
  }
  console.log(`  Embed provider: ${config.embedProvider}`);
  console.log();
}

async function installCmd(opts: {
  repoPath: string;
  userId?: string;
  skillsOnly?: boolean;
  mcpOnly?: boolean;
  index?: boolean;    // commander inverts --no-index → opts.index = false
}): Promise<void> {
  const repoPath = resolve(opts.repoPath);

  // 1. Validate git repo
  const git = simpleGit(repoPath);
  let repoRoot: string;
  try {
    repoRoot = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    console.error(`Error: ${repoPath} is not inside a Git repository.`);
    process.exit(1);
  }

  const repoName = basename(repoRoot);
  const userId   = opts.userId ?? repoName;

  // 2. Install skills
  if (!opts.mcpOnly) {
    try {
      const skillsSrc = findSkillsDir();
      const skillsDst = resolve(repoRoot, '.claude', 'skills', 'git-memory');
      mkdirSync(skillsDst, { recursive: true });

      const { readdirSync, statSync } = await import('fs');
      const installed: string[] = [];
      for (const entry of readdirSync(skillsSrc)) {
        const srcDir = resolve(skillsSrc, entry);
        if (statSync(srcDir).isDirectory()) {
          const dstDir = resolve(skillsDst, entry);
          cpSync(srcDir, dstDir, { recursive: true });
          installed.push(entry);
        }
      }
      console.log(`\n✓ Installed ${installed.length} skills to ${skillsDst}:`);
      for (const s of installed) console.log(`    ${s}/SKILL.md`);
    } catch (e) {
      console.warn(`Warning: Could not install skills: ${e}`);
    }
  }

  // 3. Configure MCP server in .claude.json
  if (!opts.skillsOnly) {
    const claudeJsonPath = resolve(repoRoot, '.claude.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(claudeJsonPath)) {
      try {
        existing = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
      } catch (e) {
        console.warn(`Warning: Existing .claude.json is malformed, preserving file and adding mcpServers: ${e}`);
      }
    }

    const mcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    mcpServers['git-memory'] = {
      command: 'git-memory',
      args: ['serve'],
      env: {
        GIT_MEMORY_REPO_PATH: repoRoot,
        GIT_MEMORY_USER_ID:   userId,
      },
    };
    existing.mcpServers = mcpServers;

    writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    console.log(`\n── MCP Server Config ──────────────────────────────`);
    console.log(`✓ Configured MCP server in ${claudeJsonPath}`);
    console.log(`\n  Repo path : ${repoRoot}`);
    console.log(`  User ID   : ${userId}`);
  }

  // 4. Update CLAUDE.md
  console.log(`\n── CLAUDE.md ──────────────────────────────────────`);
  installClaudeMd(repoRoot);

  // 5. Auto-index (unless --no-index)
  const shouldIndex = opts.index !== false;
  if (shouldIndex) {
    console.log(`\n── Indexing repository ─────────────────────────────`);
    try {
      const config = configFromEnv();
      config.repoPath = repoRoot;
      config.userId   = userId;
      const indexer = await GitMemoryIndexer.create(config);
      const stats = await indexer.indexAll({});
      console.log(
        `✓ Indexed ${stats.stored} commits ` +
        `(${stats.skipped_duplicate} duplicates, ${stats.skipped_irrelevant} irrelevant)`,
      );
    } catch (e) {
      console.warn(`Warning: Auto-indexing failed: ${e}`);
      console.warn(`  You can index manually later with: git-memory index`);
    }
  }

  console.log(`\n  Restart Claude Code to pick up the new MCP server.\n`);
}

// ── Program definition ────────────────────────────────────────────────────────

const program = new Command();

program
  .name('git-memory')
  .description('Semantic Git history index for Claude Code')
  .version('0.1.0');

program.command('index')
  .description('Bulk-index a repository commit history into ChromaDB')
  .option('--repo-path <path>', 'Path to git repository', process.cwd())
  .option('--user-id <id>', 'Namespace identifier for this repo')
  .option('--branch <branch>', 'Branch to index', 'HEAD')
  .option('--limit <n>', 'Max commits to index', (v: string) => parseInt(v, 10))
  .option('--dry-run', 'Preview without writing')
  .action(indexCmd);

program.command('serve')
  .description('Start MCP server (stdio)')
  .action(serveCmd);

program.command('store [commit-ref]')
  .description('Store a single commit (for post-commit hook). Defaults to HEAD.')
  .option('--repo-path <path>', 'Path to git repository', process.cwd())
  .option('--user-id <id>', 'Namespace identifier')
  .option('--force', 'Store even if commit message has no signal keywords')
  .action(storeCmd);

program.command('status')
  .description('Show index statistics for a repository')
  .option('--repo-path <path>', 'Path to git repository', process.cwd())
  .action(statusCmd);

program.command('install')
  .description('Install Claude Code skills + configure MCP server')
  .option('--repo-path <path>', 'Path to git repository', process.cwd())
  .option('--user-id <id>', 'Namespace identifier for this repo')
  .option('--skills-only', 'Only install skill files, skip MCP config')
  .option('--mcp-only', 'Only configure MCP server, skip skills')
  .option('--no-index', 'Skip auto-indexing after install')
  .action(installCmd);

program.parseAsync(process.argv).catch(e => {
  console.error(e);
  process.exit(1);
});
