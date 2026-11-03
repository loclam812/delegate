const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-guard.js');

function setup(config) {
  const dir = mkTmpConfig();
  fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'config.json'), JSON.stringify(config));
  return dir;
}
const call = (dir, input, session = 's1') => {
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: session, tool_input: input }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const state = (dir, s = 's1') => JSON.parse(fs.readFileSync(path.join(dir, 'delegate', 'state', `${s}.json`), 'utf8'));
// The prompt points at a delegate brief, which already carries the report contract.
const withModel = { description: 'x', prompt: 'Read /runs/t/brief-1.md', subagent_type: 'general-purpose', model: 'haiku' };

test('a call with a model and the backstop off has no opinion', () => {
  const dir = setup({ guardMode: 'deny', backstop: false });
  assert.strictEqual(call(dir, withModel), null);
});

test('warn mode adds the tier table as context when model is missing', () => {
  const dir = setup({ guardMode: 'warn', backstop: false });
  const out = call(dir, { description: 'x', prompt: 'Read /runs/t/brief-1.md' });
  assert.strictEqual(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /pins haiku or sonnet/);
});

test('a fork call has no opinion even without a model, in deny mode with the backstop off', () => {
  const dir = setup({ guardMode: 'deny', backstop: false });
  assert.strictEqual(call(dir, { description: 'x', prompt: 'p', subagent_type: 'fork' }), null);
});

test('deny mode refuses a call without a model and does not reserve a spawn', () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  const out = call(dir, { description: 'x', prompt: 'p' });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /first review of a task: opus/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'delegate', 'state', 's1.json')), false);
});

test('backstop asks on the 4th spawn, raises the allowance by 3, asks again on the 7th', () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  for (let i = 1; i <= 3; i += 1) assert.strictEqual(call(dir, withModel), null, `spawn ${i}`);
  const ask = call(dir, withModel);
  assert.strictEqual(ask.permissionDecision, 'ask');
  assert.match(ask.additionalContext, /needed the user's approval \(spawn 4, allowance was 3\)/);
  assert.deepStrictEqual(state(dir), { spawned: 4, allowance: 6 });
  assert.strictEqual(call(dir, withModel), null);
  assert.strictEqual(call(dir, withModel), null);
  assert.strictEqual(call(dir, withModel).permissionDecision, 'ask');
});

test('warn mode + missing model: an ask combines the tier table and the backstop line', () => {
  const dir = setup({ guardMode: 'warn', backstop: true });
  const noModel = { description: 'x', prompt: 'p' };
  for (let i = 1; i <= 3; i += 1) call(dir, noModel);
  const out = call(dir, noModel);
  assert.strictEqual(out.permissionDecision, 'ask');
  assert.match(out.additionalContext, /pins haiku or sonnet/);
  assert.match(out.additionalContext, /needed the user's approval \(spawn 4, allowance was 3\)/);
});

test('a parallel burst of 4 calls produces exactly one ask', async () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  const one = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1', tool_input: withModel }));
  });
  const outs = await Promise.all([one(), one(), one(), one()]);
  assert.strictEqual(outs.filter((o) => o.includes('"ask"')).length, 1);
  assert.strictEqual(state(dir).spawned, 4);
});

test('no session_id: no opinion and no state file', () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: withModel }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(fs.existsSync(path.join(dir, 'delegate', 'state')), false);
});

test('no tool_input: no opinion', () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1' }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.stdout, '');
});

test('a lock that stays held: no opinion, error logged', () => {
  const dir = setup({ guardMode: 'deny', backstop: true });
  fs.mkdirSync(path.join(dir, 'delegate', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'state', 's1.json.lock'), '');
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1', tool_input: withModel }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(fs.readFileSync(path.join(dir, 'delegate', 'hook-errors.log'), 'utf8'), /lock busy/);
});

test('a spawn without a brief gets the report contract appended and auto-allowed', () => {
  const dir = setup({ guardMode: 'deny', backstop: false });
  const input = { description: 'Review auth', prompt: 'review src/auth', subagent_type: 'code-reviewer', model: 'opus' };
  const out = call(dir, input, 'sess-9');
  assert.strictEqual(out.permissionDecision, 'allow');
  assert.strictEqual(out.updatedInput.model, 'opus');
  assert.strictEqual(out.updatedInput.subagent_type, 'code-reviewer');
  assert.ok(out.updatedInput.prompt.startsWith('review src/auth\n'));
  assert.match(out.updatedInput.prompt, /\[report-contract\]/);
  assert.match(out.updatedInput.prompt, new RegExp(`${dir}/delegate/reports/sess-9/\\d+-Review_auth\\.md`));
});

test('the contract is not appended twice, nor to locators, read-only agents or forks', () => {
  const dir = setup({ guardMode: 'deny', backstop: false });
  const base = { description: 'x', model: 'haiku' };
  assert.strictEqual(call(dir, { ...base, prompt: 'p\n[report-contract] already', subagent_type: 'general-purpose' }), null);
  for (const t of ['Explore', 'caveman:cavecrew-investigator', 'Plan', 'planner', 'architect', 'fork']) {
    assert.strictEqual(call(dir, { ...base, prompt: 'p', subagent_type: t }), null, t);
  }
});

test('a backstop ask keeps ask and still carries the contract', () => {
  const dir = setup({ guardMode: 'deny', backstop: true, initialAllowance: 0 });
  const out = call(dir, { description: 'x', prompt: 'p', subagent_type: 'general-purpose', model: 'sonnet' });
  assert.strictEqual(out.permissionDecision, 'ask');
  assert.match(out.updatedInput.prompt, /\[report-contract\]/);
  assert.match(out.additionalContext, /needed the user's approval/);
});
