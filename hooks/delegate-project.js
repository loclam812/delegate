#!/usr/bin/env node
// Resolves the current project's adapter: slug, path, a hash of the files the
// adapter is generated from, and whether the stored adapter is missing or stale.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const lib = require('./delegate-lib');

function repoRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function walk(dir, keep, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
}

function sourceFiles(root) {
  const out = ['CLAUDE.md', 'AGENTS.md'].map((f) => path.join(root, f)).filter((p) => fs.existsSync(p));
  walk(path.join(root, '.claude', 'rules'), (p) => p.endsWith('.md'), out);
  return out.map((f) => path.relative(root, f)).sort();
}

const RULES_PREFIX = path.join('.claude', 'rules') + path.sep;

function hashInput(root, rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (rel.startsWith(RULES_PREFIX)) {
    return text.split('\n').find((l) => l.startsWith('#')) || '';
  }
  return text
    .split('\n')
    .filter((l) => l.startsWith('#'))
    .join('\n');
}

// Only the parts an adapter is actually built from (rule headings,
// CLAUDE.md/AGENTS.md headings) count toward staleness, so
// unrelated body edits in another worktree don't trigger a regeneration.
function sourceHash(root) {
  const h = crypto.createHash('sha256');
  for (const rel of sourceFiles(root)) {
    h.update(rel);
    h.update('\0');
    h.update(hashInput(root, rel));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function adapterInfo(cwd) {
  const root = repoRoot(cwd);
  const slug = lib.projectSlug(root);
  const adapterPath = path.join(lib.delegateDir(), 'projects', `${slug}.md`);
  const hash = sourceHash(root);
  let storedHash = null;
  let status = 'missing';
  if (fs.existsSync(adapterPath)) {
    const m = /source-hash: ([0-9a-f]+)/.exec(fs.readFileSync(adapterPath, 'utf8'));
    storedHash = m ? m[1] : null;
    status = storedHash === hash ? 'fresh' : 'stale';
  }
  return { root, slug, adapterPath, sourceHash: hash, storedHash, status, sourceFiles: sourceFiles(root) };
}

function manualSection(adapterPath) {
  if (!fs.existsSync(adapterPath)) return '## Manual\n';
  const text = fs.readFileSync(adapterPath, 'utf8');
  const i = text.search(/^## Manual[ \t]*$/m);
  return i === -1 ? '## Manual\n' : text.slice(i);
}

if (require.main === module) {
  const info = adapterInfo(process.cwd());
  process.stdout.write(process.argv.includes('--manual') ? manualSection(info.adapterPath) : `${JSON.stringify(info, null, 2)}\n`);
}

module.exports = { adapterInfo, sourceHash, manualSection };
