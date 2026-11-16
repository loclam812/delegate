#!/usr/bin/env node
// PreToolUse(Bash): a subagent may not commit, push, stage or rewrite the working tree
// through git. The brief says so, but a sentence holds nothing; committing, and throwing
// away the user's uncommitted work, stay with the parent session, which asks the user.
const path = require('path');
const lib = require('./delegate-lib');

const WRITES = new Set(['add', 'commit', 'push', 'pull', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'restore',
  'clean', 'checkout', 'switch', 'am', 'rm', 'mv', 'update-index', 'update-ref', 'symbolic-ref', 'bisect']);
const OPTION_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PREFIXES = new Set(['env', 'command', 'sudo', 'exec', 'time', 'nohup',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
const WORKTREE_WRITES = new Set(['remove', 'prune', 'move']);
const TAG_WRITES = new Set(['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F']);
const BRANCH_WRITES = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description']);

const unquote = (token) => token.replace(/^['"]|['"]$/g, '');

// shortcut: split on shell separators, not parsed; a heredoc line starting with "git push" is denied,
// and git reached through an alias or a script is not seen. Upgrade to a shell parser if that bites.
function gitCall(segment) {
  const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]) || PREFIXES.has(tokens[i]))) i += 1;
  if (path.basename(tokens[i] || '') !== 'git') return null;
  i += 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += OPTION_WITH_VALUE.has(tokens[i]) ? 2 : 1;
  return { sub: tokens[i], args: tokens.slice(i + 1) };
}

function writes({ sub, args }) {
  if (WRITES.has(sub)) return true;
  if (sub === 'stash') return !['list', 'show'].includes(args[0]);
  if (sub === 'worktree') return WORKTREE_WRITES.has(args[0]);
  if (sub === 'tag') return !args.some((a) => a === '-l' || a === '--list') && args.some((a) => TAG_WRITES.has(a) || !a.startsWith('-'));
  if (sub === 'branch') return args.some((a) => BRANCH_WRITES.has(a)) || (args.length > 0 && args.every((a) => !a.startsWith('-')));
  return false;
}

const writingGit = (command) =>
  command.split(/\n|;|&&|\|\||\||&|\$\(|`|\(|\)/).map(gitCall).some((call) => call && writes(call));

lib.runHook('delegate-git-guard', (p) => {
  const command = p.tool_input && p.tool_input.command;
  if (!p.agent_id || typeof command !== 'string') return null;
  if (!lib.readConfig().gitGuard || !writingGit(command)) return null;
  return lib.preToolDecision('deny', 'delegate: a subagent does not commit, push, pull, stage, stash, reset, check out or delete with git. '
    + 'Leave the change in the working tree and say in the report what to commit; the parent session asks the user.');
});
