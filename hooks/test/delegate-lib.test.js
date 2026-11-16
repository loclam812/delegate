const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpConfig, runNode } = require('./helpers');

const LIB = path.join(__dirname, '..', 'delegate-lib.js');

function freshLib(dir) {
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete require.cache[require.resolve(LIB)];
  return require(LIB);
}

test('paths follow CLAUDE_CONFIG_DIR', () => {
  const dir = mkTmpConfig();
  const lib = freshLib(dir);
  assert.strictEqual(lib.configDir(), dir);
  assert.strictEqual(lib.logPath(), path.join(dir, 'delegation-log.jsonl'));
  assert.strictEqual(lib.statePath('a/b c'), path.join(dir, 'delegate', 'state', 'a_b_c.json'));
});

test('readConfig falls back to defaults and merges a partial file', () => {
  const dir = mkTmpConfig();
  const lib = freshLib(dir);
  assert.deepStrictEqual(lib.readConfig(), { guardMode: 'warn', backstop: false, initialAllowance: 3, allowanceStep: 3, gitGuard: true });
  fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'config.json'), '{"guardMode":"deny"}');
  assert.strictEqual(lib.readConfig().guardMode, 'deny');
  assert.strictEqual(lib.readConfig().allowanceStep, 3);
});

test('isOff follows the kill-switch file', () => {
  const dir = mkTmpConfig();
  const lib = freshLib(dir);
  assert.strictEqual(lib.isOff(), false);
  fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'off'), '');
  assert.strictEqual(lib.isOff(), true);
});

test('originOf reads the delegate tag only at the start', () => {
  const lib = freshLib(mkTmpConfig());
  assert.strictEqual(lib.originOf('[delegate:a11y-batch] impl T1'), 'delegate:a11y-batch');
  assert.strictEqual(lib.originOf('impl [delegate:x]'), 'unrouted');
  assert.strictEqual(lib.originOf(undefined), 'unrouted');
});

test('projectSlug strips credentials and normalises remotes', () => {
  const lib = freshLib(mkTmpConfig());
  const repo = mkTmpConfig();
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/example-org/example-repo.git']);
  assert.strictEqual(lib.projectSlug(repo), 'github.com-example-org-example-repo');
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/castrol-gogoro.git']);
  assert.strictEqual(lib.projectSlug(repo), 'github.com-acme-castrol-gogoro');
  const plain = mkTmpConfig();
  assert.strictEqual(lib.projectSlug(plain), 'path' + plain.replace(/[^A-Za-z0-9._]+/g, '-'));
});

test('withLock waits for a held lock and gives up when it stays held', () => {
  const dir = mkTmpConfig();
  const lib = freshLib(dir);
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => lib.withLock(file, () => 1, { retries: 2, delayMs: 5 }), /lock busy/);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.strictEqual(lib.withLock(file, () => 42, { retries: 2, delayMs: 5 }), 42);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
});

test('state round-trips and defaults to the initial allowance', () => {
  const dir = mkTmpConfig();
  const lib = freshLib(dir);
  const cfg = lib.readConfig();
  assert.deepStrictEqual(lib.readState('s1', cfg), { spawned: 0, allowance: 3 });
  lib.writeState('s1', { spawned: 2, allowance: 5 });
  assert.deepStrictEqual(lib.readState('s1', cfg), { spawned: 2, allowance: 5 });
});

function hookScript(dir, body) {
  const f = path.join(dir, 'h.js');
  fs.writeFileSync(f, `require(${JSON.stringify(LIB)}).runHook('t', ${body});`);
  return f;
}

test('runHook: a throwing handler exits 0, prints nothing, logs the error', () => {
  const dir = mkTmpConfig();
  const r = runNode(hookScript(dir, '() => { throw new Error("boom") }'), '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(fs.readFileSync(path.join(dir, 'delegate', 'hook-errors.log'), 'utf8'), /boom/);
});

test('runHook: malformed stdin exits 0 and prints nothing', () => {
  const dir = mkTmpConfig();
  const r = runNode(hookScript(dir, '() => ({ x: 1 })'), 'not json', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('runHook: the off switch skips the handler', () => {
  const dir = mkTmpConfig();
  fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'off'), '');
  const r = runNode(hookScript(dir, '() => ({ x: 1 })'), '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('runHook: a handler result is printed as JSON', () => {
  const dir = mkTmpConfig();
  const r = runNode(hookScript(dir, '() => ({ x: 1 })'), '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.deepStrictEqual(JSON.parse(r.stdout), { x: 1 });
});

test('parseReviewLine reads the REVIEW line anywhere in a reply', () => {
  const lib = freshLib(mkTmpConfig());
  assert.deepStrictEqual(lib.parseReviewLine('Status: done\nREVIEW verdict=fix C=0 H=1 M=2 L=13\nreport: /r.md'), { verdict: 'fix', C: 0, H: 1, M: 2, L: 13 });
  assert.strictEqual(lib.parseReviewLine('Verdict: APPROVE. Counts: CRITICAL 0, HIGH 1'), null);
  assert.strictEqual(lib.parseReviewLine('REVIEW verdict=maybe C=0 H=0 M=0 L=0'), null);
  assert.strictEqual(lib.parseReviewLine(undefined), null);
});

test('isReviewer matches agent types that end in reviewer', () => {
  const lib = freshLib(mkTmpConfig());
  for (const t of ['code-reviewer', 'security-reviewer', 'caveman:cavecrew-reviewer']) assert.ok(lib.isReviewer(t), t);
  for (const t of ['general-purpose', 'Explore', undefined]) assert.ok(!lib.isReviewer(t), String(t));
});
