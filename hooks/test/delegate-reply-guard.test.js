const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-reply-guard.js');

const stop = (fields) => {
  const dir = mkTmpConfig();
  const r = runNode(HOOK, JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', stop_hook_active: false, ...fields }), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  return { out: r.stdout ? JSON.parse(r.stdout) : null, dir };
};
const longReply = Array.from({ length: 40 }, (_, i) => `finding ${i}`).join('\n');

test('a long reply is blocked once with a report path in the reason', () => {
  const { out, dir } = stop({ agent_type: 'code-reviewer', last_assistant_message: longReply });
  assert.strictEqual(out.decision, 'block');
  assert.ok(out.reason.includes(path.join(dir, 'delegate', 'reports', 's1', 'a1.md')));
});

test('a reply over the character cap is blocked even on few lines', () => {
  const { out } = stop({ agent_type: 'general-purpose', last_assistant_message: 'x'.repeat(2500) });
  assert.strictEqual(out.decision, 'block');
});

test('a short reply passes', () => {
  assert.strictEqual(stop({ agent_type: 'general-purpose', last_assistant_message: 'Status: DONE\nreport: /r.md' }).out, null);
});

test('the second stop passes, so the subagent is never trapped', () => {
  assert.strictEqual(stop({ agent_type: 'code-reviewer', last_assistant_message: longReply, stop_hook_active: true }).out, null);
});

test('locators, read-only agents and harness-internal agents pass', () => {
  for (const t of ['Explore', 'caveman:cavecrew-investigator', 'Plan', 'planner', 'architect', 'workflow-subagent', undefined]) {
    assert.strictEqual(stop({ agent_type: t, last_assistant_message: longReply }).out, null, String(t));
  }
});

test('a short reviewer reply passes with or without the REVIEW line', () => {
  for (const msg of ['Status: DONE\nreport: /r.md', 'REVIEW verdict=approve C=0 H=0 M=1 L=2\nreport: /r.md']) {
    assert.strictEqual(stop({ agent_type: 'code-reviewer', last_assistant_message: msg }).out, null, msg);
  }
});
