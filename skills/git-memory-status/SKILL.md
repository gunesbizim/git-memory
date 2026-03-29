---
name: git-memory-status
description: "Use when the user wants to check what is indexed, how many commits are in memory, or whether git-memory is set up correctly. Examples: \"is git memory set up?\", \"how many commits are indexed?\", \"check git memory status\""
---

# Check git-memory Status

## When to Use

- User asks if git-memory is configured
- Before using search tools to confirm the index has data
- Troubleshooting empty search results
- After indexing to confirm it completed correctly

## Workflow

```
1. Run status command to check ChromaDB commit count
2. Check if MCP server is configured in .claude.json
3. Check embed provider availability
4. Report findings and any gaps
```

## Checklist

```
- [ ] ChromaDB has > 0 commits indexed
- [ ] git-memory MCP server is in .claude.json
- [ ] user-id matches between index and MCP server config
- [ ] Embed provider is available (Ollama running / OPENAI_API_KEY set)
```

## Commands

### Check index size
```bash
git-memory status --repo-path /path/to/repo
```

### Check MCP config
```bash
cat .claude.json | python3 -m json.tool | grep -A8 "git-memory"
```

### Check Ollama is running (required for default mode)
```bash
curl -s http://localhost:11434/api/tags
```

## Healthy Status Example

```
── git-memory status ──────────────────────────
  Repo          : myproject
  Chroma docs   : 39 (this repo) / 39 (all repos)
  Total commits : 42
  Coverage      : 93%
  Embed provider: ollama
```

## Common Issues

| Symptom | Fix |
|---------|-----|
| `0 commits indexed` | Run `git-memory index --repo-path .` |
| MCP tools return errors | Check Ollama is running: `ollama serve` |
| Wrong user-id | Must match `GIT_MEMORY_USER_ID` in MCP config |
| Chroma path conflict | Ensure `GIT_MEMORY_CHROMA_DIR` points to `chroma_commits/` |
| No LLM context (Layer 2) | Normal without Ollama — Layer 1 (ChromaDB) still works |
