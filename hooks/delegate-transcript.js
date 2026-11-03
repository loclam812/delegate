// Usage totals from a subagent transcript (JSONL). The format is undocumented:
// test/fixtures/transcript-small.jsonl pins the shape seen on Claude Code 2.1.282.
// Streamed entries repeat one message's usage, so each message counts once, at its maximum.
const fs = require('fs');

const TOKEN_KEYS = ['in', 'out', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

function usageOf(u) {
  const cc = u.cache_creation || {};
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_write_5m: cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens || 0),
    cache_write_1h: cc.ephemeral_1h_input_tokens || 0,
  };
}

function parseTranscriptUsage(file) {
  const perMessage = new Map();
  let model = null;
  let toolUses = 0;
  let first = null;
  let last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      first = first ?? ts;
      last = ts;
    }
    const m = entry.message;
    if (entry.type !== 'assistant' || !m) continue;
    if (m.model && m.model !== '<synthetic>') model = m.model;
    for (const block of m.content || []) if (block.type === 'tool_use') toolUses += 1;
    const cur = usageOf(m.usage || {});
    const id = m.id || entry.uuid;
    const prev = perMessage.get(id);
    perMessage.set(id, prev ? Object.fromEntries(TOKEN_KEYS.map((k) => [k, Math.max(prev[k], cur[k])])) : cur);
  }
  if (!perMessage.size) throw new Error('no assistant usage entries');
  const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
  for (const u of perMessage.values()) for (const k of TOKEN_KEYS) tokens[k] += u[k];
  return { model, tokens, tool_uses: toolUses, duration_ms: first !== null ? last - first : null };
}

module.exports = { parseTranscriptUsage, usageOf };
