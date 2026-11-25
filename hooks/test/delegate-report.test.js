const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkTmpConfig, runNode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'delegate-report.js');
function load(dir) {
  process.env.CLAUDE_CONFIG_DIR = dir;
  for (const m of ['../delegate-report', '../delegate-lib']) delete require.cache[require.resolve(m)];
  return require('../delegate-report');
}
const tok = (o) => ({ in: 0, out: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, ...o });

test('priceFor picks the longest matching prefix', () => {
  const r = load(mkTmpConfig());
  assert.strictEqual(r.costOf({ model: 'claude-opus-5-5', tokens: tok({ out: 1e6 }) }), 20);
  assert.strictEqual(r.costOf({ model: 'claude-opus-5', tokens: tok({ out: 1e6 }) }), 25);
  assert.strictEqual(r.costOf({ model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 1e6 }) }), 5);
  assert.strictEqual(r.costOf({ model: 'claude-future-9', tokens: tok({ out: 1e6 }) }), null);
});

test('priceFor covers the older 4.x model families', () => {
  const r = load(mkTmpConfig());
  assert.strictEqual(r.costOf({ model: 'claude-opus-4-8', tokens: tok({ out: 1e6 }) }), 25);
  assert.strictEqual(r.costOf({ model: 'claude-sonnet-4-6', tokens: tok({ out: 1e6 }) }), 15);
  assert.strictEqual(r.costOf({ model: 'claude-opus-5-5', tokens: tok({ out: 1e6 }) }), 20);
  assert.strictEqual(r.costOf({ model: 'claude-opus-5', tokens: tok({ out: 1e6 }) }), 25);
});

test('priceFor prices Fable 5.2 and Sonnet 5.5 cache reads at their own rates', () => {
  const r = load(mkTmpConfig());
  assert.strictEqual(r.costOf({ model: 'claude-fable-5-2', tokens: tok({ in: 1e6, out: 1e6, cache_read: 1e6 }) }), 48.2);
  assert.strictEqual(r.costOf({ model: 'claude-fable-5-1', tokens: tok({ out: 1e6 }) }), 50);
  assert.strictEqual(r.costOf({ model: 'claude-sonnet-5-5', tokens: tok({ cache_read: 1e6 }) }), 0.1);
  assert.strictEqual(r.costOf({ model: 'claude-sonnet-5', tokens: tok({ cache_read: 1e6 }) }), 0.2);
});

test('report names models priced by a family fallback row', () => {
  const r = load(mkTmpConfig());
  const info = { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 };
  const rec = (model) => ({ agent_id: model, origin: 'unrouted', project: 'p', model, tokens: tok({ out: 5 }) });
  const text = r.buildReport([rec('claude-fable-5-9'), rec('claude-opus-5-5[1m]'), rec('claude-sonnet-5-5')], info);
  assert.match(text, /- Priced by family fallback: claude-fable-5-9\n/);
  assert.match(r.buildReport([rec('claude-opus-5-5')], info), /- Priced by family fallback: none/);
});

test('mergeByAgent: transcript metrics win over post_tool metrics, post_tool line first', () => {
  const r = load(mkTmpConfig());
  const merged = r.mergeByAgent([
    { agent_id: 'a1', source: 'post_tool', origin: 'delegate:b1', model: 'haiku', tokens: tok({ out: 270 }), project: 'p', ts: '2026-09-25T00:00:00Z' },
    { agent_id: 'a1', source: 'transcript', origin: null, model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 358 }), reply_chars: 40, parse_error: null },
    { agent_id: 'a2', source: 'transcript', origin: null, model: 'claude-sonnet-5', tokens: tok({ out: 10 }), reply_chars: 9000 },
  ]);
  assert.strictEqual(merged.length, 2);
  const a1 = merged.find((m) => m.agent_id === 'a1');
  assert.strictEqual(a1.origin, 'delegate:b1');
  assert.strictEqual(a1.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(a1.tokens.out, 358);
  assert.strictEqual(a1.metricsFrom, 'transcript');
  assert.strictEqual(a1.reply_chars, 40);
  assert.strictEqual(merged.find((m) => m.agent_id === 'a2').origin, 'unrouted');
});

test('mergeByAgent: transcript metrics win over post_tool metrics, transcript line first', () => {
  const r = load(mkTmpConfig());
  const merged = r.mergeByAgent([
    { agent_id: 'a1', source: 'transcript', origin: null, model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 358 }), reply_chars: 40, parse_error: null },
    { agent_id: 'a1', source: 'post_tool', origin: 'delegate:b1', model: 'haiku', tokens: tok({ out: 270 }), project: 'p', ts: '2026-09-25T00:00:00Z' },
  ]);
  const a1 = merged.find((m) => m.agent_id === 'a1');
  assert.strictEqual(a1.origin, 'delegate:b1');
  assert.strictEqual(a1.tokens.out, 358);
  assert.strictEqual(a1.metricsFrom, 'transcript');
});

test('mergeByAgent: post_tool metrics are used when the agent has no transcript line', () => {
  const r = load(mkTmpConfig());
  const merged = r.mergeByAgent([
    { agent_id: 'a1', source: 'post_tool', origin: 'delegate:b1', model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 270 }), project: 'p', ts: '2026-09-25T00:00:00Z' },
  ]);
  const a1 = merged.find((m) => m.agent_id === 'a1');
  assert.strictEqual(a1.tokens.out, 270);
  assert.strictEqual(a1.metricsFrom, 'post_tool');
});

test('mergeByAgent takes the latest of two transcript stops for one agent, not the first', () => {
  const r = load(mkTmpConfig());
  const merged = r.mergeByAgent([
    { agent_id: 'a1', source: 'transcript', origin: null, model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 100 }), reply_chars: 40, parse_error: null },
    { agent_id: 'a1', source: 'transcript', origin: null, model: 'claude-haiku-4-5-20251001', tokens: tok({ out: 900 }), reply_chars: 90, parse_error: null },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].tokens.out, 900);
});

test('an unknown model shows n/a and does not crash the report', () => {
  const r = load(mkTmpConfig());
  const text = r.buildReport([{ agent_id: 'a', origin: 'unrouted', project: 'p', model: 'claude-future-9', tokens: tok({ out: 5 }) }], { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 });
  assert.match(text, /1 n\/a/);
});

test('buildReport classifies an ENOENT record with no agent_type as internal, and excludes it from parse-error counts', () => {
  const r = load(mkTmpConfig());
  const text = r.buildReport([
    { agent_id: 'i1', origin: 'unrouted', agent_type: null, project: 'p', model: null, tokens: null, parse_error: 'ENOENT: no such file' },
    { agent_id: 'r1', origin: 'unrouted', agent_type: 'general-purpose', project: 'p', model: null, tokens: null, parse_error: 'no assistant usage entries' },
  ], { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 });
  assert.match(text, /Transcript parse errors: 1/);
  assert.match(text, /- internal:/m);
});

test('cleanupState removes state older than 7 days and keeps recent state', () => {
  const dir = mkTmpConfig();
  const r = load(dir);
  const stateDir = path.join(dir, 'delegate', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'old.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'new.json'), '{}');
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(path.join(stateDir, 'old.json'), eightDaysAgo, eightDaysAgo);
  assert.strictEqual(r.cleanupState(stateDir, Date.now()), 1);
  assert.deepStrictEqual(fs.readdirSync(stateDir), ['new.json']);
});

test('CLI: --days filters old lines, counts parse errors and grown allowances', () => {
  const dir = mkTmpConfig();
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  fs.writeFileSync(path.join(dir, 'delegation-log.jsonl'), [
    { ts: now, agent_id: 'a1', source: 'transcript', project: 'p', model: 'claude-sonnet-5', tokens: tok({ out: 1e6 }), parse_error: null },
    { ts: now, agent_id: 'a2', source: 'transcript', project: 'p', agent_type: 'general-purpose', model: null, tokens: null, parse_error: 'no assistant usage entries' },
    { ts: old, agent_id: 'a3', source: 'transcript', project: 'p', model: 'claude-sonnet-5', tokens: tok({ out: 1e6 }), parse_error: null },
  ].map((l) => JSON.stringify(l)).join('\n'));
  fs.mkdirSync(path.join(dir, 'delegate', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'state', 's1.json'), JSON.stringify({ spawned: 5, allowance: 6 }));
  const r = runNode(CLI, '', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Subagents: 2/);
  assert.match(r.stdout, /\$10\.00/);
  assert.match(r.stdout, /Transcript parse errors: 1/);
  assert.match(r.stdout, /Sessions past the initial allowance: 1/);
});

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test('compareUsage: per-period cost, streamed max, synthetic ignored, subCount, unpriced, before-days window', () => {
  const dir = mkTmpConfig();
  const r = load(dir);
  const projectsDir = path.join(dir, 'projects');
  const cutoffMs = Date.parse('2026-01-15T00:00:00Z');
  const beforeDays = 14;
  const nowMs = Date.parse('2026-01-20T00:00:00Z');

  writeJsonl(path.join(projectsDir, 'p1', 's1.jsonl'), [
    { type: 'assistant', timestamp: '2025-12-01T00:00:00Z', message: { id: 'too-old', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } },
    { type: 'assistant', timestamp: '2026-01-10T00:00:00Z', message: { id: 'm-before', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } },
    { type: 'assistant', timestamp: '2026-01-16T00:00:00Z', message: { id: 'm-after', model: 'claude-opus-5-5', usage: { output_tokens: 200000 } } },
    { type: 'assistant', timestamp: '2026-01-16T00:00:01Z', message: { id: 'm-after', model: 'claude-opus-5-5', usage: { output_tokens: 500000 } } },
    { type: 'assistant', timestamp: '2026-01-16T00:00:02Z', message: { id: 'synth', model: '<synthetic>', usage: { output_tokens: 999999 } } },
    { type: 'assistant', timestamp: '2026-01-16T00:00:03Z', message: { id: 'unk-1', model: 'claude-future-9', usage: { output_tokens: 100 } } },
  ]);
  writeJsonl(path.join(projectsDir, 'p1', 's1', 'subagents', 'agent-a.jsonl'), [
    { type: 'assistant', timestamp: '2026-01-17T00:00:00Z', message: { id: 'sub-1', model: 'claude-haiku-4-5-20251001', usage: { output_tokens: 200000 } } },
  ]);

  const result = r.compareUsage(projectsDir, cutoffMs, beforeDays, nowMs);
  assert.strictEqual(result.before.mainCost, 20);
  assert.strictEqual(result.before.subCost, 0);
  assert.strictEqual(result.before.subCount, 0);
  assert.strictEqual(result.before.days, 14);
  assert.strictEqual(result.after.mainCost, 10);
  assert.strictEqual(result.after.subCost, 1);
  assert.strictEqual(result.after.subCount, 1);
  assert.deepStrictEqual(result.after.unpriced, { 'claude-future-9': 1 });
});

test('CLI --compare with no marker file and no date exits 1', () => {
  const dir = mkTmpConfig();
  const r = spawnSync(process.execPath, [CLI, '--compare'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
});

test('buildReport attributes an unprefixed spawn to delegate when its session also ran a delegate spawn', () => {
  const r = load(mkTmpConfig());
  const text = r.buildReport([
    { agent_id: 'd1', origin: 'delegate:t1', session: 's1', agent_type: 'general-purpose', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e6 }) },
    { agent_id: 'u1', origin: 'unrouted', session: 's1', agent_type: 'general-purpose', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e6 }), reply_chars: 50 },
    { agent_id: 'u2', origin: 'unrouted', session: 's2', agent_type: 'Explore', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e6 }), reply_chars: 70 },
  ], { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 });
  assert.match(text, /^- delegate: 1 agents, \$10\.00$/m);
  assert.match(text, /^- delegate-session: 1 agents, \$10\.00$/m);
  assert.match(text, /^- unrouted: 1 agents, \$10\.00$/m);
  assert.match(text, /- Explore in p: 70 chars/);
  assert.doesNotMatch(text, /general-purpose in p: 50 chars/);
});

test('roleOf reads the role from the description and agent type', () => {
  const r = load(mkTmpConfig());
  assert.strictEqual(r.roleOf({ description: '[delegate:x] Re-review Task 5 fix round 1' }), 're-review');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] Review Task 2 (spec + quality)' }), 'review');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] final whole-branch review' }), 'review');
  assert.strictEqual(r.roleOf({ description: 'anything', agent_type: 'code-reviewer' }), 'review');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] Task 3 implementer' }), 'implementer');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] Migrate group G2 forms' }), 'implementer');
  assert.strictEqual(r.roleOf({ description: 'find callers', agent_type: 'Explore' }), 'locator');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] research transcript format' }), 'research');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] paseo backstop 3' }), 'other');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] chat-csv-coverage-map TC-1..35', agent_type: 'general-purpose' }), 'other');
  assert.strictEqual(r.roleOf({ description: '[delegate:x] locate the session store', agent_type: 'general-purpose' }), 'locator');
  assert.strictEqual(r.roleOf({}), null);
});

test('buildReport prints the median per role and model family, needing 5 runs', () => {
  const r = load(mkTmpConfig());
  const review = (i, out) => ({ agent_id: `r${i}`, origin: 'delegate:t', session: 's', agent_type: 'general-purpose', description: `[delegate:t] review task ${i}`, project: 'p', model: 'claude-opus-5-5', tokens: tok({ out }) });
  const recs = [review(1, 5e4), review(2, 5e4), review(3, 6e4), review(4, 7e4), review(5, 7e4),
    { agent_id: 'i1', origin: 'delegate:t', session: 's', agent_type: 'general-purpose', description: '[delegate:t] Task 1 implementer', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e5 }) },
    { agent_id: 'n1', origin: 'unrouted', session: 's', agent_type: 'general-purpose', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e5 }) }];
  const text = r.buildReport(recs, { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 });
  assert.match(text, /^- opus review: \$1\.20 over 5$/m);
  assert.match(text, /^- sonnet implementer: needs 5, has 1$/m);
  assert.match(text, /Spawns with no recorded description: 1/);
});

test('mergeByAgent keeps the REVIEW counts from the transcript line', () => {
  const r = load(mkTmpConfig());
  const [m] = r.mergeByAgent([
    { agent_id: 'a1', source: 'post_tool', origin: 'delegate:t', model: 'opus', tokens: null },
    { agent_id: 'a1', source: 'transcript', model: 'claude-opus-5-5', tokens: tok({ out: 1 }), review: { verdict: 'fix', C: 0, H: 1, M: 0, L: 2 } },
  ]);
  assert.deepStrictEqual(m.review, { verdict: 'fix', C: 0, H: 1, M: 0, L: 2 });
});

test('parseTriageLine reads fixed, rejected and deferred counts per severity', () => {
  const r = load(mkTmpConfig());
  assert.deepStrictEqual(r.parseTriageLine('t3: triage code-reviewer:opus — fixed H1 M2, rejected M1, deferred L3'), {
    key: 'code-reviewer opus',
    fixed: { C: 0, H: 1, M: 2, L: 0 }, rejected: { C: 0, H: 0, M: 1, L: 0 }, deferred: { C: 0, H: 0, M: 0, L: 3 },
  });
  assert.strictEqual(r.parseTriageLine('t3: fix round 1 — H1 in foo.ts'), null);
});

test('readTriage sums the triage lines of runs inside the window', () => {
  const dir = mkTmpConfig();
  const r = load(dir);
  const runs = path.join(dir, 'delegate', 'runs', 'proj');
  for (const [run, text] of [
    ['2026-10-20-a', 't1: triage code-reviewer:claude-opus-5-5 — fixed H1, deferred L2\nt2: triage code-reviewer:opus — fixed M1, rejected M1\n'],
    ['2026-09-01-old', 't1: triage code-reviewer:opus — fixed H9\n'],
  ]) {
    fs.mkdirSync(path.join(runs, run), { recursive: true });
    fs.writeFileSync(path.join(runs, run, 'ledger.md'), text);
  }
  const t = r.readTriage(path.join(dir, 'delegate', 'runs'), Date.parse('2026-10-01'));
  assert.deepStrictEqual(t.get('code-reviewer opus'), {
    fixed: { C: 0, H: 1, M: 1, L: 0 }, rejected: { C: 0, H: 0, M: 1, L: 0 }, deferred: { C: 0, H: 0, M: 0, L: 2 },
  });
});

test('buildReport prints review value per reviewer and model family', () => {
  const r = load(mkTmpConfig());
  const rev = (i, review) => ({ agent_id: `r${i}`, origin: 'delegate:t', session: 's', agent_type: 'code-reviewer', description: `[delegate:t] review task ${i}`, project: 'p', model: 'claude-opus-5-5', tokens: tok({ out: 5e4 }), review });
  const recs = [rev(1, { verdict: 'fix', C: 0, H: 1, M: 2, L: 3 }), rev(2, null),
    { agent_id: 'i1', origin: 'delegate:t', session: 's', agent_type: 'general-purpose', description: '[delegate:t] Task 1 implementer', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e5 }) }];
  const triage = new Map([['code-reviewer opus', { fixed: { C: 0, H: 1, M: 1, L: 0 }, rejected: { C: 0, H: 0, M: 1, L: 0 }, deferred: { C: 0, H: 0, M: 0, L: 3 } }]]);
  const text = r.buildReport(recs, { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0, triage });
  assert.match(text, /^- code-reviewer opus: 2 reviews, \$2\.00, REVIEW line 1\/2: C0 H1 M2 L3; triage fixed C0 H1 M1 L0, rejected 1, deferred 3; \$1\.00 per fixed C\/H\/M$/m);
  assert.doesNotMatch(text, /general-purpose sonnet: /);
});

test('buildReport says n/a per fixed finding when nothing was triaged', () => {
  const r = load(mkTmpConfig());
  const recs = [{ agent_id: 'r1', origin: 'unrouted', session: 's', agent_type: 'general-purpose', description: 'review the diff', project: 'p', model: 'claude-sonnet-5-5', tokens: tok({ out: 1e5 }) }];
  const text = r.buildReport(recs, { days: 30, backstopSessions: 0, fixRounds: 0, removed: 0 });
  assert.match(text, /^- general-purpose sonnet: 1 reviews, \$1\.00, REVIEW line 0\/1: C0 H0 M0 L0; no triage$/m);
});
