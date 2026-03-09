# skillers

Learn from your workflow patterns and suggest skills, hooks, and agents to automate repetitive work.

## How It Works

1. `/skillers on` - Enable observation (repo, global, or both scope)
2. Work normally - skillers quietly notes pain points, repeated patterns, and workflow themes
3. `/skillers compact` - Process raw observations into weighted knowledge
4. `/skillers recommend` - Get actionable suggestions for automation

## Commands

| Command | Description |
|---|---|
| `/skillers on [--scope=repo\|global\|both]` | Enable observation |
| `/skillers off` | Disable observation |
| `/skillers show` | Show status, stats, and recent observations |
| `/skillers compact` | Compact observations into knowledge themes |
| `/skillers recommend` | Suggest skills, hooks, and agents to create |

## What It Observes

- Pain points ("this auth flow is broken again")
- Repeated requests ("run tests after editing auth/")
- Task themes ("refactoring the login module")
- Wishes ("I wish the AI knew our API patterns")

## What It Does NOT Observe

- API keys, passwords, or secrets
- Mechanical tool calls without semantic meaning
- Content of files you edit

## Architecture

```
Stop hook (prompt injection, ~40 tokens/turn)
  ↓ self-filtered (only logs notable turns)
Raw session buffer (.jsonl)
  ↓ /skillers compact (subagent, no context theft)
Knowledge themes (weighted JSON)
  ↓ /skillers recommend (subagent, ecosystem-aware)
Ranked suggestions → user picks → scaffold via existing tools
```

## Part of agentsys

- https://github.com/agent-sh/agentsys
- https://agentskills.io
