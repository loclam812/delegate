const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpConfig } = require('./helpers');

function load(dir) {
  process.env.CLAUDE_CONFIG_DIR = dir;
  for (const m of ['../delegate-project', '../delegate-lib']) delete require.cache[require.resolve(m)];
  return require('../delegate-project');
}
function repo() {
  const r = mkTmpConfig();
  execFileSync('git', ['init', '-q', r]);
  execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
  fs.writeFileSync(path.join(r, 'CLAUDE.md'), '# rules\n');
  fs.mkdirSync(path.join(r, '.claude', 'skills', 'bug-fix'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'skills', 'bug-fix', 'SKILL.md'), '---\nname: bug-fix\ndescription: fix bugs\n---\n');
  fs.mkdirSync(path.join(r, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'rules', 'frontend.md'), '# Frontend\nrule\n');
  return r;
}
function writeAdapter(p, info, manual = '## Manual\n- keep me\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# ${info.slug}\nremote: x | path: ${info.root} | source-hash: ${info.sourceHash} | generated: 2026-09-25\n\n${manual}`);
}

test('a project without an adapter reports missing, with its slug and sources', () => {
  const cfg = mkTmpConfig();
  const p = load(cfg);
  const r = repo();
  const info = p.adapterInfo(r);
  assert.strictEqual(info.status, 'missing');
  assert.strictEqual(info.slug, 'github.com-acme-shop');
  assert.strictEqual(info.adapterPath, path.join(cfg, 'delegate', 'projects', 'github.com-acme-shop.md'));
  assert.deepStrictEqual(info.sourceFiles, ['.claude/rules/frontend.md', 'CLAUDE.md']);
});

test('the adapter stays fresh when only body text changes', () => {
  const p = load(mkTmpConfig());
  const r = repo();
  const info = p.adapterInfo(r);
  writeAdapter(info.adapterPath, info);
  fs.appendFileSync(path.join(r, '.claude', 'rules', 'frontend.md'), 'more rule text\n');
  fs.appendFileSync(path.join(r, 'CLAUDE.md'), 'not a heading\n');
  assert.strictEqual(p.adapterInfo(r).status, 'fresh');
});

test('the adapter ignores project skills, so a skill change keeps it fresh', () => {
  const p = load(mkTmpConfig());
  const r = repo();
  const info = p.adapterInfo(r);
  writeAdapter(info.adapterPath, info);
  fs.writeFileSync(path.join(r, '.claude', 'skills', 'bug-fix', 'SKILL.md'), '---\nname: bug-fix\ndescription: changed\n---\n');
  assert.strictEqual(p.adapterInfo(r).status, 'fresh');
});

test('the adapter goes stale when a rule or CLAUDE.md structural line changes', () => {
  const p = load(mkTmpConfig());
  const r = repo();

  let info = p.adapterInfo(r);
  writeAdapter(info.adapterPath, info);
  fs.writeFileSync(path.join(r, '.claude', 'rules', 'new-rule.md'), '# New rule\n');
  assert.strictEqual(p.adapterInfo(r).status, 'stale', 'new rule file');

  info = p.adapterInfo(r);
  writeAdapter(info.adapterPath, info);
  fs.writeFileSync(path.join(r, '.claude', 'rules', 'frontend.md'), '# Frontend changed\nrule\n');
  assert.strictEqual(p.adapterInfo(r).status, 'stale', 'rule heading change');

  info = p.adapterInfo(r);
  writeAdapter(info.adapterPath, info);
  fs.appendFileSync(path.join(r, 'CLAUDE.md'), '## New section\n');
  assert.strictEqual(p.adapterInfo(r).status, 'stale', 'CLAUDE.md new heading');
});

test('a subdirectory resolves to the repository root', () => {
  const p = load(mkTmpConfig());
  const r = repo();
  fs.mkdirSync(path.join(r, 'pkgs', 'app'), { recursive: true });
  assert.strictEqual(p.adapterInfo(path.join(r, 'pkgs', 'app')).sourceHash, p.adapterInfo(r).sourceHash);
});

test('manualSection returns the manual section verbatim, or a bare heading', () => {
  const p = load(mkTmpConfig());
  const r = repo();
  const info = p.adapterInfo(r);
  assert.strictEqual(p.manualSection(info.adapterPath), '## Manual\n');
  writeAdapter(info.adapterPath, info, '## Manual\n- keep me\n- and me\n');
  assert.strictEqual(p.manualSection(info.adapterPath), '## Manual\n- keep me\n- and me\n');
});
