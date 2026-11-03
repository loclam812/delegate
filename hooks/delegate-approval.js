#!/usr/bin/env node
// PostToolUse(AskUserQuestion): an answer the user chose that carries
// [delegate-approve:N] grants N more spawns to this session. Only chosen answers
// count, never the options offered, or a rejected proposal would still approve.
// Answers from an AFK timeout, or from a round the user left for follow-up questions, never approve.
const lib = require('./delegate-lib');

const MARKER = /\[delegate-approve:(\d+)\]/;
const MAX_BUDGET = 50;

function selectedAnswers(p) {
  const answers = (p.tool_response && p.tool_response.answers) || {};
  return Object.values(answers).filter((a) => typeof a === 'string');
}

function approvedBudget(p) {
  const r = p.tool_response || {};
  if (r.afkTimeoutMs || r.followUp) return 0;
  for (const label of selectedAnswers(p)) {
    const m = MARKER.exec(label);
    const n = m ? Number(m[1]) : 0;
    if (Number.isSafeInteger(n) && n > 0) return Math.min(n, MAX_BUDGET);
  }
  return 0;
}

lib.runHook('delegate-approval', (p) => {
  if (p.tool_name !== 'AskUserQuestion') return null;
  const budget = approvedBudget(p);
  if (!budget || !p.session_id) return null;
  const config = lib.readConfig();
  lib.withLock(lib.statePath(p.session_id), () => {
    const state = lib.readState(p.session_id, config);
    lib.writeState(p.session_id, { spawned: state.spawned, allowance: Math.max(state.allowance, state.spawned + budget) });
  });
  return null;
});
