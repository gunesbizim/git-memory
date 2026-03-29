---
name: git-memory-debug
description: "Use when the user is debugging a regression, investigating unexpected behaviour, or wants to know the full change history of a component. Examples: \"why did this break after the last deploy?\", \"what changed in the auth module recently?\", \"trace all changes to OrderService\""
---

# Debug with git-memory

## When to Use

- Investigating a regression (something that worked before)
- Tracing all changes to a file or component over time
- Understanding what a recent commit actually changed
- Checking if a bug was introduced or fixed before
- Pre-flight check before a risky refactor

## Workflow

```
1. Identify the component or file the bug is in
2. Call commits_touching_file(filename) to get full change timeline
3. Call bug_fix_history(component) to find prior fixes in the same area
4. Call latest_commits(10) if the regression is recent
5. Cross-reference with GitNexus impact(symbol) if available
6. Synthesise: timeline + prior bugs + recent changes → root cause hypothesis
```

## Checklist

```
- [ ] Called commits_touching_file for the broken file
- [ ] Called bug_fix_history to find related prior regressions
- [ ] Checked latest_commits for recent changes in the area
- [ ] Noted commit hashes for the user to inspect with git show / git diff
- [ ] Cross-referenced with GitNexus if available (callers, blast radius)
```

## Tool Details

### Full file history
```
commits_touching_file("OrderService.ts", limit=20)
// Returns all commits touching the file, newest first
// in_chroma_index=true means the commit is in semantic memory
```

### Prior bugs in same area
```
bug_fix_history("orders", include_security=true, limit=10)
// Returns all fix/bug/security commits for the component
// Use this to find: "has this broken before?"
```

### What changed since last deploy
```
latest_commits(20)
// Returns 20 most recent indexed commits, newest first
// Look for commits touching the same files as the regression
```

### Pinpoint a topic
```
search_git_history("discount code removal case sensitive", category="fix")
// Finds the exact fix commit for a known bug pattern
```

## Example: Tracing a Regression

**User:** "The discount removal is broken again — it was working last week."

```
Step 1 — File history
commits_touching_file("DiscountService.ts")
→ [5e495155] 2026-03-06  fix(cart): fix discount code removal failing with case mismatch
→ [780ec1a9] 2026-03-05  feat(discounts): add cart discount code apply and remove feature

Step 2 — Prior bugs
bug_fix_history("discount")
→ [5e495155] fix(cart): fix discount code removal failing with case mismatch  score=0.717

Step 3 — Recent commits
latest_commits(10)
→ [08690c6a] 2026-03-07  chore(postman): fix cascading test failures...
→ [5e495155] 2026-03-06  fix(cart): fix discount code removal...

Conclusion: Check whether a subsequent commit reverted the .toLowerCase() call
Run: git show 5e495155 -- src/services/DiscountService.ts
```

## Combined with GitNexus

```
git-memory: bug_fix_history("payments")
→ tells you WHAT has broken here before

GitNexus: impact("PaymentService::handleCallback")
→ tells you WHAT ELSE will break if you touch it now
```

Together: full temporal + structural picture before making a change.
