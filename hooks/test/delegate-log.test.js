const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-log.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-small.jsonl');
const { parseTranscriptUsage } = require('../delegate-transcript');

const readLog = (dir) => {
  const f = path.join(dir, 'delegation-log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
};

test('parser takes the maximum usage per message id, not the sum of every line', () => {
  const u = parseTranscriptUsage(FIXTURE);
  assert.strictEqual(u.model, 'claude-haiku-4-5-20251001');
  assert.deepStrictEqual(u.tokens, { in: 15, out: 60, cache_read: 500, cache_write_5m: 500, cache_write_1h: 300 });
  assert.strictEqual(u.tool_uses, 1);
  assert.strictEqual(u.duration_ms, 10000);
});

test('parser handles a 5,000-line transcript in under 500 ms', () => {
  const dir = mkTmpConfig();
  const file = path.join(dir, 'big.jsonl');
  const lines = [];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(1e12 + i * 1000).toISOString(), message: { id: `m${i}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'x'.repeat(200) }], usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } } }));
  }
  fs.writeFileSync(file, lines.join('\n'));
  const t0 = Date.now();
  const u = parseTranscriptUsage(file);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(u.tokens.out, 10000);
});

test('SubagentStop writes one transcript line with metrics and reply size', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: FIXTURE, last_assistant_message: 'done!' };
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  const lines = readLog(dir);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].agent_id, 'a1');
  assert.strictEqual(lines[0].source, 'transcript');
  assert.strictEqual(lines[0].tokens.out, 60);
  assert.strictEqual(lines[0].reply_chars, 5);
  assert.strictEqual(lines[0].parse_error, null);
});

test('SubagentStop records the counts of a REVIEW line, and null without one', () => {
  const dir = mkTmpConfig();
  const send = (id, msg) => runNode(HOOK, JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: id, agent_type: 'code-reviewer', agent_transcript_path: FIXTURE, last_assistant_message: msg }), { CLAUDE_CONFIG_DIR: dir });
  send('r1', 'REVIEW verdict=block C=1 H=0 M=0 L=4\nreport: /r.md');
  send('r2', 'done!');
  const lines = readLog(dir);
  assert.deepStrictEqual(lines.find((l) => l.agent_id === 'r1').review, { verdict: 'block', C: 1, H: 0, M: 0, L: 4 });
  assert.strictEqual(lines.find((l) => l.agent_id === 'r2').review, null);
});

test('SubagentStop with a missing transcript logs parse_error and still exits 0', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a2', agent_type: 'general-purpose', agent_transcript_path: path.join(dir, 'nope.jsonl') };
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const [line] = readLog(dir);
  assert.strictEqual(line.tokens, null);
  assert.match(line.parse_error, /ENOENT/);
  assert.strictEqual(line.reply_chars, null);
});

test('SubagentStop with empty agent_type and a missing transcript writes nothing', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a6', agent_type: '', agent_transcript_path: path.join(dir, 'nope.jsonl') };
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(readLog(dir).length, 0);
});

test('SubagentStop with empty agent_type but an existing transcript still writes its line', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a7', agent_type: '', agent_transcript_path: FIXTURE, last_assistant_message: 'done!' };
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const lines = readLog(dir);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].agent_id, 'a7');
  assert.strictEqual(lines[0].tokens.out, 60);
});

test('SubagentStop with a transcript that has no assistant usage logs parse_error', () => {
  const dir = mkTmpConfig();
  const file = path.join(dir, 'no-usage.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user', content: 'go' } })}\n`);
  const payload = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a5', agent_type: 'general-purpose', agent_transcript_path: file };
  const r = runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const [line] = readLog(dir);
  assert.strictEqual(line.tokens, null);
  assert.match(line.parse_error, /no assistant usage entries/);
});

test('PostToolUse(Agent) with an agent id writes an origin-tagged line', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', cwd: dir,
    tool_input: { description: '[delegate:batch1] impl T1', subagent_type: 'general-purpose', model: 'haiku' },
    tool_response: { agentId: 'a3', resolvedModel: 'claude-haiku-4-5-20251001', totalTokens: 900, totalToolUseCount: 4, totalDurationMs: 1200, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 } } };
  runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  const [line] = readLog(dir);
  assert.strictEqual(line.origin, 'delegate:batch1');
  assert.strictEqual(line.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(line.agent_id, 'a3');
  assert.strictEqual(line.source, 'post_tool');
  assert.strictEqual(line.tokens.out, 50);
  assert.strictEqual(line.tool_uses, 4);
  assert.strictEqual(line.description, '[delegate:batch1] impl T1');
});

test('PostToolUse(Agent) for a background launch keeps origin without metrics', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', cwd: dir,
    tool_input: { description: 'explore', subagent_type: 'Explore', model: 'haiku' }, tool_response: { agentId: 'a4' } };
  runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  const [line] = readLog(dir);
  assert.strictEqual(line.origin, 'unrouted');
  assert.strictEqual(line.tokens, null);
});

test('PostToolUse(Agent) without an agent id writes nothing', () => {
  const dir = mkTmpConfig();
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', cwd: dir, tool_input: {}, tool_response: {} };
  runNode(HOOK, JSON.stringify(payload), { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(readLog(dir).length, 0);
});
