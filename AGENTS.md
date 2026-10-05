# skillers

## Project overview

Learns from the user's AI coding sessions and suggests skills, hooks and agents that would automate repetitive work. Part of the [agentsys](https://github.com/agent-sh/agentsys) ecosystem; skills follow https://agentskills.io.

## Conventions

- Plugin output uses the plain-text markers `[OK]`, `[ERROR]`, `[WARN]`, `[CRITICAL]`, with no emojis or ASCII art: they cost tokens and parse worse.
- Report finished work in the reply instead of adding summary, plan, audit or temp files.
- A feature or fix ships with tests for the changed behavior, and `npm test` passes before it is done.
- Changes beyond a trivial fix reach main through a PR. Run the git hooks; when one blocks, fix the cause.
- In prose, write ` - ` (a single dash with spaces), not an em dash or ` -- `.
- When a script fails, report the error, then you may do its work by hand. Reporting first is what gets broken tooling fixed.
- Model choice for agents: Opus for complex reasoning and planning, Sonnet for validation and most agents, Haiku for mechanical steps.
- Priorities, in order: experience of plugin users, worry-free automation, token efficiency, output quality, simplicity.

## Layout

- Command: `commands/skillers.md` (`show`, `compact`, `recommend`)
- Agents: `agents/skillers-compactor.md`, `agents/skillers-recommender.md`
- Skills: `skills/skillers-compact/`, `skills/recommend/`
- `scripts/skillers.js` does the deterministic work (reading transcripts, redaction, weighting, merging, the evidence bar); the agents do the judgment.
- `components.json` lists the components; `npm test` checks the layout against it.

## Commands

```bash
npm test          # layout validator, sanitizer tests, script tests
npm run validate  # layout validator only
```
