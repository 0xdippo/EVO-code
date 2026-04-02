# PROJECT.md — HARNESS

## Summary

HARNESS is a desktop orchestration workspace for coding projects. It sits above external AI coding providers (Claude, Codex) and gives you a single place to plan, dispatch, review, and finalize work — without leaving a desktop app or losing track of what changed.

HARNESS is **not a full IDE in v1** and **not an autonomous agent**. It is a deterministic, plan-first workspace that keeps a human in the loop at every meaningful decision point.

---

## Goals

- Stay inside one desktop app while AI providers run underneath as child processes
- Enforce plan-first workflow: no code runs without a reviewed plan
- Keep repo-local files as the single source of truth for all project state
- Make changed-file review mandatory before marking any run complete
- Route work to the right provider automatically, with manual override available
- One active run per project at a time — no parallel ambiguity

---

## Success Criteria (v1)

- [ ] A single desktop app (Tauri + React) launches and shows project state
- [ ] A plan file can be authored, reviewed, and approved before any code runs
- [ ] A run can be dispatched to Codex or Claude and tracked from start to finish
- [ ] All files changed during a run are surfaced in a diff viewer before acceptance
- [ ] Accepted changes are committed or rejected cleanly
- [ ] All workflow state persists in `/ops/` files between sessions
- [ ] The system can route between two providers with a clear handoff protocol

---

## Scope (v1)

- Desktop app shell (Tauri + React + Vite + TypeScript)
- Repo control layer (git operations, file diffing, changed-file tracking)
- Task composer and checklist engine
- Plan authoring and approval flow
- Run execution engine (spawn child process, stream output, capture result)
- Changed-file diff viewer
- Review loop (accept / reject / revise)
- Second provider routing (Claude or Codex selectable per task)
- Doctor / validation panel

---

## Out of Scope (v1)

- Full IDE features (syntax highlighting editor, terminal emulator, debugger)
- Autonomous multi-step agent loops without human review
- Multi-project dashboard
- Cloud sync or remote state
- Team collaboration / multi-user
- Plugin system
- Mobile or web targets

---

## Core Workflow

```
1. Open project in HARNESS
2. Author or load a task from TASKS.md
3. Run pre-send checklist
4. Dispatch task to provider (Codex or Claude)
5. Provider runs as child process; output is streamed
6. Run completes; changed files are surfaced
7. Review diffs — accept, reject, or revise
8. Approved changes are committed to repo
9. Phase is marked complete in TASKS.md and ops/state.json
```

---

## Workflow Rules

1. **Plan first.** No implementation task is dispatched without an approved plan.
2. **One active run per project.** A second run cannot start until the current one is finished or cancelled.
3. **Review is required.** Every run that touches files must pass changed-file review before acceptance.
4. **Checklists are required.** Every phase transition must pass the relevant checklist in CHECKLISTS.md.
5. **Repo-local source of truth.** All state lives in `/ops/`. TASKS.md, AGENTS.md, TOOLS.md, CHECKLISTS.md are authoritative.
6. **No silent destructive actions.** File deletion, overwrites, and branch operations require explicit confirmation.
7. **Max review loops.** A task may cycle through review at most 3 times before it is escalated for human resolution.

---

## Technical Direction

- **Frontend:** Tauri + React + Vite + TypeScript
- **Orchestrator:** Local Node.js / TypeScript process (spawned by Tauri shell commands)
- **State:** JSON files in `/ops/` — no database in v1
- **Provider execution:** Child processes (not API calls embedded in UI)
- **Diff viewer:** Git-based, showing changed files per run
- **IPC:** Tauri commands + event system for frontend/backend communication

---

## UX Priorities

- Clarity over cleverness: every screen shows what state the project is in
- Single active focus: one task, one run, one review at a time
- No hidden state: all workflow state is visible and file-backed
- Friction is intentional: the plan step and review step exist to slow you down at the right moments
- Keyboard-navigable but not keyboard-only

---

## Notes for Agents

- **Read this file first** before starting any work session
- **Check TASKS.md** for the current phase and open tasks
- **Check ops/state.json** for current run state before doing anything that modifies files
- **Do not skip the plan step** — even for small tasks, write the plan before touching code
- **Do not implement multiple phases at once** — one phase at a time, reviewed and accepted before the next begins
- **Do not create files outside the established structure** without updating this file and TASKS.md
