#!/usr/bin/env node
// SubagentStop and PostToolUse(Agent) → usage lines in the delegation log.
// delegate-report.js merges the two by agent_id (origin from post_tool, metrics from either).
const fs = require('fs');
const lib = require('./delegate-lib');
const { parseTranscriptUsage, usageOf } = require('./delegate-transcript');

function common(p) {
  return {
    ts: new Date().toISOString(),
    project: lib.projectSlug(p.cwd || process.cwd()),
    session: p.session_id || null,
  };
}

function fromSubagentStop(p) {
  let usage = { model: null, tokens: null, tool_uses: null, duration_ms: null };
  let parseError = null;
  try {
    if (!p.agent_transcript_path) throw new Error('no agent_transcript_path');
    usage = parseTranscriptUsage(p.agent_transcript_path);
  } catch (e) {
    parseError = String(e.message || e);
  }
  return {
    ...common(p),
    agent_id: p.agent_id || null,
    origin: null,
    agent_type: p.agent_type || null,
    model: usage.model,
    tokens: usage.tokens,
    tool_uses: usage.tool_uses,
    duration_ms: usage.duration_ms,
    reply_chars: typeof p.last_assistant_message === 'string' ? p.last_assistant_message.length : null,
    review: lib.parseReviewLine(p.last_assistant_message),
    source: 'transcript',
    parse_error: parseError,
  };
}

function fromPostTool(p) {
  const r = p.tool_response || {};
  const input = p.tool_input || {};
  const agentId = r.agentId || r.agent_id || null;
  if (!agentId) return null;
  const hasMetrics = typeof r.totalTokens === 'number';
  return {
    ...common(p),
    agent_id: agentId,
    origin: lib.originOf(input.description),
    agent_type: input.subagent_type || null,
    description: input.description || null,
    model: r.resolvedModel || input.model || null,
    tokens: hasMetrics ? usageOf(r.usage || {}) : null,
    tool_uses: hasMetrics ? (r.totalToolUseCount ?? null) : null,
    duration_ms: hasMetrics ? (r.totalDurationMs ?? null) : null,
    reply_chars: null,
    source: 'post_tool',
    parse_error: null,
  };
}

const isSubagentStop = (p) => p.hook_event_name === 'SubagentStop' || (!p.tool_name && 'agent_transcript_path' in p);

const isHarnessInternal = (p) => isSubagentStop(p) && !p.agent_type
  && (!p.agent_transcript_path || !fs.existsSync(p.agent_transcript_path));

lib.runHook('delegate-log', (p) => {
  if (isHarnessInternal(p)) return null;
  const line = isSubagentStop(p) ? fromSubagentStop(p) : fromPostTool(p);
  if (line) lib.appendJsonl(lib.logPath(), line);
  return null;
});
