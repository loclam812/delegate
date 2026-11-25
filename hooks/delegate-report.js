#!/usr/bin/env node
// delegate report: merges the delegation log by agent_id, prices it with the current
// table (the log holds tokens only, so a price change never rewrites history), prints
// markdown, and removes session state older than 7 days.
const fs = require('fs');
const path = require('path');
const lib = require('./delegate-lib');
const { usageOf } = require('./delegate-transcript');

// $ per million tokens. Longest prefix first: claude-opus-5-5 must not fall into claude-opus-5.
const PRICES = [
  ['claude-opus-5-5', { in: 4, out: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 }],
  ['claude-opus-5', { in: 5, out: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 }],
  ['claude-opus-4', { in: 5, out: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 }],
  ['claude-sonnet-4', { in: 3, out: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 }],
  ['claude-fable-5-2', { in: 8, out: 40, cache_read: 0.2, cache_write_5m: 10, cache_write_1h: 16 }],
  ['claude-fable-5-1', { in: 10, out: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 }],
  ['claude-fable-5', { in: 10, out: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 }],
  ['claude-sonnet-5-5', { in: 2, out: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 }],
  ['claude-sonnet-5', { in: 2, out: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4 }],
  ['claude-haiku-4-5', { in: 1, out: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 }],
  ['claude-haiku-5-5', { in: 0.1, out: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 }],
];
const DAY_MS = 86400000;
const isFullId = (m) => typeof m === 'string' && m.startsWith('claude-');

function priceRow(model) {
  return PRICES.find(([prefix]) => (model || '').startsWith(prefix)) || null;
}

function priceFor(model) {
  const hit = priceRow(model);
  return hit ? hit[1] : null;
}

// A shorter row (claude-fable-5 for claude-fable-5-9) prices a new release at an older rate without saying so.
function pricedByFallback(model) {
  const hit = priceRow(model);
  return Boolean(hit) && !/^(\[.*\]|-\d{8})?$/.test(model.slice(hit[0].length));
}

function costOf(rec) {
  const price = priceFor(rec.model);
  if (!price || !rec.tokens) return null;
  return Object.keys(price).reduce((sum, k) => sum + (rec.tokens[k] || 0) * price[k], 0) / 1e6;
}

function takeMetrics(r, l) {
  r.tokens = l.tokens;
  r.tool_uses = l.tool_uses;
  r.duration_ms = l.duration_ms;
}

function mergeByAgent(lines) {
  const byId = new Map();
  const loose = [];
  for (const l of lines) {
    if (!l.agent_id) {
      loose.push({ ...l, origin: l.origin || 'unrouted' });
      continue;
    }
    const r = byId.get(l.agent_id) || { agent_id: l.agent_id, origin: 'unrouted', model: null, tokens: null, reply_chars: null, parse_error: null, metricsFrom: null };
    r.ts = r.ts || l.ts;
    r.project = r.project || l.project;
    r.session = r.session || l.session;
    r.agent_type = r.agent_type || l.agent_type;
    r.description = r.description || l.description || null;
    if (l.source === 'post_tool') {
      r.origin = l.origin || r.origin;
      if (isFullId(l.model) || !r.model) r.model = l.model;
      if (l.tokens && r.metricsFrom !== 'transcript') { takeMetrics(r, l); r.metricsFrom = 'post_tool'; }
    } else {
      if (!isFullId(r.model) && l.model) r.model = l.model;
      if (l.tokens) { takeMetrics(r, l); r.metricsFrom = 'transcript'; }
      r.reply_chars = l.reply_chars ?? null;
      r.parse_error = l.parse_error ?? null;
      r.review = l.review ?? null;
    }
    byId.set(l.agent_id, r);
  }
  return [...byId.values(), ...loose];
}

function cleanupState(stateDir, nowMs) {
  if (!fs.existsSync(stateDir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(stateDir)) {
    const p = path.join(stateDir, f);
    if (nowMs - fs.statSync(p).mtimeMs > 7 * DAY_MS) {
      fs.rmSync(p, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function countGrownSessions(stateDir, config) {
  if (!fs.existsSync(stateDir)) return 0;
  return fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')).filter((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')).allowance > config.initialAllowance;
    } catch {
      return false;
    }
  }).length;
}

function countFixRounds(runsDir) {
  if (!fs.existsSync(runsDir)) return 0;
  let n = 0;
  for (const slug of fs.readdirSync(runsDir)) {
    const slugDir = path.join(runsDir, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const run of fs.readdirSync(slugDir)) {
      const ledger = path.join(slugDir, run, 'ledger.md');
      if (fs.existsSync(ledger)) n += (fs.readFileSync(ledger, 'utf8').match(/fix round/gi) || []).length;
    }
  }
  return n;
}

const SEVERITIES = ['C', 'H', 'M', 'L'];
const noFindings = () => ({ C: 0, H: 0, M: 0, L: 0 });
const TRIAGE_LINE = /triage (\S+?):(\S+) — (.+)$/;

// `<task>: triage <reviewer>:<model> — fixed H1 M2, rejected M1, deferred L3`, written by the
// parent after it triages a review; the model may be a family or a full id.
function parseTriageLine(line) {
  const m = TRIAGE_LINE.exec(line);
  if (!m) return null;
  const t = { key: `${m[1]} ${familyOf(m[2])}`, fixed: noFindings(), rejected: noFindings(), deferred: noFindings() };
  for (const part of m[3].split(',')) {
    const [outcome, ...counts] = part.trim().split(/\s+/);
    if (!t[outcome] || outcome === 'key') continue;
    for (const c of counts) {
      const hit = /^([CHML])(\d+)$/.exec(c);
      if (hit) t[outcome][hit[1]] += +hit[2];
    }
  }
  return t;
}

// Run folders start with their date, which is the window filter.
function readTriage(runsDir, cutoffMs) {
  const sums = new Map();
  if (!fs.existsSync(runsDir)) return sums;
  for (const slug of fs.readdirSync(runsDir)) {
    const slugDir = path.join(runsDir, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const run of fs.readdirSync(slugDir)) {
      const ledger = path.join(slugDir, run, 'ledger.md');
      if (!(Date.parse(run.slice(0, 10)) >= cutoffMs) || !fs.existsSync(ledger)) continue;
      for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
        const t = parseTriageLine(line);
        if (!t) continue;
        const s = sums.get(t.key) || { fixed: noFindings(), rejected: noFindings(), deferred: noFindings() };
        for (const o of ['fixed', 'rejected', 'deferred']) for (const k of SEVERITIES) s[o][k] += t[o][k];
        sums.set(t.key, s);
      }
    }
  }
  return sums;
}

function reviewValueLines(recs, triage) {
  const groups = new Map();
  for (const r of recs.filter((x) => x.model && (lib.isReviewer(x.agent_type) || ['review', 're-review'].includes(roleOf(x))))) {
    const key = `${r.agent_type || '?'} ${familyOf(r.model)}`;
    const g = groups.get(key) || { n: 0, cost: 0, withLine: 0, found: noFindings() };
    g.n += 1;
    g.cost += costOf(r) || 0;
    if (r.review) {
      g.withLine += 1;
      for (const k of SEVERITIES) g.found[k] += r.review[k];
    }
    groups.set(key, g);
  }
  const counts = (o) => SEVERITIES.map((k) => `${k}${o[k]}`).join(' ');
  const total = (o) => SEVERITIES.reduce((s, k) => s + o[k], 0);
  return [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([key, g]) => {
    const t = triage.get(key);
    const head = `- ${key}: ${g.n} reviews, $${g.cost.toFixed(2)}, REVIEW line ${g.withLine}/${g.n}: ${counts(g.found)}`;
    if (!t) return `${head}; no triage`;
    const fixedCHM = t.fixed.C + t.fixed.H + t.fixed.M;
    const perFixed = fixedCHM ? `$${(g.cost / fixedCHM).toFixed(2)} per fixed C/H/M` : 'n/a per fixed C/H/M';
    return `${head}; triage fixed ${counts(t.fixed)}, rejected ${total(t.rejected)}, deferred ${total(t.deferred)}; ${perFixed}`;
  });
}

function group(records, key) {
  const m = new Map();
  for (const r of records) {
    const k = r[key] || '(none)';
    const g = m.get(k) || { n: 0, cost: 0, unpriced: 0, costs: [] };
    g.n += 1;
    const c = costOf(r);
    if (c === null) g.unpriced += 1;
    else {
      g.cost += c;
      g.costs.push(c);
    }
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const isInternal = (r) => !r.agent_type && /ENOENT/.test(r.parse_error || '');
const isDelegate = (r) => String(r.origin || '').startsWith('delegate:');

// Skills such as SDD write their own descriptions, so a spawn without the prefix in a
// session that also ran a prefixed spawn is counted as delegate work, not as a bypass.
function kindOf(records) {
  const delegateSessions = new Set(records.filter((r) => isDelegate(r) && r.session).map((r) => r.session));
  return (r) => {
    if (isInternal(r)) return 'internal';
    if (isDelegate(r)) return 'delegate';
    return delegateSessions.has(r.session) ? 'delegate-session' : 'unrouted';
  };
}

const LOCATOR_TYPES = /^(Explore|caveman:cavecrew-investigator)$/;
const ROLES = [
  // "map" is left out: coverage maps and key maps are research, and counting them made locators look costly.
  ['locator', /\b(locate|find)\b/i],
  ['implementer', /implement|\bfix\b|migrate|\bport\b|apply|sweep|batch/i],
  ['research', /research|investigat|analy[sz]/i],
];

// Lines logged before descriptions were recorded have no role and stay out of the role medians.
function roleOf(r) {
  if (!r.description) return null;
  if (/re-?review/i.test(r.description)) return 're-review';
  if (/review|audit/i.test(r.description) || /reviewer$/.test(r.agent_type || '')) return 'review';
  if (LOCATOR_TYPES.test(r.agent_type || '')) return 'locator';
  const hit = ROLES.find(([, re]) => re.test(r.description));
  return hit ? hit[0] : 'other';
}

function buildReport(records, info) {
  const kind = kindOf(records);
  const recs = records.map((r) => {
    const role = roleOf(r);
    return { ...r, originKind: kind(r), roleKey: role && r.model ? `${familyOf(r.model)} ${role}` : null };
  });
  const nonInternal = recs.filter((r) => r.originKind !== 'internal');
  const fmt = (g) => `${g.n} agents, $${g.cost.toFixed(2)}${g.unpriced ? `, ${g.unpriced} n/a` : ''}`;
  const out = [`# Delegate report (last ${info.days} days)`, '', `Subagents: ${recs.length}`, ''];
  for (const [title, key] of [['By project', 'project'], ['By model', 'model'], ['By origin', 'originKind']]) {
    out.push(`## ${title}`);
    for (const [k, g] of group(recs, key)) out.push(`- ${k}: ${fmt(g)}`);
    out.push('');
  }
  out.push('## Largest unrouted replies (context bloat)');
  nonInternal.filter((r) => r.originKind === 'unrouted' && r.reply_chars).sort((a, b) => b.reply_chars - a.reply_chars).slice(0, 5)
    .forEach((r) => out.push(`- ${r.agent_type || '?'} in ${r.project}: ${r.reply_chars} chars`));
  out.push('', '## Median cost per model (section 5 defaults need 5+ runs)');
  const medianLine = ([k, g]) => `- ${k}: ${g.costs.length >= 5 ? `$${median(g.costs).toFixed(2)} over ${g.costs.length}` : `needs 5, has ${g.costs.length}`}`;
  group(recs, 'model').forEach((e) => out.push(medianLine(e)));
  out.push('', '## Median cost per role (section 5 uses these first)');
  group(recs.filter((r) => r.roleKey), 'roleKey').forEach((e) => out.push(medianLine(e)));
  out.push('', '## Review value (REVIEW lines from replies, triage lines from run ledgers)');
  out.push(...reviewValueLines(nonInternal, info.triage || new Map()));
  const parseErrors = nonInternal.filter((r) => r.parse_error).length;
  const unroutedCost = group(recs, 'originKind').find(([k]) => k === 'unrouted');
  const total = recs.reduce((s, r) => s + (costOf(r) || 0), 0);
  out.push('', '## Health');
  out.push(`- Transcript parse errors: ${parseErrors}`);
  out.push(`- Spawns with no recorded description: ${nonInternal.filter((r) => !r.description).length}`);
  out.push(`- Sessions past the initial allowance: ${info.backstopSessions}`);
  out.push(`- Fix rounds in run ledgers: ${info.fixRounds}`);
  out.push(`- Stale state files removed: ${info.removed}`);
  const fallbackModels = [...new Set(recs.map((r) => r.model).filter((m) => m && pricedByFallback(m)))];
  out.push(`- Priced by family fallback: ${fallbackModels.length ? fallbackModels.join(', ') : 'none'}`);
  out.push('', '## Suggestions');
  if (unroutedCost && total > 0 && unroutedCost[1].cost / total > 0.5) out.push('- Most spend is unrouted: check which skills spawn agents outside delegate.');
  if (nonInternal.length && parseErrors / nonInternal.length > 0.1) out.push('- Over 10% of transcripts failed to parse: the transcript format may have changed; refresh the fixture.');
  return out.join('\n');
}

function readLog() {
  if (!fs.existsSync(lib.logPath())) return [];
  return fs.readFileSync(lib.logPath(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

// --compare walks the raw Claude Code transcripts instead of the delegation log,
// because "before the workflow" predates the log entirely.
function walkJsonl(dir, depth = 0) {
  if (depth > 5) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walkJsonl(p, depth + 1));
    else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
  }
  return files;
}

function parseFileMessages(file) {
  const perMessage = new Map();
  let firstTs = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (firstTs === null && !Number.isNaN(ts)) firstTs = ts;
    const m = entry.message;
    if (entry.type !== 'assistant' || !m || !m.usage || !m.model || m.model === '<synthetic>' || !m.id) continue;
    const out = m.usage.output_tokens || 0;
    const prev = perMessage.get(m.id);
    if (!prev || out > prev.outputTokens) perMessage.set(m.id, { model: m.model, usage: m.usage, timestamp: ts, outputTokens: out });
  }
  return { messages: [...perMessage.values()], firstTs };
}

function familyOf(model) {
  const m = model || '';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'other';
}

function emptyPeriod(days) {
  return { days, mainCost: 0, subCost: 0, subCount: 0, subCosts: [], subCostByFamily: {}, mainCostByFamily: {}, unpriced: {} };
}

function addFamily(byFamily, family, cost) {
  byFamily[family] = (byFamily[family] || 0) + cost;
}

function periodFor(ts, cutoffMs, beforeStartMs) {
  if (Number.isNaN(ts)) return null;
  if (ts >= cutoffMs) return 'after';
  if (ts >= beforeStartMs) return 'before';
  return null;
}

function compareUsage(projectsDir, cutoffMs, beforeDays, nowMs) {
  const beforeStartMs = cutoffMs - beforeDays * DAY_MS;
  const periods = { before: emptyPeriod(beforeDays), after: emptyPeriod((nowMs - cutoffMs) / DAY_MS) };
  for (const file of walkJsonl(projectsDir)) {
    const isSub = file.includes(`${path.sep}subagents${path.sep}`);
    const { messages, firstTs } = parseFileMessages(file);
    for (const msg of messages) {
      const period = periodFor(msg.timestamp, cutoffMs, beforeStartMs);
      if (!period) continue;
      const p = periods[period];
      const cost = costOf({ model: msg.model, tokens: usageOf(msg.usage) });
      if (cost === null) {
        p.unpriced[msg.model] = (p.unpriced[msg.model] || 0) + 1;
        continue;
      }
      if (isSub) { p.subCost += cost; addFamily(p.subCostByFamily, familyOf(msg.model), cost); } else { p.mainCost += cost; addFamily(p.mainCostByFamily, familyOf(msg.model), cost); }
    }
    if (isSub) {
      const period = periodFor(firstTs, cutoffMs, beforeStartMs);
      if (period) {
        periods[period].subCount += 1;
        const fileCost = messages.reduce((s, msg) => s + (costOf({ model: msg.model, tokens: usageOf(msg.usage) }) || 0), 0);
        periods[period].subCosts.push(fileCost);
      }
    }
  }
  return periods;
}

function familyShare(byFamily) {
  const total = Object.values(byFamily).reduce((s, v) => s + v, 0);
  if (!total) return 'n/a';
  return Object.entries(byFamily).sort((a, b) => b[1] - a[1]).map(([fam, c]) => `${fam} ${((c / total) * 100).toFixed(0)}%`).join(', ');
}

function renderCompare(result) {
  const header = '| period | days | main $/day | subagent $/day | subagent share % | subagents/day | median $/subagent | subagent spend by family % |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const rows = ['before', 'after'].map((key) => {
    const p = result[key];
    const total = p.mainCost + p.subCost;
    const med = median(p.subCosts);
    return `| ${key} | ${p.days.toFixed(1)} | $${(p.mainCost / p.days).toFixed(2)} | $${(p.subCost / p.days).toFixed(2)} | ${total ? ((p.subCost / total) * 100).toFixed(0) : '0'}% | ${(p.subCount / p.days).toFixed(2)} | ${med === null ? 'n/a' : `$${med.toFixed(2)}`} | ${familyShare(p.subCostByFamily)} |`;
  });
  const unpriced = [...new Set([...Object.keys(result.before.unpriced), ...Object.keys(result.after.unpriced)])];
  const lines = [header, sep, ...rows, ''];
  lines.push(unpriced.length ? `Unpriced models seen: ${unpriced.join(', ')}` : 'Unpriced models seen: none');
  lines.push('', 'Caveat: not a controlled comparison — workload differs between periods; read it as a trend.');
  return lines.join('\n');
}

function runCompare(argv) {
  const compareArg = argv.find((a) => a === '--compare' || a.startsWith('--compare='));
  const dateStr = compareArg.includes('=') ? compareArg.slice(compareArg.indexOf('=') + 1) : null;
  const beforeDaysArg = argv.find((a) => a.startsWith('--before-days='));
  const beforeDays = beforeDaysArg ? Number(beforeDaysArg.split('=')[1]) : 14;
  let cutoffMs;
  if (dateStr) {
    cutoffMs = Date.parse(dateStr);
  } else {
    const markerPath = path.join(lib.configDir(), 'skills', 'delegate', '.delegate-installed');
    if (!fs.existsSync(markerPath)) {
      process.stderr.write('delegate report --compare: no install marker found; pass --compare=<ISO date>\n');
      process.exit(1);
    }
    cutoffMs = fs.statSync(markerPath).mtimeMs;
  }
  const projectsDir = path.join(lib.configDir(), 'projects');
  const result = compareUsage(projectsDir, cutoffMs, beforeDays, Date.now());
  process.stdout.write(`${renderCompare(result)}\n`);
}

function main(argv) {
  if (argv.some((a) => a === '--compare' || a.startsWith('--compare='))) {
    runCompare(argv);
    return;
  }
  const days = Number((argv.find((a) => a.startsWith('--days=')) || '--days=30').split('=')[1]);
  const cutoff = Date.now() - days * DAY_MS;
  const records = mergeByAgent(readLog().filter((l) => Date.parse(l.ts) >= cutoff));
  const stateDir = path.join(lib.delegateDir(), 'state');
  const backstopSessions = countGrownSessions(stateDir, lib.readConfig());
  const removed = argv.includes('--no-cleanup') ? 0 : cleanupState(stateDir, Date.now());
  const fixRounds = countFixRounds(path.join(lib.delegateDir(), 'runs'));
  const triage = readTriage(path.join(lib.delegateDir(), 'runs'), cutoff);
  process.stdout.write(`${buildReport(records, { days, backstopSessions, fixRounds, removed, triage })}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { priceFor, costOf, mergeByAgent, roleOf, parseTriageLine, readTriage, cleanupState, buildReport, compareUsage, main };
