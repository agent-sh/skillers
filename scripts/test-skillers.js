#!/usr/bin/env node
// test-skillers - structural checks for the skillers plugin layout
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];
let checks = 0;

function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
}

function read(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function json(rel) {
  try { return JSON.parse(read(rel)); } catch (e) { failures.push(`${rel}: ${e.message}`); return {}; }
}

function frontmatter(text) {
  const m = text && text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const components = json('components.json');
const pkg = json('package.json');
const plugin = json('.claude-plugin/plugin.json');
const market = json('.claude-plugin/marketplace.json');

check(plugin.name === 'skillers', 'plugin.json name must be "skillers"');
check(plugin.version === pkg.version, `plugin.json version ${plugin.version} != package.json ${pkg.version}`);
check(market.version === pkg.version, `marketplace.json version ${market.version} != package.json ${pkg.version}`);
check((market.plugins || [])[0] && market.plugins[0].version === pkg.version, 'marketplace plugin entry version must match package.json');

for (const name of components.agents || []) {
  const fm = frontmatter(read(`agents/${name}.md`));
  check(fm, `agents/${name}.md must exist with frontmatter`);
  if (fm) {
    check(fm.name === name, `agents/${name}.md name must be ${name}`);
    check(fm.description, `agents/${name}.md needs a description`);
    check(fm.model, `agents/${name}.md needs a model`);
  }
}

for (const name of components.skills || []) {
  const fm = frontmatter(read(`skills/${name}/SKILL.md`));
  check(fm, `skills/${name}/SKILL.md must exist with frontmatter`);
  if (fm) {
    check(fm.name === name, `skills/${name}/SKILL.md name must be ${name}`);
    check(fm.description && fm.description.split(/\s+/).length <= 50, `skills/${name} description must exist and stay under 50 words`);
    if (fm.version) check(fm.version === pkg.version, `skills/${name} version ${fm.version} != package.json ${pkg.version}`);
  }
}

for (const name of components.commands || []) {
  check(frontmatter(read(`commands/${name}.md`)), `commands/${name}.md must exist with frontmatter`);
}

const hooks = json('hooks/hooks.json');
check(Object.keys(hooks.hooks || {}).length === 0, 'hooks.json must stay empty: skillers reads transcripts, it installs no hooks');

// Every script the prompts tell the model to run must exist.
for (const rel of ['commands/skillers.md', 'agents/skillers-compactor.md', 'agents/skillers-recommender.md']) {
  const text = read(rel) || '';
  for (const m of text.matchAll(/scripts\/([a-z-]+\.js)/g)) {
    check(fs.existsSync(path.join(root, 'scripts', m[1])), `${rel} references missing scripts/${m[1]}`);
  }
}

if (failures.length) {
  console.error('[ERROR] skillers validation failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[OK] skillers validation passed (${checks} checks)`);
