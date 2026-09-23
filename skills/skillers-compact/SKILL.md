---
name: skillers-compact
description: Use when compacting AI coding session transcripts into skillers knowledge, or when writing skillers observations. Defines observation types and the knowledge file format.
version: 0.3.0
argument-hint: "--scope=repo|global|both --days=N"
---

# skillers-compact

Reference for turning session digests into observations. The `skillers-compactor` agent runs the steps; this file says what a good observation is and what the script does with it. Standalone use follows the same steps: `node <plugin root>/scripts/skillers.js extract $ARGUMENTS`, write observations, `merge --dry-run`, then `merge`.

## What the script reads

`extract` reads sessions changed in the last `--days` days from every tool it finds:

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl`, user text blocks and tool-use names.
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `session_meta` for cwd, user input from `event_msg` `user_message` (older rollouts) or user `response_item` messages (newer ones), function and custom tool calls.
- OpenCode: `~/.local/share/opencode/opencode.db` (or `%APPDATA%/opencode/opencode.db`), sessions joined with user text parts and tool parts. Needs Node 22.5 or newer for `node:sqlite`; older Node skips OpenCode with a note.

Every message passes through `lib/sanitize.js` before it is written, and harness-injected context (task notifications, environment blocks, AGENTS.md preambles) is dropped. Slash commands and typed shell input stay, since they are the user's own actions. At most 20 unprocessed sessions go into one digest, newest first, each sampled to its first 20 and last 40 user messages of up to 600 characters. The rest wait for the next run.

## Observations

An observation is one recurring thing the user does or feels, worth remembering because it could be automated:

| `t` | Signal |
|---|---|
| `pain` | frustration, retries, something that keeps breaking |
| `repeat` | the same kind of request across sessions ("check CI", "run the tests") |
| `task` | a recurring type of work ("update the changelog", "fix a flaky test") |
| `wish` | an explicit wish for automation or tooling |
| `workflow` | the same multi-step sequence each time |

Normal productive work without friction, one-off tasks and anything sensitive are not observations. One session showing a thing once is weak evidence; the weighting rewards the same pattern across sessions.

Fields:

```json
{"ts": "2026-09-20T14:25:05Z", "t": "repeat", "v": "run tests after auth edit", "ctx": "src/auth", "session": "<id from the digest>", "theme": "auth-testing"}
```

`v` is a short paraphrase (up to 8 words, about 5 is typical), `ctx` a file, area or tool, `session` must be a session id from the digest, and `ts` the time of the message it came from. Themes are short kebab-case names (40 characters at most); reuse a name from `existingThemes` when the pattern belongs there. The script rejects unknown types or sessions, missing fields and shell syntax (`$(`, backticks, pipes, `;`, `&&`, redirects) in `v` or `ctx`.

## What merge does

For each scope target (global always gets everything; repo only gets sessions whose cwd is inside the repo), merge:

- skips sessions that target already processed, dedupes on time, session, type and text, and keeps the newest 200 observations per theme;
- computes the weight: `(0.3 * frequency + 0.3 * recency + 0.4 * cross-session) * pain boost`, capped at 1, where frequency is observations / 20 (max 1), recency is the mean of a 30-day half-life decay, cross-session is distinct sessions / 5 (max 1), and the pain boost is `1 + 0.5 * (pain + wish share)`;
- recomputes untouched themes so weights decay between runs, and deletes themes last seen over 90 days ago with weight under 0.1, or with a single observation last seen over 30 days ago;
- writes `knowledge/<theme>.json` and records `lastCompactedAt` and the processed session ids in `config.json`.

Knowledge file:

```json
{"theme": "auth-testing", "weight": 0.82, "observations": [...], "sessions": 8, "firstSeen": "...", "lastSeen": "...", "totalOccurrences": 23, "typeCounts": {"pain": 2, "repeat": 12, "task": 4, "wish": 1, "workflow": 4}}
```
