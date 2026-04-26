/**
 * Transcript sanitization for skillers.
 *
 * Conversation transcripts at `~/.claude/projects/{hash}/{session}.jsonl`,
 * `~/.codex/sessions/...`, and `~/.local/share/opencode/opencode.db` can
 * contain whatever the user pasted during a session. Users routinely paste
 * API keys, tokens, and other credentials by accident. Skillers reads these
 * transcripts into a subagent's context and writes compacted observations
 * into knowledge files under `{stateDir}/skillers/knowledge/`. Without
 * redaction, those secrets leak from ephemeral transcripts into persisted,
 * version-controllable knowledge.
 *
 * Ported from consult/acp/run.js::sanitize(). Pattern list and entropy
 * fallback kept identical so CI snapshots remain comparable.
 *
 * Usage:
 *   const { redact } = require('./lib/sanitize');
 *   for (const line of transcript) {
 *     const safe = redact(line);
 *     // ...parse and extract observations from `safe`
 *   }
 *
 * @license MIT
 */

'use strict';

const REDACTION_PATTERNS = [
  [/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/sk-proj-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/AIza[a-zA-Z0-9_-]{30,}/g, '[REDACTED_API_KEY]'],
  [/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED_TOKEN]'],
  [/gho_[a-zA-Z0-9]{36,}/g, '[REDACTED_TOKEN]'],
  [/github_pat_[a-zA-Z0-9_]{20,}/g, '[REDACTED_TOKEN]'],
  [/ANTHROPIC_API_KEY=[^\s]+/g, 'ANTHROPIC_API_KEY=[REDACTED]'],
  [/OPENAI_API_KEY=[^\s]+/g, 'OPENAI_API_KEY=[REDACTED]'],
  [/GOOGLE_API_KEY=[^\s]+/g, 'GOOGLE_API_KEY=[REDACTED]'],
  [/GEMINI_API_KEY=[^\s]+/g, 'GEMINI_API_KEY=[REDACTED]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]'],
  [/ASIA[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]'],
  [/Bearer [a-zA-Z0-9_-]{20,}/g, 'Bearer [REDACTED]'],
];

/**
 * Detect high-entropy strings that may be secrets missed by pattern matching.
 * Checks for base64-like or hex strings >= 32 chars with Shannon entropy > 4.0.
 */
function hasHighEntropy(token) {
  if (token.length < 32) return false;
  const freq = {};
  for (const ch of token) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  const len = token.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy > 4.0;
}

const HIGH_ENTROPY_PATTERN = /(?<![a-zA-Z0-9_/.-])[A-Za-z0-9+/=_-]{32,}(?![a-zA-Z0-9_/.-])/g;

function redact(text) {
  if (text == null) return text;
  // Transcripts are JSONL - callers may pass a raw line or a parsed string.
  // Coerce defensively so a numeric/boolean value from message.content doesn't crash.
  let result = typeof text === 'string' ? text : String(text);
  let redacted = false;

  // Phase 1: known patterns (blocklist).
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) redacted = true;
  }

  // Phase 2: entropy-based fallback for unknown secret formats.
  result = result.replace(HIGH_ENTROPY_PATTERN, (match) => {
    // Skip known safe patterns: file paths, URLs, model IDs, common base64 content.
    if (match.includes('/') && match.includes('.')) return match; // likely a path
    if (match.startsWith('eyJ')) return match; // JWT header (intentional content, not a secret)
    if (/^[0-9a-f]+$/i.test(match) && match.length === 40) return match; // git SHA
    if (hasHighEntropy(match)) {
      redacted = true;
      return '[REDACTED_HIGH_ENTROPY]';
    }
    return match;
  });

  return result;
}

module.exports = { redact, hasHighEntropy, REDACTION_PATTERNS, HIGH_ENTROPY_PATTERN };
