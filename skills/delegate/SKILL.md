---
name: delegate
description: Use at the moment of executing work the user has authorised, including right after a plan is approved, and after brainstorming, debugging or planning has finished. Decides inline vs split, picks a model tier per subagent, asks before a large fan-out, and dispatches every subagent itself through the Agent tool with file-based briefs; it depends on no other skill. Also "delegate report" for the usage report. Not for requests to explain, review, plan or brainstorm.
---

# Delegate

## Step 0: is execution authorised?

Execution is authorised only when the user asked for a change to be made, in their own
words, or approved a plan for execution. These are **not** authorisation:

- a request to explain, review, diagnose, audit, plan or brainstorm;
- a brainstorm or analysis write-up, even one with a "Recommendation" section;
- "implement the following plan" when the plan describes a recommendation or an unapproved
  spike.

If execution is not authorised, answer with analysis; only read-only investigators may be
spawned. If the input proposes an action (a recommendation, a spike, a plan), end the answer
with one question asking whether to carry it out, and stop. If authorisation is unclear, ask
that one question first and stop.

## Step 1: load the project adapter

Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/delegate-project.js"`.

- `fresh`: read `adapterPath`.
- `missing` or `stale`: dispatch one generation agent (`model: "sonnet"`, description
  `[delegate:adapter] <slug>`), with the prompt from `${CLAUDE_PLUGIN_ROOT}/skills/delegate/adapter-prompt.md`
  filled with the JSON's values. It returns one line. Then read the adapter. Tell the user in
  one line that it was generated.
- On failure, continue with the defaults below, and say so.

The adapter's Gates and Trap pointers override the defaults here. Delegate never routes work to
another skill, even one the project or an old adapter names. Project rules
in CLAUDE.md/AGENTS.md always win. So does the user's git rule: ask before any commit or push.

## Step 2: inline or split

**Inline**, meaning no subagents except read-only locators:
- **Discovery.** Root cause unknown, or the work needs live evidence first.
- **Trivial.** About 1-2 files in one pass.
- **Interactive.** Brainstorming, interviewing, Q&A.

**Split:**
- **Batch.** A recipe over 3 or more similar units.
- **Multi-task plan** with independent tasks.
- **Reading-heavy research** that would bloat this context.
- **Independent work** that can run in parallel.

## Step 3: executor

Every executor is the `Agent` tool, dispatched from this session.

| Work | Executor |
|---|---|
| Written multi-task plan | one implementer `Agent` per task, in plan order; tasks with no dependency between them run in parallel. Each task runs the task loop in Step 6 |
| Batch: one recipe over 3 or more similar units | one shared brief for the recipe; one `Agent` per group of units, sized to about 100 tool calls |
| 1-2 subagents | `Agent` directly |

Use the Workflow tool only if the user has explicitly opted into workflows.

## Step 4: tiers

Always pass `model` and `effort`. The guard hook denies an Agent call without `model`.

| Role | model | effort |
|---|---|---|
| Locator: find files, symbols, lines (Explore included) | haiku | low |
| Research: read and synthesise claims you will act on | sonnet | medium |
| Implementer | sonnet | medium |
| Design judgment | opus, or do not split | high |
| First review of a task | opus | high |
| Scoped re-review of a fix | sonnet | medium |
| Final whole-branch review | opus | high; xhigh when the branch touches auth, money or a migration |
| Fix round 3 | the stuck implementer's model | one step above its effort |
| Fix rounds 4-5 | one tier above the stuck implementer | that tier's implementer effort |

A locator always runs on haiku, even when its agent type pins another model. For every other
role, if the agent type pins haiku or sonnet in its frontmatter, pass that model. When a search
must be exhaustive (every caller of a function), run `grep` yourself or give it to research on
sonnet: a haiku locator can miss hits. Haiku output is a claim: spot-check paths and lines before
acting on them, and check its report file rather than its reply, because the reply's summary can
omit what it left undone. Read both narrowly, since everything read stays in this context: `grep`
the report for Status, Concerns and deviations, and `sed -n` only the lines a spot-check needs.
A report that needs reading in full goes to the reviewer, not to this context.

## Step 5: small or large

Count the spawns: implementers, reviews, re-reviews, plus 2 of headroom for fix rounds.

Estimate the cost by adding each spawn's role cost from the table below; price the 2 headroom
spawns at the implementer's role cost. Where `node "${CLAUDE_PLUGIN_ROOT}/hooks/delegate-report.js"` shows a
median for that role and model family (for example `opus review`) with 5 or more runs, use that
median instead. The per-model medians mix every role, so do not use them here.

These defaults are medians from the author's `delegate report` on 2026-10-28; the haiku locator
row had under 5 runs and keeps its original estimate. Your own medians replace them as above.

| Role | Cost |
|---|---|
| sonnet implementer | USD 1.04 |
| opus review | USD 1.53 |
| sonnet re-review | USD 0.22 |
| haiku locator | USD 0.05 |
| sonnet research | USD 1.13 |

**Small** means all of the following:
- 3 spawns or fewer;
- no worker on opus;
- no new worktree or branch;
- an estimate under USD 4.50.

For small, print one line and dispatch:
`delegate: split into <N> agents (<role>:<model>, …), est $<x>, running.`

**Large** is everything else, including any Workflow fan-out or any work across repositories.
Ask with AskUserQuestion:
- **Question:** the split, the tier per role, the estimate, and the side effects (worktrees,
  branches, files outside the working tree).
- **Options:**
  - `Approve [delegate-approve:<N>]`, where N is the spawn count from above;
  - `Run inline instead`;
  - `Cancel`.

Only the approval hook grants the budget. Never write `~/.claude/delegate/state/` yourself.

## Step 6: dispatch contract

- **Run workspace:** `~/.claude/delegate/runs/<slug>/<YYYY-MM-DD>-<task-slug>/`.
- **Brief:** one file per task, in `brief-<n>.md`, following
  `${CLAUDE_PLUGIN_ROOT}/skills/delegate/brief-template.md`. The prompt carries the brief's path, never
  its content, and never the session's history.
- **Description:** starts with `[delegate:<task-slug>]`.
- **Report:** the subagent writes it to `report-<n>.md` and replies in 10 lines or fewer.
- **Ledger:** append one line per event to `ledger.md` in the workspace:
  `<task>: dispatched|complete|fix round <r>|parked — <one line>`. After a compaction, trust
  the ledger over your memory.
- **Task loop:** implementer, then a first review of its diff, then fix rounds until the review
  holds no CRITICAL, HIGH or MEDIUM finding, each fix checked by a scoped re-review; mark the
  task `complete` in the ledger. After the last task, one final whole-branch review.
- **Review:** follow the tier table. A review is an `Agent` with a brief like any other task.
  - Every review and re-review brief asks for this line in the reply:
    `REVIEW verdict=<approve|fix|block> C=<n> H=<n> M=<n> L=<n>`. Nothing enforces it: a reply
    without it shows up in `delegate report` as a missing REVIEW line.
  - After triaging a review, append to the ledger, counting by severity and leaving out zeros:
    `<task>: triage <agent type>:<model family> — fixed H1 M2, rejected M1, deferred L3`.
    Rejected means not a real defect; deferred means real but left for later. `delegate report`
    turns these lines into dollars per fixed finding, per reviewer and model.
  - Only a CRITICAL, HIGH or MEDIUM finding opens a fix round. A LOW finding is fixed inside a
    fix round that is already open, or recorded as deferred; it never opens a fix round or a
    re-review on its own.
- **Cost shape:** a subagent's cost is mostly cache reads, and every tool call re-reads its
  whole context. Measured on 2000 agents (2026-10-28), the cost per call stays flat up to about
  50 calls, then rises: past 100 calls each call costs 1.5-2 times as much. Every spawn also
  pays a fixed USD 0.20-0.30 to start. Three rules follow:
  - **Shared lookups once.** When several agents need the same facts (which components forward
    a prop to the DOM, an id → file index, a call map), one locator or research agent builds
    the table first and the shared brief points to it. Implementers and reviewers look facts up
    there instead of re-tracing them. The table is a claim like any report: the first review
    checks it once.
  - **About 100 tool calls per agent.** When a unit will need more (many files, a long
    trace per item, several concerns in one task), split it. Two agents of 100 calls cost
    about a third less than one agent of 200.
  - **No split below about 50 calls.** Under that, the fixed start cost outweighs the saving.
    Never spawn opus for a non-review job of a few calls: per call, it is the costliest agent
    there is. Reviews keep the tier table.
  Never drop or shrink a review to save cost; reviews catch real defects.

## Report mode

For "delegate report", run `node "${CLAUDE_PLUGIN_ROOT}/hooks/delegate-report.js"` and show its output.
Suggest threshold changes only from what the output shows.
