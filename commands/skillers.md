---
description: Learn from your workflow patterns and suggest skills, hooks, and agents. Enable or disable pattern learning, analyze transcripts, or get recommendations.
codex-description: 'Use when user asks to "skillers on", "skillers off", "learn my patterns", "suggest skills", "what should I automate", "skillers recommend", "skillers compact", "skillers show". Observes workflow patterns and suggests automation.'
argument-hint: "on|off|show|compact|recommend [--scope=repo|global|both] [--days=N]"
allowed-tools: Read, Write, Bash(node:*), Bash(git:*), Task, Skill, AskUserQuestion, Glob
---

# /skillers - Workflow Pattern Learning

Analyze your conversation transcripts to find recurring patterns and suggest skills, hooks, and agents to automate repetitive work.

## Constraints

- NEVER auto-create skills/hooks/agents without user approval
- NEVER log sensitive data (API keys, passwords, secrets)
- MUST use subagents for compaction and recommendation (no context theft)
- MUST respect scope setting (repo, global, or both)
- Plain text output, no emojis

## Arguments

Parse from `$ARGUMENTS`:

| Subcommand | Description |
|---|---|
| `on` | Enable skillers for current scope |
| `off` | Disable skillers |
| `show` | Display current config and knowledge stats |
| `compact` | Analyze transcripts and extract patterns into knowledge files |
| `recommend` | Analyze accumulated knowledge and suggest automations |

| Flag | Values | Default | Description |
|---|---|---|---|
| `--scope` | repo, global, both | global | Where to store knowledge |
| `--days` | number | 7 | How many days of transcripts to analyze (compact only) |

## Platform State Directory

```javascript
const STATE_DIR = process.env.AI_STATE_DIR || '.claude';
// Repo-scoped: {CWD}/{STATE_DIR}/skillers/
// Global: ~/{STATE_DIR}/skillers/
```

## Data Source

Conversation transcripts are saved automatically by Claude Code at:
```
~/.claude/projects/{project-hash}/{session-id}.jsonl
```

No hooks or per-turn recording needed - the transcripts are the data source.

## Execution

### Parse Subcommand

```javascript
const args = '$ARGUMENTS'.trim().split(/\s+/).filter(Boolean);
const subcommand = args.find(a => ['on', 'off', 'show', 'compact', 'recommend'].includes(a)) || 'show';
const scopeFlag = args.find(a => a.startsWith('--scope='));
const scope = scopeFlag ? scopeFlag.split('=')[1] : args.includes('--global') ? 'global' : args.includes('--repo') ? 'repo' : 'global';
const days = parseInt((args.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1], 10);
```

### Subcommand: `on`

1. Determine state directory based on scope:
   - `repo`: `{CWD}/{STATE_DIR}/skillers/`
   - `global`: `~/{STATE_DIR}/skillers/`
   - `both`: write config to both locations

2. Create directory structure:
   ```
   {stateDir}/skillers/
   ├── config.json
   └── knowledge/
   ```

3. Write config:
   ```json
   {
     "active": true,
     "scope": "global",
     "createdAt": "2026-03-09T...",
     "version": "0.2.0"
   }
   ```

4. Output:
   ```
   [OK] Skillers enabled (scope: global)
   Knowledge will be saved to: {path}
   Data source: conversation transcripts (~/.claude/projects/)
   Run /skillers compact to analyze recent sessions.
   Run /skillers show to check status. Run /skillers off to disable.
   ```

### Subcommand: `off`

1. Read existing config(s) - check both repo and global
2. Set `active: false` in all found configs
3. Output: `[OK] Skillers disabled`

### Subcommand: `show`

1. Read config from repo and/or global locations
2. Count knowledge theme files and list themes with weights
3. Count available transcript files
4. Show last compaction time
5. Output:

```
Skillers Status
  Active: yes (scope: global)
  State dir: ~/.claude/skillers/

Data Source
  Transcript dirs: 5
  Total transcripts: 23
  Last compacted: 2026-03-09T15:00:00Z

Knowledge
  Theme files: 2
  Themes:
    ci-pr-workflow (weight: 0.82, 23 observations, 8 sessions)
    testing-patterns (weight: 0.65, 15 observations, 5 sessions)
```

### Subcommand: `compact`

Spawn the compactor subagent:

```
Task:
  subagent_type: "skillers:skillers-compactor"
  prompt: |
    Analyze conversation transcripts and extract workflow patterns into knowledge files.
    Scope: {scope}
    State dir: {stateDir}
    Days: {days}
    Read recent transcripts from ~/.claude/projects/,
    identify recurring patterns (pain, repeat, task, wish, workflow),
    cluster by theme, apply frequency and recency weighting,
    merge into knowledge/ files.
    MUST invoke the compact skill for implementation details.
```

After the subagent completes, show a summary of what was compacted.

### Subcommand: `recommend`

Spawn the recommender subagent:

```
Task:
  subagent_type: "skillers:skillers-recommender"
  prompt: |
    Analyze accumulated knowledge and suggest automations.
    Scope: {scope}
    State dir: {stateDir}
    Read all knowledge/ theme files, identify high-weight patterns,
    classify each as hook/skill/agent, check existing ecosystem,
    and return ranked recommendations.
    MUST invoke the recommend skill for implementation details.
```

After the subagent returns recommendations, present them via AskUserQuestion:

```
AskUserQuestion:
  questions:
    - header: "Suggestions"
      question: "Which automation would you like to create?"
      multiSelect: true
      options:
        - label: "[rec.type]: [rec.title truncated to 30 chars]"
          description: "[rec.evidence summary]"
        ...
        - label: "Skip all"
          description: "No automation needed right now"
```

For each selected recommendation:

1. Check if the user has the relevant ecosystem tools:
   - For hooks: check if `hookify` plugin exists, or fall back to manual scaffolding
   - For skills: check if `skill-creator` plugin exists, or fall back to manual scaffolding
   - For agents: scaffold manually using agentsys agent template
2. If the ecosystem tool exists, offer to use it
3. If not, offer to install it or scaffold manually
4. After creation, offer to run `/enhance` to validate (if enhance plugin exists)

## Error Handling

| Error | Response |
|---|---|
| No config found (show/compact/recommend) | `[WARN] Skillers is not enabled. Run /skillers on` |
| No transcripts found (compact) | `[OK] No conversation transcripts found` |
| Empty knowledge (recommend) | `[WARN] Not enough data yet. Run /skillers compact first` |
| Subagent failure | `[ERROR] {agent} failed: {error}. Try running /skillers compact manually` |
| Minimum evidence not met | `[OK] Patterns detected but not enough evidence yet (need 5+ occurrences across 3+ sessions)` |
