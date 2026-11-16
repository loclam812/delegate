#!/usr/bin/env node
// SubagentStop: a subagent whose final reply is long is sent back once to move it into a
// report file, because the parent re-reads that reply on every later call of its session.
// A review asked for the REVIEW line is sent back once without it: fix rounds and
// `delegate report` read that line, and a prose rule alone never held it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./delegate-lib');

const MAX_LINES = 15;
const MAX_CHARS = 2000;
const REVIEW_ASK = 'REVIEW verdict=';
const REVIEW_FORMAT = '`REVIEW verdict=<approve|fix|block> C=<n> H=<n> M=<n> L=<n>`';
const HEAD_BYTES = 256 * 1024;
const BRIEF_PATH = /[^\s`'"()]*brief-\d+\.md/;

function head(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function firstPrompt(transcript) {
  for (const line of head(transcript).split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user' || !entry.message) continue;
    const { content } = entry.message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
  }
  return '';
}

function askedForReviewLine(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return false;
  const prompt = firstPrompt(transcript);
  if (prompt.includes(REVIEW_ASK)) return true;
  const brief = BRIEF_PATH.exec(prompt);
  if (!brief) return false;
  const file = brief[0].replace(/^~(?=\/)/, os.homedir());
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(REVIEW_ASK);
}

lib.runHook('delegate-reply-guard', (p) => {
  // The second stop always passes, so an agent that cannot write a file is never trapped.
  if (p.stop_hook_active) return null;
  if (!p.agent_type || lib.REPORT_EXEMPT.has(p.agent_type)) return null;
  const reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  const lines = reply.split('\n').length;
  const tooLong = lines > MAX_LINES || reply.length > MAX_CHARS;
  const hasReview = Boolean(lib.parseReviewLine(reply));
  if (!tooLong && hasReview) return null;
  const asked = askedForReviewLine(p.agent_transcript_path);
  const missingReview = asked && !hasReview;
  if (!tooLong && !missingReview) return null;
  const reasons = [];
  if (tooLong) {
    const reportPath = path.join(lib.reportsDir(p.session_id), `${lib.sanitize(p.agent_id || Date.now())}.md`);
    reasons.push(`Your reply is ${lines} lines / ${reply.length} chars; the cap is ${MAX_LINES} lines / ${MAX_CHARS} chars. `
      + `Write that full reply to ${reportPath} (create the directory if needed), then reply again in 10 lines or fewer: `
      + 'status, finding counts by severity or files changed, concerns, and the report path.');
  }
  if (missingReview) {
    reasons.push(`Your brief asks for a REVIEW line and the reply has none. Reply again with ${REVIEW_FORMAT} as its first line, counting your findings by severity.`);
  } else if (asked) {
    // The retry is the last stop the guard sees, so it has to keep the line on its own.
    reasons.push(`In the shorter reply, keep ${REVIEW_FORMAT} as the first line.`);
  }
  return { decision: 'block', reason: reasons.join(' ') };
});
