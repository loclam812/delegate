#!/usr/bin/env node
// SubagentStop: a subagent whose final reply is long is sent back once to move it into a
// report file, because the parent re-reads that reply on every later call of its session.
const path = require('path');
const lib = require('./delegate-lib');

const MAX_LINES = 15;
const MAX_CHARS = 2000;

lib.runHook('delegate-reply-guard', (p) => {
  // The second stop always passes, so an agent that cannot write a file is never trapped.
  if (p.stop_hook_active) return null;
  if (!p.agent_type || lib.REPORT_EXEMPT.has(p.agent_type)) return null;
  const reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  if (reply.split('\n').length <= MAX_LINES && reply.length <= MAX_CHARS) return null;
  const reportPath = path.join(lib.reportsDir(p.session_id), `${lib.sanitize(p.agent_id || Date.now())}.md`);
  return {
    decision: 'block',
    reason: `Your reply is ${reply.split('\n').length} lines / ${reply.length} chars; the cap is ${MAX_LINES} lines / ${MAX_CHARS} chars. `
      + `Write that full reply to ${reportPath} (create the directory if needed), then reply again in 10 lines or fewer: `
      + 'status, finding counts by severity or files changed, concerns, and the report path.',
  };
});
