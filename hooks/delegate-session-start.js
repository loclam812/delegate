#!/usr/bin/env node
// Replaces the CLAUDE.md trigger block the old installer wrote: a skill description alone is
// too easy for the model to skip at the moment execution starts.
const lib = require('./delegate-lib');

const TRIGGER = [
  '## Delegation (delegate plugin)',
  '',
  'When work the user has authorised reaches execution, including right after a plan is',
  'approved, invoke the `delegate:delegate` skill first: it decides inline vs split, picks model',
  'tiers, and asks before a large fan-out. Skip it only for trivial one-pass edits (1-2 files),',
  'discovery tasks (root cause unknown) and interactive work. A request to explain, review,',
  'plan or brainstorm is not authorisation to execute. Every Agent call passes `model`.',
].join('\n');

const sessionStartOutput = () => ({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TRIGGER },
});

if (require.main === module) lib.runHook('session-start', sessionStartOutput);

module.exports = { sessionStartOutput, TRIGGER };
