# Brief: <task-slug> / task <n>

**Where this fits:** <one line>

**Requirements:** <the exact change: files, code or recipe, values to use verbatim>

**Project constraints:** <pointers from the adapter's Gates and Trap pointers, as paths — never copies>

**Verification you may run:** <from the adapter's local-allowed gates; say "none" if everything is CI-only>

**Do not:** commit, push, stage, spawn subagents, or run CI-only gates.

**Report contract:** write the full report to `<run workspace>/report-<n>.md`: what changed per file, the commands you ran and their output, any deviation and why, concerns. Then reply with at most 10 lines: Status (DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT), files changed, one-line verification summary, concerns, report path.

**Review briefs only:** the reply's first line is `REVIEW verdict=<approve|fix|block> C=<n> H=<n> M=<n> L=<n>`, counting the report's findings by severity.
