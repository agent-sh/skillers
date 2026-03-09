---
name: compact
description: "Compact raw skillers observation buffers into themed knowledge files. Use when compacting session data into weighted patterns."
version: 0.1.0
argument-hint: "--scope=repo|global|both --state-dir=PATH"
---

# compact

Compact raw observation buffers into structured, weighted knowledge files.

## When to Use

Invoked by the `skillers-compactor` agent during `/skillers compact` or at session end. Also usable standalone for manual compaction.

## Arguments

Parse from `$ARGUMENTS`:

| Flag | Values | Default | Description |
|---|---|---|---|
| `--scope` | repo, global, both | repo | Which observation scope to compact |
| `--state-dir` | path | (from platform) | Override state directory |

## Workflow

### Phase 1: Resolve Paths

```javascript
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.AI_STATE_DIR || '.claude';
const scope = args.scope || 'repo';

const paths = [];
if (scope === 'repo' || scope === 'both') {
  paths.push(path.join(process.cwd(), STATE_DIR, 'skillers'));
}
if (scope === 'global' || scope === 'both') {
  paths.push(path.join(os.homedir(), STATE_DIR, 'skillers'));
}
```

### Phase 2: Read Raw Observations

For each state path:

1. Glob for `sessions/*.jsonl` files
2. Read each file line by line
3. Parse each line as JSON, skip malformed lines
4. Collect all observations into an array

Each observation has the shape:
```json
{"ts": "ISO timestamp", "t": "pain|repeat|task|wish|workflow", "v": "5 word description", "ctx": "file or area"}
```

### Phase 3: Cluster by Theme

Group observations by semantic similarity:

1. **Extract tokens** from `v` and `ctx` fields (lowercase, split on spaces and path separators)
2. **Build token frequency map** across all observations
3. **Cluster using shared tokens** - observations sharing 2+ tokens belong to the same cluster
4. **Name each cluster** using its top 2-3 tokens joined with hyphens (e.g., "auth-token-refresh")
5. **Merge small clusters** (fewer than 3 observations) into the nearest larger cluster or into an "uncategorized" theme

### Phase 4: Calculate Weights

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
  const sessions = new Set(observations.map(obs => obs.ts.split('T')[0]));
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

### Phase 5: Merge with Existing Knowledge

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
  "theme": "auth-token-refresh",
  "weight": 0.82,
  "observations": [
    {"ts": "...", "t": "pain", "v": "auth token refresh again", "ctx": "src/auth"},
    {"ts": "...", "t": "repeat", "v": "run tests after auth", "ctx": "tests/auth"}
  ],
  "sessions": 8,
  "firstSeen": "2026-02-15T...",
  "lastSeen": "2026-03-09T...",
  "totalOccurrences": 23,
  "typeCounts": {"pain": 9, "repeat": 7, "task": 4, "wish": 2, "workflow": 1}
}
```

### Phase 6: Prune

Remove entries that are:
- Older than 90 days AND weight < 0.1
- Single occurrence AND older than 30 days

### Phase 7: Archive Processed Sessions

After successful compaction:
1. Move processed `.jsonl` files to `sessions/archived/`
2. Or delete if archive is not needed (configurable)

## Output Format

Return JSON summary to the calling agent:

```json
{
  "sessionsProcessed": 3,
  "observationsProcessed": 47,
  "themesUpdated": 2,
  "themesCreated": 1,
  "themesPruned": 0,
  "themes": [
    {"name": "auth-patterns", "weight": 0.82, "observations": 23},
    {"name": "testing-workflow", "weight": 0.65, "observations": 15}
  ]
}
```

## Constraints

- MUST handle malformed JSONL lines gracefully (skip, log warning)
- MUST not lose data - archive before deleting
- MUST deduplicate observations by timestamp when merging
- MUST cap theme name length at 40 characters
- NEVER include raw sensitive data in knowledge files
