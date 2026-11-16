const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-git-guard.js');

function run(command, { agentId = 'a1', config } = {}) {
  const dir = mkTmpConfig();
  if (config) {
    fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'delegate', 'config.json'), JSON.stringify(config));
  }
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's1', tool_input: { command } };
  if (agentId) payload.agent_id = agentId;
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('a subagent may not commit, push, stage or rewrite the working tree through git', () => {
  for (const command of [
    'git commit -m "x"',
    'git push origin main',
    'git add -A',
    'git stash',
    'git reset --hard HEAD',
    'git checkout -- src/a.js',
    'git rebase main',
    'cd repo && git -C sub commit -am x',
    'npm test; git --no-pager push',
  ]) {
    const out = run(command);
    assert.strictEqual(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /subagent/);
  }
});

test('a subagent may still read git state', () => {
  for (const command of ['git status --short', 'git diff --stat', 'git log --oneline -5', 'git show HEAD:a.js', 'echo "git commit later"']) {
    assert.strictEqual(run(command), null, command);
  }
});

test('the main session is not limited', () => {
  assert.strictEqual(run('git commit -m x', { agentId: null }), null);
});

test('gitGuard false in config turns the guard off', () => {
  assert.strictEqual(run('git push', { config: { gitGuard: false } }), null);
});

test('hooks.json runs the git guard before every Bash call', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8')).hooks;
  const bash = hooks.PreToolUse.find((entry) => entry.matcher === 'Bash');
  assert.ok(bash && bash.hooks.some((h) => h.command.includes('delegate-git-guard.js')));
});

test('writes the first guard missed are denied too', () => {
  for (const command of [
    'git pull',
    'git rm src/a.js',
    'git mv a b',
    'git branch -D feature',
    'git update-index --assume-unchanged a.js',
    'git --git-dir .git commit -m x',
    '/usr/bin/git push',
    'git -c user.name=x commit -m y',
    'FOO=1 git stash push',
  ]) {
    const out = run(command);
    assert.strictEqual(out && out.permissionDecision, 'deny', command);
  }
});

test('read-only git and text that only mentions git pass', () => {
  for (const command of [
    'git merge-base main HEAD',
    'git stash list',
    'git stash show -p',
    'git tag -l',
    'git tag',
    'git branch --show-current',
    'git branch -a',
    'echo "git push"',
    "printf 'git commit\\n'",
    'git worktree list',
  ]) {
    assert.strictEqual(run(command), null, command);
  }
});

test('a long command line is checked fast', () => {
  const started = Date.now();
  run(`git ${'-c a=b '.repeat(2000)}status`);
  assert.ok(Date.now() - started < 3000);
});

test('git after a shell keyword, behind a quoted option value, or a ref or worktree write is denied', () => {
  for (const command of [
    'while true; do git add .; done',
    'if true; then git commit -m x; fi',
    '! git push',
    'git -C "my dir" commit -m x',
    "git -c 'user.name=A B' commit -m x",
    'git worktree remove ../wt',
    'git update-ref refs/heads/main HEAD~1',
    'git symbolic-ref HEAD refs/heads/other',
    'git bisect start',
  ]) {
    const out = run(command);
    assert.strictEqual(out && out.permissionDecision, 'deny', command);
  }
  assert.strictEqual(run('git -C "my dir" status'), null);
  assert.strictEqual(run('git worktree list'), null);
});
