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
| `/skillers compact [--days=N]` | Analyze transcripts and extract patterns |
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

## Architecture

```
Transcripts (Claude Code, Codex CLI, OpenCode)
  ↓ /skillers compact (auto-detects installed tools)
Knowledge themes (weighted JSON, frequency + recency + cross-session)
  ↓ /skillers recommend (ecosystem-aware)
Ranked suggestions → user picks → scaffold via existing tools
```

## Part of agentsys

- https://github.com/agent-sh/agentsys
- https://agentskills.io
