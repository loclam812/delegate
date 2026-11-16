#!/usr/bin/env node
// PreToolUse(Agent): every spawn names its model, and a session asks before it
// spawns past its allowance. Spawns within the allowance are reserved here, not counted on
// completion, because parallel calls in one message all reach PreToolUse before any completes.
// A spawn past it is counted by PostToolUse, the only sign that the user allowed it.
// It also appends the report contract to a prompt that lacks one, so a reviewer's
// full findings land in a file instead of in the parent's context.
const path = require('path');
const lib = require('./delegate-lib');

const TIER_TABLE = [
  'Pass `model` and `effort` on every Agent call. Default tiers:',
  '- locator (find files, symbols, lines; Explore included): haiku, low, even if the type pins another model',
  '- research (read and synthesise claims): sonnet, medium',
  '- implementer: sonnet, medium',
  '- design judgment: opus, high, or do not split',
  '- first review of a task: opus, high; scoped re-review: sonnet, medium; final branch review: opus, high',
  'Other than locators, if the agent type already pins haiku or sonnet in its frontmatter, pass that same model.',
  'If it pins opus or inherit, choose from this table.',
].join('\n');

const CONTRACT_MARK = '[report-contract]';
// A delegate dispatch points at a brief, and the brief template already carries the contract.
const BRIEF_PATH = /brief-\d+\.md/;
const CONTRACT_EXEMPT = new Set([...lib.REPORT_EXEMPT, 'fork']);

function withReportContract(input, sessionId) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt || CONTRACT_EXEMPT.has(input.subagent_type)) return null;
  if (prompt.includes(CONTRACT_MARK) || BRIEF_PATH.test(prompt)) return null;
  const slug = lib.sanitize(input.description || 'agent').slice(0, 40);
  const reportPath = path.join(lib.reportsDir(sessionId), `${Date.now()}-${slug}.md`);
  const contract = `${CONTRACT_MARK} Write your full findings or change log to ${reportPath} (create the directory if needed). `
    + 'Then reply in 10 lines or fewer: status, finding counts by severity (reviews) or files changed (edits), '
    + 'concerns, and the report path. Do not paste the findings into the reply.';
  return { ...input, prompt: `${prompt}\n\n${contract}` };
}

const LOCATORS = new Set(['Explore', 'caveman:cavecrew-investigator']);

// A missing model or a locator off haiku costs money on every call, so deny mode refuses them;
// a missing effort only falls back to the agent's default, so it is a reminder.
function checkModel(input, config) {
  if (input.subagent_type === 'fork') return null;
  const problems = [];
  if (!input.model) problems.push('this Agent call has no model, so it inherits the session model');
  else if (LOCATORS.has(input.subagent_type) && input.model !== 'haiku') problems.push(`a locator (${input.subagent_type}) runs on haiku, not ${input.model}`);
  if (problems.length > 0 && config.guardMode === 'deny') {
    return lib.preToolDecision('deny', `delegate guard: ${problems.join('; ')}.\n${TIER_TABLE}`);
  }
  if (!input.effort) problems.push('this Agent call has no effort');
  if (problems.length === 0) return null;
  return lib.preToolContext(`delegate guard (warn): ${problems.join('; ')}.\n${TIER_TABLE}`);
}

const MAX_PENDING = 20;

// An asked spawn is neither counted nor allowed more until it runs: PostToolUse fires only for an
// approved call, so a declined one leaves the allowance where it was and its retry asks again.
// Without a tool_use_id there is nothing to match the completion to, so the raise happens now.
function backstop(sessionId, toolUseId, config) {
  return lib.withLock(lib.statePath(sessionId), () => {
    const state = lib.readState(sessionId, config);
    const spawned = state.spawned + 1;
    if (spawned <= state.allowance) {
      lib.writeState(sessionId, { ...state, spawned });
      return null;
    }
    const next = toolUseId
      ? { ...state, pending: [...(state.pending || []), toolUseId].slice(-MAX_PENDING) }
      : { ...state, spawned, allowance: state.allowance + config.allowanceStep };
    lib.writeState(sessionId, next);
    const out = lib.preToolDecision('ask', `delegate backstop: this session has already spawned ${state.spawned} agents, its allowance is ${state.allowance}. Allow this one? Allowing raises the allowance by ${config.allowanceStep}.`);
    out.hookSpecificOutput.additionalContext = `delegate backstop: this call needed the user's approval (spawn ${spawned}, allowance was ${state.allowance}). If it ran, the user approved it; if it was blocked, they declined.`;
    return out;
  });
}

function approved(sessionId, toolUseId, config) {
  lib.withLock(lib.statePath(sessionId), () => {
    const state = lib.readState(sessionId, config);
    const pending = state.pending || [];
    if (!pending.includes(toolUseId)) return;
    const spawned = state.spawned + 1;
    // Measured from the approved spawn, so several approvals from one parallel burst do not stack.
    lib.writeState(sessionId, {
      ...state,
      spawned,
      allowance: Math.max(state.allowance, spawned - 1 + config.allowanceStep),
      pending: pending.filter((id) => id !== toolUseId),
    });
  });
}

lib.runHook('delegate-guard', (p) => {
  if (p.hook_event_name === 'PostToolUse') {
    const config = lib.readConfig();
    if (config.backstop && p.session_id && p.tool_use_id) approved(p.session_id, p.tool_use_id, config);
    return null;
  }
  const input = p.tool_input;
  if (!input || typeof input !== 'object') return null;
  const config = lib.readConfig();
  const modelOut = checkModel(input, config);
  if (modelOut && modelOut.hookSpecificOutput.permissionDecision === 'deny') return modelOut;
  const askOut = config.backstop && p.session_id ? backstop(p.session_id, p.tool_use_id, config) : null;
  const updatedInput = withReportContract(input, p.session_id);
  if (!askOut && !modelOut && !updatedInput) return null;
  const out = { ...(modelOut || {}).hookSpecificOutput, ...(askOut || {}).hookSpecificOutput, hookEventName: 'PreToolUse' };
  const context = [modelOut, askOut].filter(Boolean).map((o) => o.hookSpecificOutput.additionalContext).filter(Boolean);
  if (context.length) out.additionalContext = context.join('\n');
  if (updatedInput) {
    out.updatedInput = updatedInput;
    // updatedInput is only honoured alongside allow or ask; allow still loses to any other hook's ask or deny.
    out.permissionDecision = out.permissionDecision || 'allow';
  }
  return { hookSpecificOutput: out };
});
