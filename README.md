# skillers

Learn from your workflow patterns and suggest skills, hooks, and agents to automate repetitive work.

## How It Works

1. Work normally - your AI tool saves conversation transcripts automatically (Claude Code, Codex, OpenCode)
2. `/skillers compact` - Analyze transcripts and extract recurring patterns into weighted knowledge
3. `/skillers recommend` - Get actionable suggestions for automation

## Commands

| Command | Description |
|---|---|
| `/skillers show` | Show status, transcript stats, and knowledge themes |
| `/skillers compact [--days=N]` | Analyze transcripts and extract patterns (20 sessions per run; run again for more) |
| `/skillers recommend` | Suggest skills, hooks, and agents to create |

## What It Finds

- Pain points ("this auth flow is broken again")
- Repeated requests ("run tests after editing auth/")
- Task themes ("refactoring the login module")
- Wishes ("I wish the AI knew our API patterns")
- Workflow sequences (multi-step patterns you follow consistently)

## What It Ignores

- API keys, passwords, or secrets
- One-off tasks that won't recur
- Normal productive work without friction

## How it is built

`scripts/skillers.js` does the deterministic work: it reads Claude Code, Codex and OpenCode transcripts, redacts secrets, writes a sampled digest, and later validates, weights, merges and prunes the knowledge files and applies the evidence bar. The model does the judgment: the compactor agent reads the digest and writes observations, the recommender agent picks what is worth automating. Nothing is created without your pick.

Knowledge lives in `~/.claude/skillers/` (global) or `<repo>/.claude/skillers/` (repo scope, which only learns from sessions run inside that repo). `$AI_STATE_DIR` replaces `.claude`. Requires Node.js; reading OpenCode needs Node 22.5 or newer.

## Part of agentsys

- https://github.com/agent-sh/agentsys
- https://agentskills.io
