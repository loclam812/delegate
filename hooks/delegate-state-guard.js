#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|Bash): the session never writes the backstop state, the config or
// the off switch. Only the hooks move the allowance; a model that raised it, turned the backstop off
// in config.json or touched `off` would approve its own spawns. runs/ and projects/ stay writable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./delegate-lib');

const REASON = 'delegate: the backstop state, config.json and the off switch are changed only by the hooks or by the user. '
  + 'To get more spawns, ask the user with an AskUserQuestion option carrying [delegate-approve:N].';
const PROTECTED_CHILDREN = ['state', 'config.json', 'off'];
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'jq', 'ls', 'grep', 'rg', 'stat', 'wc', 'file', 'test', '[', 'diff', 'sed', 'awk']);
const PREFIXES = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A delegate directory named by its configured path or by the usual `.claude/delegate`, either
// alone (the whole directory) or followed by one of the protected children.
function protectedPattern() {
  const roots = [escape(lib.delegateDir()), '(?:~|\\$HOME|\\$\\{HOME\\}|[\\w./-]*)\\.claude/delegate'];
  const children = PROTECTED_CHILDREN.map(escape).join('|');
  return new RegExp(`(?:${roots.join('|')})(?:/(?:${children})(?![\\w.-])|/?(?=$|[\\s'"\`;&|)<>]))`);
}

function realTarget(file) {
  let probe = path.resolve(file.replace(/^~(?=\/)/, os.homedir()));
  const rest = [];
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  return path.join(fs.realpathSync(probe), ...rest);
}

function protectsFile(file) {
  const dir = realTarget(lib.delegateDir());
  const target = realTarget(file);
  return target === dir || PROTECTED_CHILDREN.some((child) => target === path.join(dir, child) || target.startsWith(path.join(dir, child) + path.sep));
}

// shortcut: a segment that names a protected path passes only as a known reader without an output
// redirect into it, or as a cp whose last argument is elsewhere; anything else (node -e, cd, ln) is denied.
function segmentWrites(segment, pattern) {
  if (!pattern.test(segment)) return false;
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]) || PREFIXES.has(tokens[i]))) i += 1;
  const verb = path.basename(tokens[i] || '');
  const redirects = [...segment.matchAll(/(?:^|[^\d&<])>>?\s*(\S+)/g)].map((m) => m[1]);
  if (redirects.some((target) => pattern.test(target))) return true;
  if (verb === 'cp') return pattern.test(tokens[tokens.length - 1]);
  if (verb === 'sed') return tokens.some((t) => /^-\w*i/.test(t));
  return !READERS.has(verb);
}

const shellWrites = (command) => {
  const pattern = protectedPattern();
  return command.split(/\n|;|&&|\|\||\||&(?!>)|\$\(|`|\(|\)/).some((segment) => segmentWrites(segment, pattern));
};

lib.runHook('delegate-state-guard', (p) => {
  const input = p.tool_input || {};
  if (typeof input.file_path === 'string' && protectsFile(input.file_path)) return lib.preToolDecision('deny', REASON);
  if (typeof input.command === 'string' && shellWrites(input.command)) return lib.preToolDecision('deny', REASON);
  return null;
});
