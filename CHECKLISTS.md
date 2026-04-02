# CHECKLISTS.md — Phase Gate Checklists

These checklists must be completed at each workflow transition. Do not skip items. If an item cannot be checked, resolve it before proceeding.

---

## Before Starting a Phase

- [ ] The previous phase is fully accepted (all tasks status = `done`, changes committed)
- [ ] TASKS.md reflects the current phase and all tasks for this phase are listed
- [ ] ops/state.json shows no active run (`current_run_id` is null or the run is complete)
- [ ] PROJECT.md scope for this phase has been reviewed and is understood
- [ ] Any open questions about this phase have been answered or documented
- [ ] The plan for the first task in this phase has been drafted or is ready to draft

---

## Before Sending to Codex

- [ ] A plan exists for this task in `/ops/runs/<run-id>/plan.md` or has been written inline
- [ ] The plan has been reviewed by Claude and has no open questions
- [ ] The task is clearly scoped — no ambiguous deliverables
- [ ] TASKS.md has been updated: task status = `in-progress`, owner = `codex`
- [ ] ops/state.json has been updated with the current run ID
- [ ] The task does not overlap with any other in-progress task
- [ ] Tool permissions for this task are correct in ops/project.json
- [ ] No files will be deleted without explicit confirmation

---

## Before Sending to Claude for Review

- [ ] The Codex run has completed (exit 0 or confirmed complete)
- [ ] All changed files have been surfaced by the diff viewer
- [ ] TASKS.md has been updated: task status = `review`, owner = `claude`
- [ ] The original plan is available alongside the diff
- [ ] No additional code changes have been made since the run completed
- [ ] The run output (logs) is available for Claude to reference

---

## Before Marking a Phase Complete

- [ ] All tasks in the phase have status = `done`
- [ ] All changed files from all runs in this phase have been reviewed and accepted
- [ ] Changes are committed to the repo
- [ ] ops/state.json is updated (no active run, phase reflected)
- [ ] PROJECT.md success criteria for this phase are met (or exceptions are documented)
- [ ] TASKS.md is updated with any discovered tasks for the next phase
- [ ] A brief summary of what was built in this phase is noted (in run records or a commit message)
