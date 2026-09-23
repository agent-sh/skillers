# Changelog

## [0.3.0] - 2026-09-24

### Changed

- Rewrote the command, both agents and both skills for current models: goal, constraints with reasons, done criteria and the output contract. Step scripts, all-caps rule lists, a classification function and a weight function to compute by hand are gone.
- The deterministic work is `scripts/skillers.js` (`show`, `extract`, `merge`, `candidates`); the agents do the judgment only.
- Repo scope only learns from sessions whose working directory is inside the repo, instead of copying every project's patterns into a repo-local directory.

### Fixed

- Redaction could not work as documented: the compactor was told to pipe lines through `lib/sanitize.js` from its own inline code, with a relative require that resolves against the user's project, and it could read raw transcripts with its Read tool first. `extract` now redacts in the script, and the agent only reads the redacted digest.
- OpenCode sessions were never read: the documented query selected `message.content`, a column that does not exist. User text lives in `part` rows; the script reads it through `node:sqlite`.
- Newer Codex rollouts carry typed input only as user `response_item` messages; the old instructions looked only at `event_msg` `user_message`. Both are read.
- `npm test` failed on main since the compact skill was renamed to `skillers-compact`: the validator still read `skills/compact/SKILL.md`. It now checks the layout against `components.json`, and `npm test` also runs the sanitizer and script tests (the sanitizer tests never ran in CI before).
- `lib/sanitize.js` let complete JWTs and `ghu_`/`ghs_`/`ghr_` tokens through, although the 0.2.1 entry said JWTs were redacted. Both are redacted now.
- Hook scaffolds named `PostToolCall` and `PreToolCall`, which are not Claude Code hook events. The recommend skill uses real event names.
- Merging deduplicated observations by timestamp alone, dropping distinct observations logged in the same second. The key is time, session, type and text.
- Versions: plugin.json and marketplace.json said 0.1.0 while package.json said 0.2.1. All are 0.3.0.

## [0.2.1] - 2026-04-26

### Security

- Transcript compactor now routes JSONL lines through a sanitize helper (ported from consult/acp/run.js) that redacts AWS AKIA, ghp_/gho_/ghu_/ghs_, OpenAI sk-/Anthropic sk-ant-, JWTs, generic hex tokens (>=32 chars), and Shannon-entropy-detected secrets. Previously transcripts with accidentally-pasted API keys flowed unredacted into knowledge files.

## [0.2.0] - 2026-03-16

Initial tracked release.
