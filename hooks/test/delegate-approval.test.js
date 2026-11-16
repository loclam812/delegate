const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-approval.js');
const GUARD = path.join(__dirname, '..', 'delegate-guard.js');

function setup(stateObj) {
  const dir = mkTmpConfig();
  fs.mkdirSync(path.join(dir, 'delegate', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'config.json'), JSON.stringify({ guardMode: 'deny', backstop: true }));
  if (stateObj) fs.writeFileSync(path.join(dir, 'delegate', 'state', 's1.json'), JSON.stringify(stateObj));
  return dir;
}
const question = 'Run the 5-file batch as proposed?';
const options = [{ label: 'Approve [delegate-approve:8]', description: 'x' }, { label: 'Reject', description: 'y' }];
// Mirrors the real 2.1.282 payload (FINDINGS Q1): the offered options appear in BOTH
// tool_input and tool_response, next to the chosen answers.
function payload(label, { extra = {}, q = question, opts = options, annotations = {}, session = 's1', tool = 'AskUserQuestion' } = {}) {
  const questions = [{ question: q, header: 'Batch', options: opts, multiSelect: false }];
  return {
    hook_event_name: 'PostToolUse', tool_name: tool, session_id: session,
    tool_input: { questions, answers: { [q]: label }, annotations },
    tool_response: { questions, answers: { [q]: label }, annotations, ...extra },
  };
}
const send = (dir, p) => runNode(HOOK, JSON.stringify(p), { CLAUDE_CONFIG_DIR: dir });
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'delegate', 'state', 's1.json'), 'utf8'));

test('an approving answer sets the allowance to spawned + N', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  const r = send(dir, payload('Approve [delegate-approve:8]'));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 10 });
});

test('a rejecting answer changes nothing even though the options carry the marker', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  send(dir, payload('Reject'));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 3 });
});

test('a marker in the question, a description or the annotations never approves', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  const q = '[delegate-approve:9] Proceed?';
  const opts = [{ label: 'Go', description: '[delegate-approve:9]' }, { label: 'Reject', description: 'no' }];
  send(dir, payload('Reject', { q, opts, annotations: { [q]: { notes: '[delegate-approve:9]' } } }));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 3 });
});

test('an approval never lowers a larger allowance', () => {
  const dir = setup({ spawned: 0, allowance: 12 });
  send(dir, payload('Approve [delegate-approve:5]'));
  assert.deepStrictEqual(state(dir), { spawned: 0, allowance: 12 });
});

test('a zero or malformed budget is ignored', () => {
  const dir = setup({ spawned: 5, allowance: 3 });
  send(dir, payload('Approve [delegate-approve:0]'));
  send(dir, payload('Approve [delegate-approve:many]'));
  assert.deepStrictEqual(state(dir), { spawned: 5, allowance: 3 });
});

test('a budget above 50 is clamped to 50', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  send(dir, payload('Approve [delegate-approve:500]'));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 52 });
});

test('answers submitted by AFK timeout or as a follow-up never approve', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  send(dir, payload('Approve [delegate-approve:8]', { extra: { afkTimeoutMs: 30000 } }));
  send(dir, payload('Approve [delegate-approve:8]', { extra: { followUp: true } }));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 3 });
});

test('another tool with an answers field never approves', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  send(dir, payload('Approve [delegate-approve:8]', { tool: 'mcp__survey__ask' }));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 3 });
});

test('no session_id: nothing is written', () => {
  const dir = setup(null);
  const p = payload('Approve [delegate-approve:8]');
  delete p.session_id;
  const r = send(dir, p);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'delegate', 'state')), []);
});

test('after an approval of 8 with 2 spawned, the guard lets spawns 3-10 through and asks on 11', () => {
  const dir = setup({ spawned: 2, allowance: 3 });
  send(dir, payload('Approve [delegate-approve:8]'));
  const input = { description: 'x', prompt: 'Read /runs/t/brief-1.md', model: 'haiku', effort: 'low' };
  const guard = () => runNode(GUARD, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1', tool_input: input }), { CLAUDE_CONFIG_DIR: dir }).stdout;
  for (let i = 3; i <= 10; i += 1) assert.strictEqual(guard(), '', `spawn ${i}`);
  assert.match(guard(), /"ask"/);
});

test('an approval keeps the backstop asks still waiting to run', () => {
  const dir = setup({ spawned: 2, allowance: 3, pending: ['t9'] });
  send(dir, payload('Approve [delegate-approve:8]'));
  assert.deepStrictEqual(state(dir), { spawned: 2, allowance: 10, pending: ['t9'] });
});
