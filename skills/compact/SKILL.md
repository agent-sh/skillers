---
name: compact
description: "Compact conversation transcripts into themed knowledge files. Use when compacting transcript data into weighted patterns."
version: 0.2.0
argument-hint: "--scope=repo|global|both --state-dir=PATH --days=N"
---

# compact

Extract workflow patterns from conversation transcripts and compact into structured, weighted knowledge files.

## When to Use

Invoked by the `skillers-compactor` agent during `/skillers compact`. Also usable standalone for manual compaction.

## Arguments

Parse from `$ARGUMENTS`:

| Flag | Values | Default | Description |
|---|---|---|---|
| `--scope` | repo, global, both | global | Which knowledge scope to write to |
| `--state-dir` | path | (from platform) | Override state directory |
| `--days` | number | 7 | How many days of transcripts to analyze |

## Data Sources

Skillers reads conversation transcripts from multiple AI tools. Detect which tools are installed and read from all available sources.

### Claude Code

Location: `~/.claude/projects/{project-hash}/{session-id}.jsonl`

The project hash is derived from the CWD with path separators replaced by dashes. Each transcript is a JSONL file with entries of type: `user`, `assistant`, `system`, `progress`, `file-history-snapshot`.

```json
{
  "type": "user",
  "message": { "role": "user", "content": "the user message" },
  "timestamp": "2026-03-09T14:25:05.135Z",
  "sessionId": "uuid",
  "cwd": "/path/to/project"
}
```

### Codex CLI

Location: `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{uuid}.jsonl`

Sessions are organized by date. Each JSONL file starts with a `session_meta` entry, followed by `response_item` and `event_msg` entries. User messages have `type: "event_msg"` with `payload.type: "user_message"`.

```json
{"timestamp":"...","type":"session_meta","payload":{"id":"uuid","cwd":"...","cli_version":"0.77.0"}}
{"timestamp":"...","type":"event_msg","payload":{"type":"user_message","message":"the user message"}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
```

Also available: `~/.codex/history.jsonl` - compact log with only user inputs per session:
```json
{"session_id":"uuid","ts":1767723836,"text":"the user message"}
```

### OpenCode

Location: `~/.local/share/opencode/opencode.db` (SQLite)

Tables: `project`, `session`, `message`. Query sessions and messages with SQL.

```sql
SELECT s.id, s.slug, m.time_created, m.content
FROM session s JOIN message m ON m.session_id = s.id
WHERE m.time_created > {cutoff_timestamp}
ORDER BY m.time_created;
```

Also available: `~/.local/state/opencode/prompt-history.jsonl` - user input history only:
```json
{"input":"the user message","parts":[],"mode":"normal"}
```

On Windows the DB may also be at `%APPDATA%/opencode/opencode.db`.

### Cursor

Cursor does not store conversation history in an accessible local format. Skip this tool during compaction. If a readable format becomes available, add support here.

### Kiro

Kiro session storage format is not yet documented. If `~/.kiro/sessions/` or similar exists with readable files, attempt to parse them. Otherwise skip.

### Detection Logic

```javascript
const sources = [];

// Claude Code
const claudeDir = path.join(os.homedir(), '.claude', 'projects');
if (fs.existsSync(claudeDir)) sources.push({ tool: 'claude-code', type: 'jsonl', path: claudeDir });

// Codex CLI
const codexDir = path.join(os.homedir(), '.codex', 'sessions');
if (fs.existsSync(codexDir)) sources.push({ tool: 'codex', type: 'jsonl', path: codexDir });

// OpenCode (SQLite)
const opencodePaths = [
  path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  path.join(process.env.APPDATA || '', 'opencode', 'opencode.db')
];
for (const p of opencodePaths) {
  if (fs.existsSync(p)) { sources.push({ tool: 'opencode', type: 'sqlite', path: p }); break; }
}

console.log(`[OK] Found ${sources.length} transcript source(s): ${sources.map(s => s.tool).join(', ')}`);
```

## Workflow

### Phase 1: Resolve Paths

```javascript
const os = require('os');
const path = require('path');
const fs = require('fs');

const STATE_DIR = process.env.AI_STATE_DIR || '.claude';
const scope = args.scope || 'global';
const days = args.days || 7;

// Knowledge output directories
const globalDir = path.join(os.homedir(), STATE_DIR, 'skillers', 'knowledge');
const repoDir = path.join(process.cwd(), STATE_DIR, 'skillers', 'knowledge');
const knowledgeDirs = scope === 'both' ? [globalDir, repoDir]
  : scope === 'global' ? [globalDir] : [repoDir];

// Transcript sources (detect all installed tools)
const sources = [];
const claudeDir = path.join(os.homedir(), '.claude', 'projects');
if (fs.existsSync(claudeDir)) sources.push({ tool: 'claude-code', type: 'jsonl', path: claudeDir });
const codexDir = path.join(os.homedir(), '.codex', 'sessions');
if (fs.existsSync(codexDir)) sources.push({ tool: 'codex', type: 'jsonl', path: codexDir });
const opencodePaths = [
  path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  path.join(process.env.APPDATA || '', 'opencode', 'opencode.db')
];
for (const p of opencodePaths) {
  if (fs.existsSync(p)) { sources.push({ tool: 'opencode', type: 'sqlite', path: p }); break; }
}
```

### Phase 2: Find and Read Transcripts

For each detected source, collect transcripts using the appropriate method:

**Claude Code** (JSONL):
1. List directories under `~/.claude/projects/`
2. For each project directory, find `.jsonl` transcript files
3. Filter by modification time: only files modified within the last `--days` days
4. Extract entries with `type: "user"` and `type: "assistant"`

**Codex CLI** (JSONL):
1. Walk `~/.codex/sessions/{YYYY}/{MM}/{DD}/` date directories
2. Find `.jsonl` files within the date range
3. Extract `session_meta` for session context (cwd, cli_version)
4. Extract `event_msg` entries with `payload.type: "user_message"` for user messages
5. Extract `response_item` entries with `payload.role: "assistant"` for tool usage patterns

**OpenCode** (SQLite):
1. Open `opencode.db` with a SQLite reader (Bash: `sqlite3` or node `better-sqlite3`)
2. Query sessions with messages in the date range
3. Read message content from the `message` table joined with `session`
4. Normalize into the same observation extraction format

**Common for all sources:**
- Read the skillers config to check `lastCompactedAt` - skip already-processed transcripts
- Record the session ID, source tool, and timestamp for each entry
- Tag observations with `source: "claude-code" | "codex" | "opencode"` for traceability

### Phase 3: Extract Observations

For each transcript, analyze the conversation to identify:

| Type | Signal | Example |
|---|---|---|
| `pain` | User expresses frustration, mentions something failing, retries | "this broke again", "why does X keep happening" |
| `repeat` | User asks for the same type of task across sessions | "run tests", "check CI", "create PR" |
| `task` | User works on a recurring task type | "refactor auth", "update docs", "fix flaky test" |
| `wish` | User expresses desire for automation or tooling | "I wish this was automatic", "there should be a command for this" |
| `workflow` | User follows a consistent multi-step pattern | "first X, then Y, then Z" every time |

For each identified pattern, create an observation:
```json
{"ts": "ISO timestamp", "t": "pain|repeat|task|wish|workflow", "v": "5 word description", "ctx": "file or area", "session": "session-id", "source": "claude-code|codex|opencode"}
```

**Critical**: Extract observations based on actual conversation content. Focus on:
- Tasks the user performs repeatedly across different sessions
- Pain points expressed through retries, frustration, or workarounds
- Multi-step workflows that follow the same sequence
- Explicit wishes for automation

**Do NOT create observations for**:
- One-off tasks that won't recur
- Normal productive work without friction
- Sensitive data (API keys, passwords, credentials, PII)

### Phase 4: Cluster by Theme

Group observations by semantic similarity:

1. **Extract tokens** from `v` and `ctx` fields (lowercase, split on spaces and path separators)
2. **Build token frequency map** across all observations
3. **Cluster using shared tokens** - observations sharing 2+ tokens belong to the same cluster
4. **Name each cluster** using its top 2-3 tokens joined with hyphens (e.g., "ci-pr-workflow")
5. **Merge small clusters** (fewer than 3 observations) into the nearest larger cluster or into an "uncategorized" theme

### Phase 5: Calculate Weights

For each theme cluster, calculate a composite weight:

```javascript
function calculateWeight(observations) {
  const now = Date.now();

  // Frequency: more observations = higher weight
  const frequency = Math.min(observations.length / 20, 1.0); // Cap at 20

  // Recency: recent observations weigh more (exponential decay, 30-day half-life)
  const recencyScores = observations.map(obs => {
    const ageMs = now - new Date(obs.ts).getTime();
    const ageDays = ageMs / 86400000;
    return Math.exp(-0.693 * ageDays / 30); // 0.693 = ln(2)
  });
  const recency = recencyScores.reduce((a, b) => a + b, 0) / observations.length;

  // Cross-session: patterns across multiple sessions weigh disproportionately more
  const sessions = new Set(observations.map(obs => obs.session));
  const crossSession = Math.min(sessions.size / 5, 1.0); // Cap at 5 sessions

  // Pain intensity: "pain" and "wish" types weigh more
  const painCount = observations.filter(obs => obs.t === 'pain' || obs.t === 'wish').length;
  const painBoost = painCount > 0 ? 1.0 + (painCount / observations.length) * 0.5 : 1.0;

  // Composite weight
  const raw = (frequency * 0.3 + recency * 0.3 + crossSession * 0.4) * painBoost;
  return Math.round(Math.min(raw, 1.0) * 100) / 100;
}
```

Weight components:
- **Frequency (30%)**: How often this pattern appears
- **Recency (30%)**: Newer observations weigh more (30-day half-life)
- **Cross-session (40%)**: Patterns spanning multiple sessions are the strongest signal
- **Pain boost**: Patterns tagged as "pain" or "wish" get up to 50% boost

### Phase 6: Merge with Existing Knowledge

For each theme:

1. Check if `knowledge/{theme-name}.json` already exists
2. If exists:
   - Read existing file
   - Merge observation lists (deduplicate by timestamp)
   - Recalculate weight with merged data
   - Update `lastSeen` and `sessions` count
3. If new: create the file

Knowledge file format:
```json
{
  "theme": "ci-pr-workflow",
  "weight": 0.82,
  "observations": [
    {"ts": "...", "t": "repeat", "v": "create PR check CI", "ctx": "github", "session": "abc", "source": "claude-code"},
    {"ts": "...", "t": "workflow", "v": "merge after CI pass", "ctx": "github", "session": "def", "source": "codex"}
  ],
  "sessions": 8,
  "firstSeen": "2026-02-15T...",
  "lastSeen": "2026-03-09T...",
  "totalOccurrences": 23,
  "typeCounts": {"pain": 2, "repeat": 12, "task": 4, "wish": 1, "workflow": 4}
}
```

### Phase 7: Prune

Remove entries that are:
- Older than 90 days AND weight < 0.1
- Single occurrence AND older than 30 days

### Phase 8: Update Config

After successful compaction, update the skillers config:

```json
{
  "lastCompactedAt": "2026-03-09T22:30:00.000Z",
  "lastTranscriptsProcessed": ["session-id-1", "session-id-2"]
}
```

This prevents re-processing the same transcripts on next compact.

## Output Format

Return JSON summary to the calling agent:

```json
{
  "sources": {
    "claude-code": {"transcripts": 12, "observations": 35},
    "codex": {"transcripts": 8, "observations": 12},
    "opencode": {"sessions": 3, "observations": 5}
  },
  "totalTranscripts": 23,
  "totalObservations": 52,
  "themesUpdated": 2,
  "themesCreated": 1,
  "themesPruned": 0,
  "themes": [
    {"name": "ci-pr-workflow", "weight": 0.82, "observations": 23},
    {"name": "testing-patterns", "weight": 0.65, "observations": 15}
  ]
}
```

## Constraints

- MUST detect and read from all installed AI tools (Claude Code, Codex, OpenCode)
- MUST handle malformed JSONL lines and missing DB tables gracefully (skip, log warning)
- MUST deduplicate observations by timestamp when merging
- MUST cap theme name length at 40 characters
- MUST update lastCompactedAt after successful compaction
- MUST skip transcripts already processed (check lastCompactedAt)
- NEVER include raw sensitive data in knowledge files
- NEVER create observations from one-off tasks
- NEVER read more than 20 transcripts at once (cap for token efficiency)
- NEVER read more than 500 lines from a single transcript - sample the first 200 and last 300 lines for long sessions
