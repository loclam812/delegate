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

const fs = require('fs');
function transcriptWith(prompt) {
  const dir = mkTmpConfig();
  const file = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  return { dir, file };
}
const REVIEW_ASK = 'Review the diff. Reply with this exact line: `REVIEW verdict=<approve|fix|block> C=<n> H=<n> M=<n> L=<n>`';

test('a review asked for the REVIEW line is sent back once when its reply lacks it', () => {
  const { file } = transcriptWith(REVIEW_ASK);
  const { out } = stop({ agent_type: 'code-reviewer', agent_transcript_path: file, last_assistant_message: 'Status: done, 2 findings' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /REVIEW verdict=<approve\|fix\|block> C=<n> H=<n> M=<n> L=<n>/);
});

test('the ask can come from the brief file the prompt points at', () => {
  const { dir, file } = transcriptWith('');
  const brief = path.join(dir, 'brief-2.md');
  fs.writeFileSync(brief, `# Brief\n\n${REVIEW_ASK}\n`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Read ${brief} and do it.` }] } })}\n`);
  assert.strictEqual(stop({ agent_type: 'general-purpose', agent_transcript_path: file, last_assistant_message: 'done' }).out.decision, 'block');
});

test('a reply with the REVIEW line, or an agent never asked for it, passes', () => {
  const asked = transcriptWith(REVIEW_ASK).file;
  assert.strictEqual(stop({ agent_type: 'code-reviewer', agent_transcript_path: asked, last_assistant_message: 'REVIEW verdict=approve C=0 H=0 M=0 L=1\nreport: /r.md' }).out, null);
  const notAsked = transcriptWith('Review this file and list problems.').file;
  assert.strictEqual(stop({ agent_type: 'code-reviewer', agent_transcript_path: notAsked, last_assistant_message: 'two problems' }).out, null);
  assert.strictEqual(stop({ agent_type: 'code-reviewer', agent_transcript_path: asked, last_assistant_message: 'no line', stop_hook_active: true }).out, null);
});

test('a long review reply sent back for length is told to keep its REVIEW line', () => {
  const { file } = transcriptWith(REVIEW_ASK);
  const reply = `REVIEW verdict=fix C=0 H=1 M=0 L=0\n${longReply}`;
  const { out } = stop({ agent_type: 'code-reviewer', agent_transcript_path: file, last_assistant_message: reply });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /keep .*REVIEW verdict=/);
});
