# delegate

A Claude Code plugin for the moment authorised work reaches execution. The `delegate:delegate`
skill decides whether to run inline or split the work across subagents, picks a model tier per
role, and asks before a large fan-out. Hooks back it up:

| Hook | Event | Does |
|---|---|---|
| `delegate-session-start.js` | SessionStart | tells the model to invoke the skill when execution starts |
| `delegate-guard.js` | PreToolUse `Agent\|Task` | warns on (or denies) an Agent call without `model`; optional spawn backstop |
| `delegate-log.js` | PostToolUse `Agent\|Task`, SubagentStop | logs each subagent's usage to `~/.claude/delegation-log.jsonl` |
| `delegate-approval.js` | PostToolUse `AskUserQuestion` | grants the spawn budget when the user picks `Approve [delegate-approve:N]` |
| `delegate-reply-guard.js` | SubagentStop | sends a reply over 15 lines / 2000 chars back once to move into a report file |

Needs Node 18 or later. No npm dependencies.

## Install

```
/plugin marketplace add <git URL or local path of this repository>
/plugin install delegate@delegate
```

Restart Claude Code. Then add these two rules to `permissions.allow` in `~/.claude/settings.json`,
or Claude asks before every brief and adapter it writes:

```json
"Edit(~/.claude/delegate/runs/**)",
"Edit(~/.claude/delegate/projects/**)"
```

## Configure

State lives in `~/.claude/delegate/` (or `$CLAUDE_CONFIG_DIR/delegate/`). Without a
`config.json` the guard only warns and the backstop is off. To tighten it, write
`~/.claude/delegate/config.json`:

```json
{ "guardMode": "deny", "backstop": true, "initialAllowance": 5, "allowanceStep": 3 }
```

- `guardMode`: `warn` adds a reminder; `deny` blocks an Agent call without `model`.
- `backstop`: once a session has spawned `initialAllowance` agents, each further spawn asks the
  user; allowing one raises the allowance by `allowanceStep`.

Start with the default `warn` for a few days, then switch to `deny`.

To switch every hook off without uninstalling: `touch ~/.claude/delegate/off`.

## Use

The skill fires on its own when execution starts. To force it, type `/delegate:delegate`.
For the cost report, ask for "delegate report".

The cost table in `SKILL.md` holds the author's medians. Once `delegate report` has 5 or more runs
for a role and model, the skill uses your medians instead.

## Migrating from the hand-installed version

If `~/.claude/hooks/delegate-*.js` are wired into your `settings.json`, remove them first, or
every hook runs twice and the backstop counts each spawn double:

```
node ~/.claude/hooks/delegate-install.js --phase=uninstall
```

That leaves `delegate-reply-guard.js` in `settings.json` (the old installer never managed it);
delete its `SubagentStop` entry by hand. Your data in `~/.claude/delegate/` stays and the plugin
reads it.

## Test

```
node --test hooks/test/*.test.js
```
