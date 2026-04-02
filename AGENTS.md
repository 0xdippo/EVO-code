# AGENTS.md — How Claude and Codex Build HARNESS

## Overview

Two AI providers are used to build HARNESS itself. They have distinct roles and should never be building the same slice of work in parallel. The baton passes cleanly between them.

---

## Roles

### Claude — Planner / Reviewer / Architecture Critic

Claude is responsible for:
- Writing and refining plans before any code is written
- Reviewing completed work from Codex (or from Claude's own prior passes)
- Catching architectural drift, over-engineering, and scope creep
- Writing or editing source-of-truth files (PROJECT.md, TASKS.md, AGENTS.md, etc.)
- Asking the clarifying questions that prevent bad implementation
- Deciding when a task is actually done vs. "done enough to review"

Claude should **not** be used to write large implementation blocks when Codex is available. Claude's value is precision thinking, not volume output.

---

### Codex — Builder / Implementer / Fixer

Codex is responsible for:
- Implementing approved plans into working code
- Fixing bugs and regressions identified during review
- Writing tests against completed implementation
- Mechanical refactors (rename, restructure, extract) once Claude has approved the shape
- Filling in boilerplate that would slow Claude down

Codex should **not** be asked to plan, decide architecture, or review its own work. Codex builds what is handed to it.

---

## Baton-Pass Rules

### Claude → Codex (Plan to Build)
1. Claude has written and committed a plan to `/ops/runs/<run-id>/plan.md`
2. The plan has been reviewed and approved (no open questions)
3. The pre-send checklist in CHECKLISTS.md has been completed
4. TASKS.md has been updated: task status = `in-progress`, owner = `codex`
5. **Then** Codex receives the task

### Codex → Claude (Build to Review)
1. Codex run has completed (exit 0 or manual completion)
2. Changed files have been surfaced by HARNESS diff viewer
3. TASKS.md has been updated: task status = `review`, owner = `claude`
4. **Then** Claude receives the diff and the original plan for review

### Claude → Done (Review to Accept)
1. Claude has reviewed all changed files against the plan
2. No blocking issues remain (or they have been addressed in a fix loop)
3. Changed-file review checklist has been completed
4. TASKS.md has been updated: task status = `done`
5. Changes are committed to the repo

---

## Review Standards

When Claude reviews Codex output, it checks:

- **Correctness:** Does the code do what the plan said?
- **Scope:** Did Codex stay within the task boundary? No unsolicited refactors.
- **Architecture:** Does this fit the established patterns in the codebase?
- **Safety:** No hardcoded credentials, no silent error swallowing, no file deletions outside the diff
- **Completeness:** Are all sub-tasks in the plan addressed?
- **Test coverage:** If tests were required, were they written?

Claude may return the task to Codex with a specific fix list. This is a **review loop**, not a failure. Max 3 loops before escalating to human.

---

## Parallel Work Rule

**Claude and Codex must never build the same slice of work simultaneously.**

Only one provider has the baton at a time. If a review is in progress, no new build task starts. If a build is in progress, no planning for the same phase begins.

This is enforced by the one-active-run rule in PROJECT.md and ops/state.json.

---

## Task Ownership in TASKS.md

Each task has an `owner` field:
- `claude` — Claude must act next
- `codex` — Codex must act next
- `human` — A human decision or approval is required before work resumes
- `done` — No action required

When the baton passes, update the owner field before dispatching.
