# git-memory

A semantic index over your Git commit history for [Claude Code](https://claude.ai/code). Gives Claude an MCP server with 5 tools to query what changed, why, and where — before it edits your code.

Node.js port of [claude-memory](https://github.com/grll/claude-memory) (Python).

---

## How it works

`git-memory` walks your Git log, filters signal-rich commits, embeds them with a local or cloud embedding model, and stores them in [ChromaDB](https://www.trychroma.com/). An MCP server exposes 5 query tools to Claude Code so it can answer "what's the history of this module?" before touching it.

```
git history → filter → embed → ChromaDB → MCP tools → Claude Code
```

---

## Requirements

- Node.js 18+
- Git repository to index
- One of the following embedding providers:
  - **Ollama** (default) — run `ollama pull nomic-embed-text` and `ollama serve`
  - **OpenAI** — set `OPENAI_API_KEY`
  - **fastembed** — fully local, no server needed

---

## Installation

```bash
npm install -g git-memory
```

Or use directly without installing:

```bash
npx git-memory index --repo-path /path/to/repo --user-id my-repo
```

---

## Quick Start

### 1. Index your repository

```bash
# Dry run first — see what will be indexed
git-memory index --repo-path /path/to/repo --user-id my-repo --dry-run

# Full index
git-memory index --repo-path /path/to/repo --user-id my-repo
```

From within the repo directory:

```bash
cd /path/to/repo
git-memory index --user-id my-repo
```

For large repos (>1000 commits), limit to recent history:

```bash
git-memory index --user-id my-repo --limit 500
```

### 2. Install the MCP server into Claude Code

```bash
git-memory install --repo-path /path/to/repo --user-id my-repo
```

This writes the MCP server config to `.claude.json` in your repo.

### 3. Restart Claude Code

The MCP tools are now available in Claude Code sessions for that repo.

---

## MCP Tools

Once installed, Claude Code has access to these 5 tools:

| Tool | Description |
|------|-------------|
| `search_git_history(query, limit, category)` | Semantic search over commit messages and metadata |
| `latest_commits(limit)` | Most recent indexed commits |
| `commits_touching_file(filename, limit)` | All commits that modified a file |
| `bug_fix_history(component, include_security)` | Bug and security fixes for a component |
| `architecture_decisions(topic, limit)` | Refactors, migrations, design decisions |

### Category filter

Pass `category=` to `search_git_history` to narrow results:

| Value | Matches |
|-------|---------|
| `fix` | Bug fixes, hotfixes, patches |
| `feat` | New features |
| `security` | Security-related changes |
| `refactor` | Code refactors |
| `migration` | Database/schema migrations |
| `arch` | Architecture decisions |
| `perf` | Performance improvements |

---

## Check status

```bash
git-memory status --repo-path /path/to/repo
```

Expected output:

```
── git-memory status ──────────────────────────
  Repo          : my-repo
  Chroma docs   : 39 (this repo) / 39 (all repos)
  Total commits : 42
  Coverage      : 93%
  Embed provider: ollama
```

---

## Configuration

All options can be set via environment variables or CLI flags.

| Environment Variable | CLI Flag | Default | Description |
|---------------------|----------|---------|-------------|
| `GIT_MEMORY_REPO_PATH` | `--repo-path` | `cwd` | Path to the Git repo |
| `GIT_MEMORY_USER_ID` | `--user-id` | `git_memory_system` | Unique ID per repo (used to namespace the index) |
| `GIT_MEMORY_EMBED_PROVIDER` | — | `ollama` | Embedding provider: `ollama`, `openai`, `fastembed` |
| `GIT_MEMORY_EMBED_MODEL` | — | `nomic-embed-text` | Embedding model name |
| `GIT_MEMORY_LLM_MODEL` | — | `qwen2.5` | LLM for context enrichment (Layer 2) |
| `OLLAMA_URL` | — | `http://localhost:11434` | Ollama server URL |
| `OPENAI_API_KEY` | — | — | Required when using OpenAI provider |
| `GIT_MEMORY_CHROMA_DIR` | — | `~/.cache/git_memory/chroma_commits` | ChromaDB storage path |
| `GIT_MEMORY_CONTEXT_DIR` | — | `~/.cache/git_memory/chroma_context` | Context store path |

### Embedding providers

**Ollama (default)**
```bash
ollama pull nomic-embed-text
ollama serve
git-memory index --user-id my-repo
```

**OpenAI**
```bash
export OPENAI_API_KEY=sk-...
export GIT_MEMORY_EMBED_PROVIDER=openai
export GIT_MEMORY_EMBED_MODEL=text-embedding-3-small
git-memory index --user-id my-repo
```

**fastembed (fully local, no server)**
```bash
export GIT_MEMORY_EMBED_PROVIDER=fastembed
# Uses BAAI/bge-small-en-v1.5 by default
git-memory index --user-id my-repo
```

---

## MCP config reference

The `install` command writes this to `.claude.json` automatically. You can also configure it manually:

```json
{
  "mcpServers": {
    "git-memory": {
      "command": "git-memory",
      "args": ["serve"],
      "env": {
        "GIT_MEMORY_REPO_PATH": "/path/to/repo",
        "GIT_MEMORY_USER_ID": "my-repo-name",
        "GIT_MEMORY_EMBED_PROVIDER": "ollama",
        "GIT_MEMORY_EMBED_MODEL": "nomic-embed-text",
        "GIT_MEMORY_LLM_MODEL": "qwen2.5",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

---

## Claude Code skills

`git-memory` ships four Claude Code skills in the `skills/` directory. These guide Claude on when and how to use the MCP tools:

| Skill | Trigger phrase |
|-------|---------------|
| `git-memory-index` | "index this repo", "set up git memory" |
| `git-memory-search` | "why was this written this way?", "find commits touching auth" |
| `git-memory-debug` | "why did this break?", "trace all changes to OrderService" |
| `git-memory-status` | "is git memory set up?", "how many commits are indexed?" |

Add this to your `CLAUDE.md` to activate them:

```markdown
When beginning any task:
1. Call `latest_commits(5)` to understand recent changes
2. Call `search_git_history(<topic>)` before editing any module
3. After fixing a bug, call `bug_fix_history(<component>)` to check for prior regressions
```

---

## Development

```bash
git clone https://github.com/YOUR_ORG/git-memory
cd git-memory
npm install

# Run CLI without building
npm run dev -- index --user-id test

# Start MCP server in dev mode
npm run serve:dev

# Build TypeScript
npm run build
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `0 commits indexed` | Run `git-memory index --repo-path .` |
| MCP tools return errors | Check Ollama is running: `ollama serve` |
| Wrong `user-id` | Must match `GIT_MEMORY_USER_ID` in MCP config |
| Search returns nothing | Confirm index has data: `git-memory status` |
| Layer 2 context missing | Normal if LLM is unavailable — Layer 1 (ChromaDB) still works |

---

## License

[AGPL-3.0-or-later](LICENSE)
