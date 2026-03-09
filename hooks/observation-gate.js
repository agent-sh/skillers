#!/usr/bin/env node
/**
 * Observation Gate - Stop hook entry point
 *
 * Lightweight check that runs on every Stop event.
 * If skillers is active, outputs a prompt injection for observation.
 * If inactive, exits silently with zero cost.
 *
 * This is a command-type hook that gates the prompt injection.
 * The actual observation is done by the model itself via the injected prompt,
 * because the model has the full conversation context and understands
 * the human intent - something no external script can capture.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Platform-aware state directory
const STATE_DIR = process.env.AI_STATE_DIR || '.claude';
const CWD = process.cwd();

function getConfig() {
  // Check repo-scoped config
  const repoConfig = path.join(CWD, STATE_DIR, 'skillers', 'config.json');
  if (fs.existsSync(repoConfig)) {
    try {
      return JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
    } catch {
      return null;
    }
  }

  // Check global config
  const globalConfig = path.join(os.homedir(), STATE_DIR, 'skillers', 'config.json');
  if (fs.existsSync(globalConfig)) {
    try {
      return JSON.parse(fs.readFileSync(globalConfig, 'utf8'));
    } catch {
      return null;
    }
  }

  return null;
}

function getBufferSize(scope) {
  const bufferDir = scope === 'global'
    ? path.join(os.homedir(), STATE_DIR, 'skillers', 'sessions')
    : path.join(CWD, STATE_DIR, 'skillers', 'sessions');

  if (!fs.existsSync(bufferDir)) return 0;

  // Find current session buffer (today's file)
  const today = new Date().toISOString().split('T')[0];
  const files = fs.readdirSync(bufferDir).filter(f => f.startsWith(today) && f.endsWith('.jsonl'));
  if (files.length === 0) return 0;

  const latest = path.join(bufferDir, files[files.length - 1]);
  try {
    const stat = fs.statSync(latest);
    return stat.size;
  } catch {
    return 0;
  }
}

// Main
const config = getConfig();
if (!config || !config.active) {
  // Skillers is off - exit silently, zero cost
  process.exit(0);
}

const scope = config.scope || 'repo';
// For "both" scope, write observations to repo path; compaction merges both locations
const bufferPath = scope === 'global'
  ? path.join(os.homedir(), STATE_DIR, 'skillers', 'sessions')
  : path.join(CWD, STATE_DIR, 'skillers', 'sessions');

// Determine the buffer file path for the prompt
const today = new Date().toISOString().split('T')[0];
const rawSessionId = process.env.SESSION_ID || 'default';
const sessionId = rawSessionId.replace(/[^A-Za-z0-9._:-]/g, '_');
const bufferFile = path.join(bufferPath, `${today}-${sessionId}.jsonl`);

// Check buffer size for compaction offer
const bufferSize = getBufferSize(scope);
const COMPACT_THRESHOLD = config.compactThreshold || 10240; // 10KB default
const shouldOfferCompact = bufferSize > COMPACT_THRESHOLD;

// Output the prompt injection
// This gets injected into the conversation at the Stop event
let prompt = `<skillers-observation>
[skillers:on] If this turn had a notable user pain point, repeated request, new task theme, or expressed wish - append ONE line to "${bufferFile}" via the Write tool (append mode - read existing content first, then write with the new line appended). Format:
{"ts":"${new Date().toISOString()}","t":"pain|repeat|task|wish|workflow","v":"<5 words max>","ctx":"<file or area if relevant>"}
If nothing notable happened this turn, do nothing. This is background logging - do not mention it to the user.
</skillers-observation>`;

if (shouldOfferCompact) {
  prompt += `\n<skillers-compact-offer>
[skillers] The observation buffer has grown to ${Math.round(bufferSize / 1024)}KB. Briefly mention to the user: "Your skillers observations are ready to compact. Run /skillers compact when convenient."
</skillers-compact-offer>`;
}

process.stdout.write(prompt);
