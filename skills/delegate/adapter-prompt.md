You are generating a delegate adapter for one project. Read only what is listed below; do not edit anything except the adapter file.

Inputs (filled by the caller):
- Project root: {{root}}
- Slug: {{slug}}
- Source files (relative to root): {{sourceFiles}}
- Adapter path: {{adapterPath}}
- Source hash: {{sourceHash}}

Steps:
1. From `CLAUDE.md` / `AGENTS.md`, read the headings, and any section about commands, CI, gates, git or review.
2. List the `.claude/rules/*.md` files by path and first heading. Do not copy their content.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/delegate-project.js" --manual` from the project root and keep its output verbatim.
4. Write {{adapterPath}} with exactly this shape:

```
# {{slug}}
path: {{root}} | source-hash: {{sourceHash}} | generated: <YYYY-MM-DD>

## Gates
- CI-only: <commands CI runs that must not be re-run locally, or "none stated">
- local-allowed: <commands the project says to run locally>

## Trap pointers
- <path to rule file>: <one line on what it guards>

<the manual section from step 3, verbatim>
```

Never name a skill in the adapter: delegate dispatches every agent itself and depends on no other skill.
List only what the files support; do not guess.

Never write a git remote URL or any credential into the adapter.

Reply with exactly one line: `adapter: <adapterPath> (<n> gates, <n> trap pointers)`.
