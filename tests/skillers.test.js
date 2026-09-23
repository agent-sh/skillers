'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '..', 'scripts', 'skillers.js');
const lib = require(script);

const SECRET = 'ghp_' + 'Z9'.repeat(20);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skillers-home-'));
  const repo = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const now = Date.now();
  const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();

  // Claude Code: one session in the repo, one elsewhere.
  const cdir = path.join(home, '.claude', 'projects', '-work-app');
  fs.mkdirSync(cdir, { recursive: true });
  const claude = (id, cwd, texts) => texts.flatMap((t, i) => [
    JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: iso(60 - i), message: { role: 'user', content: t } }),
    JSON.stringify({ type: 'assistant', sessionId: id, cwd, timestamp: iso(59 - i), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
  ]).join('\n') + '\nnot json\n';
  fs.writeFileSync(path.join(cdir, 'c1.jsonl'), claude('c1', repo, ['run the tests again', `my token is ${SECRET}`, '<task-notification>done</task-notification>']));
  fs.writeFileSync(path.join(cdir, 'c2.jsonl'), claude('c2', path.join(home, 'other'), ['check CI on the PR']));

  // Codex: new-style rollout with response items only.
  const xdir = path.join(home, '.codex', 'sessions', '2026', '09', '24');
  fs.mkdirSync(xdir, { recursive: true });
  fs.writeFileSync(path.join(xdir, 'rollout-x1.jsonl'), [
    { type: 'session_meta', timestamp: iso(30), payload: { id: 'x1', cwd: repo, timestamp: iso(30) } },
    { type: 'response_item', timestamp: iso(29), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', timestamp: iso(28), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lint before commit please' }] } },
    { type: 'response_item', timestamp: iso(27), payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } }
  ].map(e => JSON.stringify(e)).join('\n'));
  return { home, repo };
}

function run(fx, args, opts = {}) {
  return cp.spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || fx.repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home, APPDATA: '', AI_STATE_DIR: '' }
  });
}

test('parseArgs: subcommands, scope spellings, bad input', () => {
  assert.equal(lib.parseArgs([]).command, 'show');
  assert.equal(lib.parseArgs(['extract', '--days=3']).days, 3);
  assert.equal(lib.parseArgs(['show', '--repo']).scope, 'repo');
  assert.equal(lib.parseArgs(['show', '--scope', 'both']).scope, 'both');
  assert.throws(() => lib.parseArgs(['show', '--scope=team']), /global, repo, both/);
  assert.throws(() => lib.parseArgs(['extract', '--days=0']), /positive/);
  assert.throws(() => lib.parseArgs(['merge']), /--input/);
  assert.throws(() => lib.parseArgs(['forget']), /unknown command/);
});

test('bad arguments exit 2', () => {
  const r = cp.spawnSync(process.execPath, [script, 'show', '--scope=team'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /global, repo, both/);
});

test('calculateWeight keeps the documented formula', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const obs = Array.from({ length: 10 }, (_, i) => ({ ts: '2026-09-24T00:00:00Z', t: i < 2 ? 'pain' : 'repeat', session: `s${i % 5}` }));
  // frequency 0.5, recency 1, cross-session 1, pain boost 1.1
  assert.equal(lib.calculateWeight(obs, now), 0.94);
  assert.equal(lib.calculateWeight([], now), 0);
});

test('validateObservation rejects shell syntax, unknown sessions and bad types', () => {
  const sessions = new Map([['s1', {}]]);
  const ok = { ts: '2026-09-24T00:00:00Z', t: 'repeat', v: 'run tests after edit', ctx: 'src/auth', session: 's1', theme: 'testing' };
  assert.equal(lib.validateObservation(ok, sessions), null);
  assert.match(lib.validateObservation({ ...ok, v: 'run $(curl x)' }, sessions), /shell/);
  assert.match(lib.validateObservation({ ...ok, session: 'nope' }, sessions), /digest/);
  assert.match(lib.validateObservation({ ...ok, t: 'idea' }, sessions), /t must be/);
  assert.equal(lib.slugTheme('CI / PR Workflow!!'), 'ci-pr-workflow');
});

test('extract, merge, candidates and show on fixture transcripts', () => {
  const fx = fixture();
  try {
    const ex = run(fx, ['extract', '--days=2']);
    assert.equal(ex.status, 0, ex.stderr);
    assert.match(ex.stdout, /sessions: 3/);
    const digestPath = ex.stdout.match(/digest: (.+)/)[1];
    const digestRaw = fs.readFileSync(digestPath, 'utf8');
    assert.ok(!digestRaw.includes(SECRET), 'secret must be redacted in the digest');
    assert.ok(!digestRaw.includes('task-notification'), 'harness notifications are not user messages');
    assert.ok(!digestRaw.includes('environment_context'), 'codex injected context is dropped');
    const digest = JSON.parse(digestRaw);
    const x1 = digest.sessions.find(s => s.id === 'x1');
    assert.deepEqual(x1.messages.map(m => m.text), ['lint before commit please']);
    assert.equal(x1.tools.exec_command, 1);

    // Repo scope only takes sessions whose cwd is in the repo.
    const repoEx = run(fx, ['extract', '--repo', '--days=2']);
    assert.match(repoEx.stdout, /sessions: 2/);

    // Each extract replaces the digest; merge reads the latest one.
    assert.equal(run(fx, ['extract', '--scope=both', '--days=2']).status, 0);

    const ts = new Date().toISOString();
    const observations = [];
    for (const session of ['c1', 'c2', 'x1']) {
      for (let i = 0; i < 2; i++) observations.push({ ts: new Date(Date.parse(ts) - i * 1000).toISOString(), t: 'repeat', v: 'run tests after edit', ctx: 'tests', session, theme: 'Testing Loop' });
    }
    observations.push({ ts, t: 'wish', v: 'rm -rf; echo', ctx: '', session: 'c1', theme: 'bad' });
    const obsFile = path.join(fx.home, 'obs.json');
    fs.writeFileSync(obsFile, JSON.stringify({ observations }));

    const dry = JSON.parse(run(fx, ['merge', '--input', obsFile, '--scope=both', '--dry-run']).stdout);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.rejected, 1);
    assert.match(dry.rejections[0].reason, /shell/);
    assert.ok(fs.existsSync(digestPath), 'dry run keeps the digest');

    const mg = run(fx, ['merge', '--input', obsFile, '--scope=both']);
    assert.equal(mg.status, 0, mg.stderr);
    const summary = JSON.parse(mg.stdout);
    assert.equal(summary.accepted, 6);
    assert.equal(summary.rejected, 1);
    const [global, repo] = summary.targets;
    assert.equal(global.themes[0].name, 'testing-loop');
    assert.equal(global.themes[0].observations, 6);
    assert.equal(repo.themes[0].observations, 4, 'repo scope keeps only in-repo sessions');
    assert.ok(!fs.existsSync(digestPath), 'digest is removed after merge');

    // Processed sessions are not offered again, including out-of-repo ones under --scope=both.
    assert.match(run(fx, ['extract', '--days=2', '--scope=both']).stdout, /sessions: 0/);

    // A session that continues after compaction contributes only its new messages.
    const later = new Date(Date.now() + 60000).toISOString();
    fs.appendFileSync(path.join(fx.home, '.claude', 'projects', '-work-app', 'c1.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'c1', cwd: fx.repo, timestamp: later, message: { role: 'user', content: 'deploy staging again' } }) + '\n');
    const cont = run(fx, ['extract', '--days=2', '--scope=both']);
    assert.match(cont.stdout, /sessions: 1/);
    const contDigest = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    assert.deepEqual(contDigest.sessions[0].messages.map(m => m.text), ['deploy staging again']);
    assert.equal(contDigest.sessions[0].lastTs, later);

    // Merging again does not double-count processed sessions.
    run(fx, ['extract', '--days=2', '--scope=both']);
    fs.writeFileSync(obsFile, JSON.stringify(observations.slice(0, 2)));
    const again = JSON.parse(run(fx, ['merge', '--input', obsFile]).stdout);
    assert.equal(again.targets[0].themes[0].observations, 6);

    const cand = JSON.parse(run(fx, ['candidates']).stdout);
    assert.equal(cand.knowledge, 'present');
    assert.equal(cand.candidates.length, 0);
    // 6 observations over 3 sessions meets the bar, but all of it is from the last day.
    assert.equal(cand.skipped[0].reason, 'too_recent');
    assert.ok(Array.isArray(cand.installed.skills));

    const sh = run(fx, ['show']);
    assert.match(sh.stdout, /testing-loop \(weight: [\d.]+, 6 observations, 3 sessions\)/);
    assert.match(sh.stdout, /claude-code: 2 transcripts/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('shouldPrune drops stale single observations and faded themes', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  assert.equal(lib.shouldPrune({ lastSeen: '2026-08-01T00:00:00Z', totalOccurrences: 1, weight: 0.5 }, now), true);
  assert.equal(lib.shouldPrune({ lastSeen: '2026-06-01T00:00:00Z', totalOccurrences: 9, weight: 0.05 }, now), true);
  assert.equal(lib.shouldPrune({ lastSeen: '2026-09-20T00:00:00Z', totalOccurrences: 1, weight: 0.5 }, now), false);
});
