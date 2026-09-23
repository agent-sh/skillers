---
description: Learn from your workflow patterns and suggest skills, hooks, and agents. Analyze transcripts or get recommendations.
codex-description: 'Use when the user wants to learn their own workflow patterns, asks what to automate, or runs skillers show, compact or recommend. Reads past sessions and suggests skills, hooks and agents.'
argument-hint: "show|compact|recommend [--scope=repo|global|both | --global | --repo] [--days=N]"
allowed-tools: Read, Write, Bash(node:*), Bash(git:*), Task, Skill, AskUserQuestion, Glob
---

# /skillers

Find what the user does over and over in their AI coding sessions and suggest the skill, hook or agent that would take it off their hands.

## Arguments

`$ARGUMENTS`: a subcommand and optional flags.

| Subcommand | Does |
|---|---|
| `show` (default) | Status: state dir, last compaction, themes with weights, transcript counts |
| `compact` | Read recent sessions and fold the patterns into weighted knowledge files |
| `recommend` | Suggest automations from the accumulated knowledge |

| Flag | Values | Default |
|---|---|---|
| `--scope` (or `--global`, `--repo`) | `global`, `repo`, `both` | `global` |
| `--days` | positive number, `compact` only | `7` |

Global knowledge lives in `~/<stateDir>/skillers/`, repo knowledge in `<repo>/<stateDir>/skillers/`, where `<stateDir>` is `$AI_STATE_DIR` or `.claude`. Repo scope only learns from sessions that ran inside the current repo.

## The script

Everything deterministic is in `scripts/skillers.js`: reading Claude Code, Codex and OpenCode transcripts, redacting secrets, weighting, merging, pruning and the evidence bar. Run it as `node "${CLAUDE_PLUGIN_ROOT}/scripts/skillers.js" <command> [flags]`. In a harness that does not substitute `${CLAUDE_PLUGIN_ROOT}`, find the script in the plugin directory with Glob. Exit 2 means a bad argument: show the message and stop.

## show

Run the script's `show` with the flags and print its output as is.

## compact

Spawn `skillers:skillers-compactor` with the plugin root, scope and days. Without the Task tool, do the same work in this session by following the plugin's `agents/skillers-compactor.md`. Show the user the summary it returns: sessions read per tool, themes created, updated and pruned, and the top themes by weight. If it reports more pending sessions, say that another `compact` will pick them up.

## recommend

Spawn `skillers:skillers-recommender` with the plugin root and scope, or follow `agents/skillers-recommender.md` in this session without Task. When it returns recommendations, let the user choose which to build: AskUserQuestion with multi-select and a "Skip all" option, or a numbered list in plain text when that tool is missing.

Build only what the user picked, because each one changes their setup. For each pick, prefer a creation tool they already have (for example a hook or skill creator plugin) and fall back to writing the file from the recommendation's scaffold. Show the file and where it goes before writing it. If the enhance plugin is installed, offer `/enhance` on the result.

## Done

`show` printed the status. `compact` reported what changed in the knowledge files. `recommend` either built what the user picked, or said plainly why there is nothing to recommend yet (no knowledge, or no theme meets the evidence bar) and what to run next.
