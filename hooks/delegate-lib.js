#!/usr/bin/env node
// Shared helpers for the delegate hooks. Every hook must stay fail-safe:
// runHook() turns any error into "no opinion" (exit 0, no stdout).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DEFAULT_CONFIG = { guardMode: 'warn', backstop: false, initialAllowance: 3, allowanceStep: 3, gitGuard: true };

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const delegateDir = () => path.join(configDir(), 'delegate');
const logPath = () => path.join(configDir(), 'delegation-log.jsonl');
const statePath = (sessionId) => path.join(delegateDir(), 'state', `${sanitize(sessionId)}.json`);
const isOff = () => fs.existsSync(path.join(delegateDir(), 'off'));
const reportsDir = (sessionId) => path.join(delegateDir(), 'reports', sanitize(sessionId || 'no-session'));

// Locators reply with a short file:line table; planner/architect/Plan cannot write files and their
// answer is the plan itself; workflow subagents return structured output their script parses.
const REPORT_EXEMPT = new Set([
  'Explore', 'caveman:cavecrew-investigator', 'Plan', 'planner', 'architect',
  'claude-code-guide', 'statusline-setup', 'workflow-subagent',
]);

// The machine-readable line a delegate review brief asks for, so the report can count findings.
const REVIEW_LINE = /^REVIEW verdict=(approve|fix|block) C=(\d+) H=(\d+) M=(\d+) L=(\d+)\s*$/m;
const isReviewer = (agentType) => /reviewer$/.test(agentType || '');

function parseReviewLine(text) {
  const m = REVIEW_LINE.exec(typeof text === 'string' ? text : '');
  return m ? { verdict: m[1], C: +m[2], H: +m[3], M: +m[4], L: +m[5] } : null;
}

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(path.join(delegateDir(), 'config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function logError(where, err) {
  try {
    fs.mkdirSync(delegateDir(), { recursive: true });
    fs.appendFileSync(path.join(delegateDir(), 'hook-errors.log'), `${new Date().toISOString()} ${where} ${err && err.stack ? err.stack : err}\n`);
  } catch {
    // Nowhere left to report; the hook still exits 0.
  }
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function acquire(lock, retries, delayMs, staleMs) {
  for (let i = 0; i <= retries; i += 1) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { force: true });
      } catch {
        // The holder released it between our two calls.
      }
      sleep(delayMs);
    }
  }
  return false;
}

function withLock(file, fn, { retries = 40, delayMs = 25, staleMs = 5000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!acquire(lock, retries, delayMs, staleMs)) throw new Error(`lock busy: ${lock}`);
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function readState(sessionId, config) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return { spawned: 0, allowance: config.initialAllowance };
  }
}

function writeState(sessionId, state) {
  const file = statePath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function originOf(description) {
  const m = /^\[delegate:([^\]]+)\]/.exec(description || '');
  return m ? `delegate:${m[1]}` : 'unrouted';
}

// Credentials are stripped so a token in a remote URL never reaches the log.
function projectSlug(cwd) {
  let remote = '';
  try {
    remote = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    remote = '';
  }
  if (!remote) return `path${path.resolve(cwd).replace(/[^A-Za-z0-9._]+/g, '-')}`;
  const bare = remote
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\.git$/, '');
  return bare.replace(/[^A-Za-z0-9._]+/g, '-');
}

const preToolDecision = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
const preToolContext = (text) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

async function runHook(name, handler) {
  try {
    const raw = await readStdin();
    if (!isOff()) {
      const out = handler(JSON.parse(raw));
      if (out) process.stdout.write(JSON.stringify(out));
    }
  } catch (err) {
    logError(name, err);
  }
  process.exit(0);
}

module.exports = {
  configDir, delegateDir, logPath, statePath, isOff, sanitize, reportsDir, REPORT_EXEMPT, isReviewer, parseReviewLine,
  readConfig, logError, appendJsonl,
  withLock, readState, writeState, originOf, projectSlug, preToolDecision, preToolContext, runHook,
};
