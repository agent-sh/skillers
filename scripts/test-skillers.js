#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function assertContains(text, pattern, message, failures) {
  assertionCount++;
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function assertNotContains(text, pattern, message, failures) {
  assertionCount++;
  if (pattern.test(text)) {
    failures.push(message);
  }
}

function assertFileExists(relPath, message, failures) {
  assertionCount++;
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    failures.push(message);
  }
}

function assertFileNotExists(relPath, message, failures) {
  assertionCount++;
  const full = path.join(root, relPath);
  if (fs.existsSync(full)) {
    failures.push(message);
  }
}

const failures = [];
let assertionCount = 0;

// --- File existence checks ---

const requiredFiles = [
  ['.claude-plugin/plugin.json', 'plugin.json must exist'],
  ['components.json', 'components.json must exist'],
  ['package.json', 'package.json must exist'],
  ['hooks/hooks.json', 'hooks/hooks.json must exist'],
  ['commands/skillers.md', 'commands/skillers.md must exist'],
  ['agents/skillers-compactor.md', 'skillers-compactor agent must exist'],
  ['agents/skillers-recommender.md', 'skillers-recommender agent must exist'],
  ['skills/compact/SKILL.md', 'compact skill must exist'],
  ['skills/recommend/SKILL.md', 'recommend skill must exist'],
];

for (const [filePath, message] of requiredFiles) {
  assertFileExists(filePath, message, failures);
}

// --- Removed files (Stop hook approach replaced by transcript analysis) ---

assertFileNotExists('hooks/observation-gate.js', 'observation-gate.js must NOT exist (replaced by transcript analysis)', failures);

// --- plugin.json ---

function parseJson(filePath, label) {
  try {
    return JSON.parse(read(filePath));
  } catch (e) {
    failures.push(`Failed to parse ${label}: ${e.message}`);
    return null;
  }
}

const pluginJson = parseJson('.claude-plugin/plugin.json', 'plugin.json');
if (pluginJson && pluginJson.name !== 'skillers') {
  failures.push('plugin.json name must be "skillers"');
}

// --- components.json ---

const components = parseJson('components.json', 'components.json');
if (components) {
  if (!components.agents || !components.agents.includes('skillers-compactor')) {
    failures.push('components.json must include skillers-compactor agent');
  }
  if (!components.agents || !components.agents.includes('skillers-recommender')) {
    failures.push('components.json must include skillers-recommender agent');
  }
  if (!components.skills || !components.skills.includes('compact')) {
    failures.push('components.json must include compact skill');
  }
  if (!components.skills || !components.skills.includes('recommend')) {
    failures.push('components.json must include recommend skill');
  }
  if (!components.commands || !components.commands.includes('skillers')) {
    failures.push('components.json must include skillers command');
  }
}

// --- hooks.json must be empty (no hooks) ---

const hooksJson = parseJson('hooks/hooks.json', 'hooks.json');
if (hooksJson) {
  const hookKeys = Object.keys(hooksJson.hooks || {});
  if (hookKeys.length > 0) {
    failures.push('hooks.json must have empty hooks (no Stop hook - transcript analysis replaces it)');
  }
}

// --- command file ---

const command = read('commands/skillers.md');
assertContains(command, /on\|off\|show\|compact\|recommend/, 'command must support all 5 subcommands', failures);
assertContains(command, /--scope/, 'command must support scope flag', failures);
assertContains(command, /subagent_type/, 'command must spawn subagents for compact/recommend', failures);
assertContains(command, /AskUserQuestion/, 'command must use AskUserQuestion for recommendations', failures);
assertContains(command, /multiSelect/, 'command must support multi-select for recommendations', failures);
assertContains(command, /hookify/, 'command must check for hookify plugin', failures);
assertContains(command, /skill-creator/, 'command must check for skill-creator plugin', failures);
assertContains(command, /enhance/, 'command must offer enhance validation', failures);
assertContains(command, /NEVER auto-create/, 'command must require user approval', failures);
assertContains(command, /NEVER log sensitive data/, 'command must prohibit logging sensitive data', failures);
assertContains(command, /\.claude\/projects/, 'command must reference transcript location', failures);
assertNotContains(command, /observation-gate/, 'command must not reference observation-gate (removed)', failures);

// --- compactor agent ---

const compactor = read('agents/skillers-compactor.md');
assertContains(compactor, /model: sonnet/, 'compactor must use sonnet model', failures);
assertContains(compactor, /compact/, 'compactor must reference compact skill', failures);
assertContains(compactor, /Skill/, 'compactor must have Skill in tools', failures);
assertContains(compactor, /MUST invoke the compact skill/, 'compactor must require skill invocation', failures);
assertContains(compactor, /malformed JSONL/, 'compactor must handle malformed data', failures);
assertContains(compactor, /transcript/, 'compactor must reference transcripts as data source', failures);
assertNotContains(compactor, /observation-gate/, 'compactor must not reference observation-gate (removed)', failures);

// --- recommender agent ---

const recommender = read('agents/skillers-recommender.md');
assertContains(recommender, /model: opus/, 'recommender must use opus model', failures);
assertContains(recommender, /recommend/, 'recommender must reference recommend skill', failures);
assertContains(recommender, /Skill/, 'recommender must have Skill in tools', failures);
assertContains(recommender, /MUST invoke the recommend skill/, 'recommender must require skill invocation', failures);
assertContains(recommender, /5\+ occurrences/, 'recommender must enforce minimum evidence', failures);
assertContains(recommender, /3\+ sessions/, 'recommender must enforce cross-session threshold', failures);
assertContains(recommender, /NEVER suggest creating something that already exists/, 'recommender must check existing ecosystem', failures);
assertContains(recommender, /Anti-Pattern Detection/, 'recommender must include anti-pattern rules', failures);

// --- compact skill ---

const compactSkill = read('skills/compact/SKILL.md');
assertContains(compactSkill, /frequency.*recency.*cross-session/si, 'compact skill must define all weight components', failures);
assertContains(compactSkill, /30-day half-life/, 'compact skill must specify recency decay', failures);
assertContains(compactSkill, /pain.*boost/i, 'compact skill must include pain boost', failures);
assertContains(compactSkill, /Prune/, 'compact skill must include pruning phase', failures);
assertContains(compactSkill, /MUST handle malformed JSONL/, 'compact skill must handle malformed data', failures);
assertContains(compactSkill, /\.claude\/projects/, 'compact skill must reference transcript location', failures);
assertContains(compactSkill, /lastCompactedAt/, 'compact skill must track last compaction time', failures);
assertContains(compactSkill, /NEVER include raw sensitive data/, 'compact skill must prohibit sensitive data', failures);
assertNotContains(compactSkill, /observation-gate/, 'compact skill must not reference observation-gate (removed)', failures);
assertNotContains(compactSkill, /sessions\/\*\.jsonl/, 'compact skill must not reference session JSONL buffers (removed)', failures);

// --- recommend skill ---

const recommendSkill = read('skills/recommend/SKILL.md');
assertContains(recommendSkill, /Evidence Thresholds/, 'recommend skill must define evidence thresholds', failures);
assertContains(recommendSkill, /Classify.*Primitive/s, 'recommend skill must classify primitives', failures);
assertContains(recommendSkill, /Check Existing Ecosystem/, 'recommend skill must check ecosystem', failures);
assertContains(recommendSkill, /hook.*skill.*agent/is, 'recommend skill must cover all three primitives', failures);
assertContains(recommendSkill, /workflowRatio/, 'recommend skill must define classification ratios', failures);
assertContains(recommendSkill, /Maximum 5 recommendations/, 'recommend skill must cap recommendations', failures);
assertContains(recommendSkill, /NEVER make generic suggestions/, 'recommend skill must prohibit generic suggestions', failures);
assertContains(recommendSkill, /Observation Sanitization/, 'recommend skill must include observation sanitization section', failures);
assertContains(recommendSkill, /NEVER embed raw observation text into shell commands/, 'recommend skill must prohibit raw observation in commands', failures);
assertContains(recommendSkill, /scaffold/i, 'recommend skill must include scaffold specs', failures);

// --- Results ---

if (failures.length > 0) {
  console.error('[ERROR] skillers validation failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('[OK] skillers validation passed (' + requiredFiles.length + ' files, ' + assertionCount + ' assertions)');
