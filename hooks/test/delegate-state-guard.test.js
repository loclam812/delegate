const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-state-guard.js');

function run(tool, input) {
  const dir = mkTmpConfig();
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 's1', tool_input: input(dir) }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('a Write or Edit into the delegate state directory is denied', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    const out = run(tool, (dir) => ({ file_path: path.join(dir, 'delegate', 'state', 's1.json'), content: '{}' }));
    assert.strictEqual(out && out.permissionDecision, 'deny', tool);
    assert.match(out.permissionDecisionReason, /delegate-approve:N/);
  }
});

test('a shell command that writes there is denied; reading it is not', () => {
  assert.strictEqual(run('Bash', (dir) => ({ command: `echo '{}' > ${dir}/delegate/state/s1.json` })).permissionDecision, 'deny');
  assert.strictEqual(run('Bash', () => ({ command: 'rm ~/.claude/delegate/state/s1.json' })).permissionDecision, 'deny');
  assert.strictEqual(run('Bash', () => ({ command: 'cat ~/.claude/delegate/state/s1.json' })), null);
});

test('writes elsewhere under delegate pass', () => {
  assert.strictEqual(run('Write', (dir) => ({ file_path: path.join(dir, 'delegate', 'runs', 'x', 'brief-1.md'), content: 'b' })), null);
  assert.strictEqual(run('Bash', () => ({ command: 'echo hi > /tmp/state.json' })), null);
});

test('hooks.json runs the state guard before writes and shell calls', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes('delegate-state-guard.js')));
  assert.ok(entry);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash']) assert.match(tool, new RegExp(`^(${entry.matcher})$`));
});

test('the files beside state that switch the guard off are protected too', () => {
  for (const command of [
    'touch ~/.claude/delegate/off',
    'echo \'{"backstop":false}\' > ~/.claude/delegate/config.json',
    'rm -rf ~/.claude/delegate',
    'node -e "require(\'fs\').writeFileSync(process.env.HOME+\'/.claude/delegate/state/s1.json\',\'{}\')"',
    'cd ~/.claude/delegate && rm -rf state',
    'ln -s ~/.claude/delegate/state /tmp/s',
  ]) {
    assert.strictEqual(run('Bash', () => ({ command }))?.permissionDecision, 'deny', command);
  }
  for (const name of ['config.json', 'off']) {
    assert.strictEqual(run('Write', (dir) => ({ file_path: path.join(dir, 'delegate', name), content: 'x' }))?.permissionDecision, 'deny', name);
  }
});

test('reading the state, or copying it out, still passes', () => {
  for (const command of [
    'cat ~/.claude/delegate/state/s1.json 2>/dev/null',
    'jq .allowance < ~/.claude/delegate/state/s1.json',
    'ls -la ~/.claude/delegate/state',
    'cp ~/.claude/delegate/state/s1.json /tmp/s1.json',
    'test "$(cat ~/.claude/delegate/state/s1.json | wc -c)" -ge 2',
  ]) {
    assert.strictEqual(run('Bash', () => ({ command })), null, command);
  }
});
