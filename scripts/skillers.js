#!/usr/bin/env node
// skillers - read transcripts, keep weighted workflow knowledge, list recommendation candidates
'use strict';

/**
 * Deterministic half of /skillers. The model judges what a conversation
 * shows (observations, theme names, which primitive fits); this script does
 * everything else.
 *
 *   show        [--scope S]            status as text
 *   extract     [--scope S] [--days N] redacted digest of recent sessions -> JSON file
 *   merge       --input FILE [--scope S] [--dry-run] validate observations, weight, merge, prune
 *   candidates  [--scope S]            themes that meet the evidence bar + installed inventory
 *
 * Scope: global (default) = ~/<stateDir>/skillers, repo = <cwd>/<stateDir>/skillers,
 * both = the two. <stateDir> is $AI_STATE_DIR or .claude. Repo scope only
 * takes sessions whose working directory is inside the current repo.
 *
 * Exit codes: 0 ok, 2 bad arguments or bad input file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('../lib/sanitize');

const SCOPES = ['global', 'repo', 'both'];
const TYPES = ['pain', 'repeat', 'task', 'wish', 'workflow'];
const DAY_MS = 86400000;

// Limits that keep one run inside a model's working context. Sessions past the
// cap stay unprocessed and are picked up by the next run.
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 60; // first 20 + last 40 user messages
const MAX_MESSAGE_CHARS = 600;
const MAX_OBSERVATIONS_PER_THEME = 200;
const MAX_PROCESSED_IDS = 2000;

// Evidence bar for a recommendation.
const MIN_OCCURRENCES = 5;
const MIN_SESSIONS = 3;
const MIN_WEIGHT = 0.2;

class UsageError extends Error {}

// ─── Arguments and paths ────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { command: null, scope: 'global', days: 7, input: null, dryRun: false };
  const take = (i, name) => {
    const arg = argv[i];
    if (arg.includes('=')) return [arg.slice(arg.indexOf('=') + 1), i];
    if (argv[i + 1] === undefined) throw new UsageError(`${name} needs a value`);
    return [argv[i + 1], i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--global' || arg === '--repo') {
      out.scope = arg.slice(2);
    } else if (arg === '--scope' || arg.startsWith('--scope=')) {
      [out.scope, i] = take(i, '--scope');
      if (!SCOPES.includes(out.scope)) throw new UsageError(`--scope must be one of: ${SCOPES.join(', ')}`);
    } else if (arg === '--days' || arg.startsWith('--days=')) {
      let v;
      [v, i] = take(i, '--days');
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError('--days must be a positive whole number');
      out.days = Number(v);
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--input' || arg.startsWith('--input=')) {
      [out.input, i] = take(i, '--input');
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown flag ${arg}`);
    } else if (out.command === null) {
      out.command = arg;
    } else {
      throw new UsageError(`unexpected argument ${arg}`);
    }
  }
  out.command = out.command || 'show';
  if (!['show', 'extract', 'merge', 'candidates'].includes(out.command)) {
    throw new UsageError(`unknown command ${out.command}. Commands: show, extract, merge, candidates`);
  }
  if (out.command === 'merge' && !out.input) throw new UsageError('merge needs --input <observations.json>');
  return out;
}

function stateDirName() {
  return process.env.AI_STATE_DIR || '.claude';
}

function repoRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

function targets(scope, cwd = process.cwd()) {
  const global = { scope: 'global', dir: path.join(os.homedir(), stateDirName(), 'skillers') };
  const repo = { scope: 'repo', dir: path.join(repoRoot(cwd), stateDirName(), 'skillers'), root: repoRoot(cwd) };
  if (scope === 'global') return [global];
  if (scope === 'repo') return [repo];
  return [global, repo];
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ─── Small file helpers ─────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readConfig(dir) {
  return readJson(path.join(dir, 'config.json'), {}) || {};
}

// Per-session high-water mark: the time of the last message already compacted.
// A session that keeps going after a compaction (including the one running
// /skillers compact) contributes its newer messages on the next run.
// Legacy configs kept only ids; their mark is the last compaction time.
function processedMarks(config) {
  const marks = new Map();
  for (const [id, ts] of Object.entries(config.processedSessions || {})) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) marks.set(id, ms);
  }
  const legacy = Date.parse(config.lastCompactedAt || '');
  for (const id of config.lastTranscriptsProcessed || []) {
    if (!marks.has(id)) marks.set(id, Number.isNaN(legacy) ? Date.now() : legacy);
  }
  return marks;
}

function msOf(ts) {
  const ms = Date.parse(ts || '');
  return Number.isNaN(ms) ? null : ms;
}

function loadThemes(dir) {
  const kdir = path.join(dir, 'knowledge');
  let files = [];
  try { files = fs.readdirSync(kdir).filter(f => f.endsWith('.json')); } catch { return []; }
  return files
    .map(f => readJson(path.join(kdir, f), null))
    .filter(t => t && typeof t.theme === 'string' && Array.isArray(t.observations));
}

function clean(text) {
  if (typeof text !== 'string') return '';
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = redact(stripped);
  return safe.length > MAX_MESSAGE_CHARS ? safe.slice(0, MAX_MESSAGE_CHARS) + ' [...]' : safe;
}

// Harness-injected context that is not something the user typed. Slash
// commands (<command-name>) and typed shell input (<bash-input>) stay: they
// are the user's own actions.
const INJECTED_TAGS = [
  'task-notification', 'subagent_notification', 'bash-stdout', 'bash-stderr',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
  'environment_context', 'user_instructions', 'permissions', 'recommended_plugins',
  'turn_aborted', 'user_shell_command'
];
const INJECTED = new RegExp(`^(<(${INJECTED_TAGS.join('|')})\\b|# AGENTS\\.md instructions|Caveat: The messages below)`);

function isInjected(text) {
  return INJECTED.test(text);
}

function sample(list) {
  if (list.length <= MAX_MESSAGES_PER_SESSION) return list;
  return [...list.slice(0, 20), ...list.slice(-(MAX_MESSAGES_PER_SESSION - 20))];
}

function jsonlLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* malformed line: skip */ }
  }
  return out;
}

function walk(dir, depth, pred, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(full, depth - 1, pred, out);
    else if (e.isFile() && pred(e.name)) out.push(full);
  }
  return out;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// ─── Transcript readers ─────────────────────────────────────────────────────
// Each reader returns sessions: { id, source, cwd, start, messages: [{ts, text}], tools: {name: count} }.
// Every text passes through clean(), which redacts secrets before it leaves this process.

function readClaude(sinceMs) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = walk(root, 1, n => n.endsWith('.jsonl')).filter(f => mtime(f) >= sinceMs);
  return files.map(file => {
    const s = { id: path.basename(file, '.jsonl'), source: 'claude-code', cwd: null, start: null, messages: [], tools: {} };
    for (const e of jsonlLines(file)) {
      if (e.isSidechain) continue;
      if (!s.cwd && e.cwd) s.cwd = e.cwd;
      if (e.sessionId) s.id = e.sessionId;
      if (!s.start && e.timestamp) s.start = e.timestamp;
      const content = e.message && e.message.content;
      if (e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
        const texts = typeof content === 'string' ? [content]
          : Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text) : [];
        for (const t of texts) {
          const text = clean(t);
          if (text && !isInjected(text)) s.messages.push({ ts: e.timestamp || null, text });
        }
      } else if (e.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) if (b && b.type === 'tool_use' && b.name) s.tools[b.name] = (s.tools[b.name] || 0) + 1;
      }
    }
    return s;
  });
}

function readCodex(sinceMs) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = walk(root, 3, n => n.endsWith('.jsonl')).filter(f => mtime(f) >= sinceMs);
  return files.map(file => {
    const s = { id: path.basename(file, '.jsonl'), source: 'codex', cwd: null, start: null, messages: [], tools: {} };
    const fromEvents = [];
    const fromItems = [];
    for (const e of jsonlLines(file)) {
      const p = e.payload || {};
      if (e.type === 'session_meta') {
        s.id = p.id || p.session_id || s.id;
        s.cwd = p.cwd || s.cwd;
        s.start = p.timestamp || e.timestamp || s.start;
      } else if (e.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        fromEvents.push({ ts: e.timestamp || null, text: clean(p.message) });
      } else if (e.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        for (const c of p.content) {
          if (c && c.type === 'input_text') fromItems.push({ ts: e.timestamp || null, text: clean(c.text) });
        }
      } else if (e.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) {
        s.tools[p.name] = (s.tools[p.name] || 0) + 1;
      }
    }
    // Older rollouts log typed input as event_msg; newer ones only as response items.
    const msgs = fromEvents.length ? fromEvents : fromItems;
    s.messages = msgs.filter(m => m.text && !isInjected(m.text));
    return s;
  });
}

function openSqlite(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null; // Node without node:sqlite (before 22.5)
  }
}

function readOpenCode(sinceMs, notes) {
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'opencode.db') : null
  ].filter(Boolean);
  const file = candidates.find(f => fs.existsSync(f));
  if (!file) return [];
  const db = openSqlite(file);
  if (!db) {
    notes.push('opencode: skipped, this Node has no node:sqlite (needs Node 22.5 or newer)');
    return [];
  }
  const sessions = new Map();
  try {
    for (const r of db.prepare('SELECT id, directory, time_created FROM session WHERE time_updated >= ?').all(sinceMs)) {
      sessions.set(r.id, { id: r.id, source: 'opencode', cwd: r.directory, start: new Date(r.time_created).toISOString(), messages: [], tools: {} });
    }
    const rows = db.prepare(
      'SELECT p.session_id AS sid, p.time_created AS ts, p.data AS pdata, m.data AS mdata ' +
      'FROM part p JOIN message m ON m.id = p.message_id WHERE p.time_created >= ? ORDER BY p.time_created'
    ).all(sinceMs);
    for (const r of rows) {
      const s = sessions.get(r.sid);
      if (!s) continue;
      let part, msg;
      try { part = JSON.parse(r.pdata); msg = JSON.parse(r.mdata); } catch { continue; }
      if (msg.role === 'user' && part.type === 'text' && !part.synthetic) {
        const text = clean(part.text);
        if (text && !isInjected(text)) s.messages.push({ ts: new Date(r.ts).toISOString(), text });
      } else if (part.type === 'tool' && part.tool) {
        s.tools[part.tool] = (s.tools[part.tool] || 0) + 1;
      }
    }
  } catch (e) {
    notes.push(`opencode: skipped, unexpected database layout (${e.message})`);
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  return [...sessions.values()];
}

// ─── Commands ───────────────────────────────────────────────────────────────

function extract(opts) {
  const tgs = targets(opts.scope);
  const sinceMs = Date.now() - opts.days * DAY_MS;
  const notes = [];
  const marks = tgs.map(t => processedMarks(readConfig(t.dir)));
  const repo = tgs.find(t => t.scope === 'repo');
  const onlyRepo = opts.scope === 'repo';

  const all = [...readClaude(sinceMs), ...readCodex(sinceMs), ...readOpenCode(sinceMs, notes)]
    .filter(s => !onlyRepo || isInside(s.cwd, repo.root))
    .map(s => {
      // Keep only messages newer than the oldest mark among the targets this
      // session applies to. The repo target never records out-of-repo sessions.
      const applicable = tgs.map((t, i) => i).filter(i => tgs[i].scope !== 'repo' || isInside(s.cwd, tgs[i].root));
      const mark = Math.min(...applicable.map(i => (marks[i].has(s.id) ? marks[i].get(s.id) : -Infinity)));
      const fresh = s.messages.filter(m => {
        const ms = msOf(m.ts);
        return ms === null ? mark === -Infinity : ms > mark;
      });
      const times = fresh.map(m => msOf(m.ts)).filter(ms => ms !== null);
      return { ...s, messages: fresh, lastTs: times.length ? new Date(Math.max(...times)).toISOString() : null };
    })
    .filter(s => s.messages.length > 0)
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));

  const picked = all.slice(0, MAX_SESSIONS).map(s => ({
    id: s.id,
    source: s.source,
    cwd: s.cwd,
    inRepo: repo ? isInside(s.cwd, repo.root) : undefined,
    start: s.start,
    lastTs: s.lastTs,
    userMessages: s.messages.length,
    messages: sample(s.messages),
    tools: s.tools
  }));

  const existingThemes = [];
  for (const t of tgs) {
    for (const th of loadThemes(t.dir)) existingThemes.push({ scope: t.scope, theme: th.theme, weight: th.weight, occurrences: th.totalOccurrences });
  }

  const digest = {
    generatedAt: new Date().toISOString(),
    scope: opts.scope,
    days: opts.days,
    pendingAfterThisRun: Math.max(0, all.length - picked.length),
    existingThemes,
    notes,
    sessions: picked
  };
  const file = path.join(os.homedir(), stateDirName(), 'skillers', 'digest.json');
  writeJson(file, digest);

  const bySource = {};
  for (const s of picked) bySource[s.source] = (bySource[s.source] || 0) + 1;
  console.log(`sessions: ${picked.length}${Object.keys(bySource).length ? ` (${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (digest.pendingAfterThisRun) console.log(`pending: ${digest.pendingAfterThisRun} more sessions for the next run`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`digest: ${file}`);
}

function slugTheme(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

const SHELL_META = /\$\(|`|\||;|&&|>|</;

function validateObservation(o, knownSessions) {
  if (!o || typeof o !== 'object') return 'not an object';
  if (!TYPES.includes(o.t)) return `t must be one of ${TYPES.join(', ')}`;
  if (typeof o.v !== 'string' || !o.v.trim()) return 'v is required';
  if (o.v.trim().split(/\s+/).length > 8) return 'v is longer than 8 words';
  if (SHELL_META.test(o.v) || (o.ctx && SHELL_META.test(String(o.ctx)))) return 'v or ctx contains shell syntax';
  if (!slugTheme(o.theme)) return 'theme is required';
  if (Number.isNaN(Date.parse(o.ts))) return 'ts is not a date';
  if (!knownSessions.has(o.session)) return 'session is not in the digest';
  return null;
}

function calculateWeight(observations, now = Date.now()) {
  if (observations.length === 0) return 0;
  const frequency = Math.min(observations.length / 20, 1);
  const recency = observations
    .map(o => Math.exp(-Math.LN2 * Math.max(0, now - Date.parse(o.ts)) / DAY_MS / 30))
    .reduce((a, b) => a + b, 0) / observations.length;
  const crossSession = Math.min(new Set(observations.map(o => o.session)).size / 5, 1);
  const pain = observations.filter(o => o.t === 'pain' || o.t === 'wish').length;
  const painBoost = 1 + (pain / observations.length) * 0.5;
  const raw = (frequency * 0.3 + recency * 0.3 + crossSession * 0.4) * painBoost;
  return Math.round(Math.min(raw, 1) * 100) / 100;
}

function summarizeTheme(name, observations, now) {
  const typeCounts = Object.fromEntries(TYPES.map(t => [t, 0]));
  for (const o of observations) typeCounts[o.t] += 1;
  const times = observations.map(o => o.ts).sort();
  return {
    theme: name,
    weight: calculateWeight(observations, now),
    observations,
    sessions: new Set(observations.map(o => o.session)).size,
    firstSeen: times[0],
    lastSeen: times[times.length - 1],
    totalOccurrences: observations.length,
    typeCounts
  };
}

function shouldPrune(theme, now) {
  const age = now - Date.parse(theme.lastSeen);
  return (age > 90 * DAY_MS && theme.weight < 0.1) || (theme.totalOccurrences === 1 && age > 30 * DAY_MS);
}

function merge(opts) {
  const input = readJson(opts.input, undefined);
  if (input === undefined) throw new UsageError(`cannot read JSON from ${opts.input}`);
  const list = Array.isArray(input) ? input : input && Array.isArray(input.observations) ? input.observations : null;
  if (!list) throw new UsageError('input must be an array of observations or { "observations": [...] }');

  const digestFile = path.join(os.homedir(), stateDirName(), 'skillers', 'digest.json');
  const digest = readJson(digestFile, { sessions: [] });
  const sessions = new Map((digest.sessions || []).map(s => [s.id, s]));
  const now = Date.now();

  const accepted = [];
  const rejected = [];
  for (const o of list) {
    const why = validateObservation(o, sessions);
    if (why) { rejected.push({ observation: o, reason: why }); continue; }
    const s = sessions.get(o.session);
    accepted.push({
      ts: new Date(o.ts).toISOString(),
      t: o.t,
      v: redact(o.v.trim()),
      ctx: o.ctx ? redact(String(o.ctx).slice(0, 120)) : '',
      session: o.session,
      source: s.source,
      theme: slugTheme(o.theme)
    });
  }

  const summary = { accepted: accepted.length, rejected: rejected.length, rejections: rejected.slice(0, 20), targets: [] };
  if (opts.dryRun) {
    // Validation only: nothing written, digest kept, so rejected entries can be fixed first.
    summary.dryRun = true;
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  for (const t of targets(opts.scope)) {
    const config = readConfig(t.dir);
    const marks = processedMarks(config);
    const mine = accepted.filter(o => {
      const mark = marks.has(o.session) ? marks.get(o.session) : -Infinity;
      return Date.parse(o.ts) > mark && (t.scope === 'global' || sessions.get(o.session).inRepo);
    });
    const existing = new Map(loadThemes(t.dir).map(th => [th.theme, th]));
    const byTheme = new Map();
    for (const o of mine) {
      if (!byTheme.has(o.theme)) byTheme.set(o.theme, []);
      const { theme, ...rest } = o;
      byTheme.get(o.theme).push(rest);
    }
    let created = 0;
    let updated = 0;
    const touched = new Set();
    for (const [name, obs] of byTheme) {
      const prior = existing.get(name);
      const seen = new Set();
      const combined = [...(prior ? prior.observations : []), ...obs].filter(o => {
        const key = `${o.ts}|${o.session}|${o.t}|${o.v}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-MAX_OBSERVATIONS_PER_THEME);
      existing.set(name, summarizeTheme(name, combined, now));
      touched.add(name);
      if (prior) updated += 1; else created += 1;
    }
    let pruned = 0;
    const kdir = path.join(t.dir, 'knowledge');
    for (const [name, th] of existing) {
      // Recompute untouched themes too, so weights decay between runs.
      const fresh = touched.has(name) ? th : summarizeTheme(name, th.observations, now);
      const file = path.join(kdir, `${name}.json`);
      if (shouldPrune(fresh, now)) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        existing.delete(name);
        pruned += 1;
      } else {
        writeJson(file, fresh);
        existing.set(name, fresh);
      }
    }
    for (const s of digest.sessions || []) {
      if (t.scope !== 'global' && !s.inRepo) continue;
      const ms = msOf(s.lastTs);
      if (ms !== null && !(marks.get(s.id) >= ms)) marks.set(s.id, ms);
    }
    config.lastCompactedAt = new Date(now).toISOString();
    config.processedSessions = Object.fromEntries(
      [...marks].filter(([, ms]) => Number.isFinite(ms)).sort((a, b) => a[1] - b[1]).slice(-MAX_PROCESSED_IDS)
        .map(([id, ms]) => [id, new Date(ms).toISOString()])
    );
    delete config.lastTranscriptsProcessed;
    writeJson(path.join(t.dir, 'config.json'), config);
    summary.targets.push({
      scope: t.scope,
      dir: t.dir,
      themesCreated: created,
      themesUpdated: updated,
      themesPruned: pruned,
      themes: [...existing.values()].sort((a, b) => b.weight - a.weight)
        .map(th => ({ name: th.theme, weight: th.weight, observations: th.totalOccurrences, sessions: th.sessions }))
    });
  }
  // The digest holds redacted user text; it is not needed once merged.
  try { fs.unlinkSync(digestFile); } catch { /* already gone */ }
  console.log(JSON.stringify(summary, null, 2));
}

function frontmatterDescription(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const m = head.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return m ? m[1].slice(0, 160) : '';
  } catch {
    return '';
  }
}

// Best-effort list of skills, agents and commands already installed, so the
// recommender does not suggest building one that exists.
function inventory(cwd = process.cwd()) {
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude'), path.join(repoRoot(cwd), '.claude'),
    path.join(home, '.codex'), path.join(home, '.agents'), path.join(repoRoot(cwd), '.agents'),
    path.join(home, '.config', 'opencode'), path.join(repoRoot(cwd), '.opencode')
  ];
  const found = { skills: [], agents: [], commands: [] };
  const add = (kind, file, name) => {
    if (!found[kind].some(x => x.name === name)) found[kind].push({ name, description: frontmatterDescription(file), path: file });
  };
  for (const root of roots) {
    for (const f of walk(path.join(root, 'skills'), 1, n => n === 'SKILL.md')) add('skills', f, path.basename(path.dirname(f)));
    for (const dir of ['agents', 'agent']) for (const f of walk(path.join(root, dir), 0, n => n.endsWith('.md'))) add('agents', f, path.basename(f, '.md'));
    for (const dir of ['commands', 'command']) for (const f of walk(path.join(root, dir), 0, n => n.endsWith('.md'))) add('commands', f, path.basename(f, '.md'));
  }
  // Claude Code plugins: <marketplace>/<plugin>/{skills,agents,commands} or the marketplace root itself.
  for (const f of walk(path.join(home, '.claude', 'plugins'), 5, n => n === 'SKILL.md')) add('skills', f, path.basename(path.dirname(f)));
  for (const f of walk(path.join(home, '.claude', 'plugins'), 4, n => n.endsWith('.md'))) {
    const parent = path.basename(path.dirname(f));
    if (parent === 'agents') add('agents', f, path.basename(f, '.md'));
    if (parent === 'commands') add('commands', f, path.basename(f, '.md'));
  }
  return found;
}

function candidates(opts) {
  const now = Date.now();
  const out = { candidates: [], skipped: [], thresholds: { occurrences: MIN_OCCURRENCES, sessions: MIN_SESSIONS, weight: MIN_WEIGHT } };
  let any = false;
  for (const t of targets(opts.scope)) {
    for (const th of loadThemes(t.dir)) {
      any = true;
      const base = { scope: t.scope, theme: th.theme, weight: th.weight, occurrences: th.totalOccurrences, sessions: th.sessions };
      let reason = null;
      if (th.totalOccurrences < MIN_OCCURRENCES || th.sessions < MIN_SESSIONS) reason = 'insufficient_evidence';
      else if (th.weight < MIN_WEIGHT) reason = 'low_weight';
      else if (now - Date.parse(th.firstSeen) < DAY_MS) reason = 'too_recent';
      if (reason) out.skipped.push({ ...base, reason });
      else out.candidates.push({ ...base, typeCounts: th.typeCounts, firstSeen: th.firstSeen, lastSeen: th.lastSeen, observations: th.observations.slice(-25) });
    }
  }
  out.candidates.sort((a, b) => b.weight - a.weight);
  out.knowledge = any ? 'present' : 'empty';
  out.installed = inventory();
  console.log(JSON.stringify(out, null, 2));
}

function countTranscripts() {
  const home = os.homedir();
  const counts = {
    'claude-code': walk(path.join(home, '.claude', 'projects'), 1, n => n.endsWith('.jsonl')).length,
    codex: walk(path.join(home, '.codex', 'sessions'), 3, n => n.endsWith('.jsonl')).length
  };
  const db = [path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'opencode.db') : null].filter(Boolean).find(f => fs.existsSync(f));
  counts.opencode = db ? 'database found' : 0;
  return counts;
}

function show(opts) {
  const lines = ['Skillers Status'];
  for (const t of targets(opts.scope)) {
    const config = readConfig(t.dir);
    const themes = loadThemes(t.dir).sort((a, b) => b.weight - a.weight);
    const initialized = fs.existsSync(path.join(t.dir, 'config.json'));
    lines.push(`  Scope: ${t.scope}`, `  State dir: ${t.dir}`, `  Initialized: ${initialized ? 'yes' : 'no (run /skillers compact)'}`,
      `  Last compacted: ${config.lastCompactedAt || 'never'}`, `  Theme files: ${themes.length}`);
    for (const th of themes) lines.push(`    ${th.theme} (weight: ${th.weight}, ${th.totalOccurrences} observations, ${th.sessions} sessions)`);
  }
  lines.push('', 'Data Source');
  for (const [k, v] of Object.entries(countTranscripts())) lines.push(`  ${k}: ${typeof v === 'number' ? `${v} transcripts` : v}`);
  console.log(lines.join('\n'));
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
    ({ show, extract, merge, candidates })[opts.command](opts);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`[ERROR] ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, calculateWeight, slugTheme, validateObservation, shouldPrune, isInside, clean, isInjected, readClaude, readCodex, readOpenCode, inventory };
