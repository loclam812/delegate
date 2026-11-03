const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpConfig, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'delegate-session-start.js');
const start = (dir) => runNode(HOOK, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }), { CLAUDE_CONFIG_DIR: dir });

test('session start injects the delegate trigger as additional context', () => {
  const r = start(mkTmpConfig());
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /invoke the `delegate:delegate` skill first/);
});

test('the off switch silences session start', () => {
  const dir = mkTmpConfig();
  fs.mkdirSync(path.join(dir, 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delegate', 'off'), '');
  const r = start(dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});
