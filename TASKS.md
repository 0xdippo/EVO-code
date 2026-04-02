# TASKS.md — HARNESS Task Board

## Legend

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `in-progress` | Currently being worked |
| `review` | Awaiting review |
| `done` | Accepted and committed |
| `blocked` | Blocked, needs resolution |

| Owner | Meaning |
|---|---|
| `claude` | Claude must act next |
| `codex` | Codex must act next |
| `human` | Human decision required |

---

## Current Phase: Setup

| ID | Owner | Status | Title |
|---|---|---|---|
| SETUP-01 | human | done | Initialize repo structure and source-of-truth files |

---

## Phase 1: Desktop Shell + Repo Control Layer

| ID | Owner | Status | Title |
|---|---|---|---|
| P1-01 | claude | todo | Write plan: scaffold Tauri + React + Vite + TypeScript project |
| P1-02 | codex | todo | Scaffold Tauri app with React + Vite + TypeScript frontend |
| P1-03 | codex | todo | Configure Tauri shell permissions for child process spawning |
| P1-04 | codex | todo | Implement local Node.js orchestrator entrypoint |
| P1-05 | codex | todo | Implement IPC bridge: Tauri commands ↔ orchestrator |
| P1-06 | codex | todo | Implement git repo detection and status read |
| P1-07 | codex | todo | Implement changed-file listing from git diff |
| P1-08 | claude | todo | Review Phase 1 output against plan |

---

## Phase 2: Intake / Bootstrap

| ID | Owner | Status | Title |
|---|---|---|---|
| P2-01 | claude | todo | Write plan: intake flow and project bootstrap |
| P2-02 | codex | todo | Implement open-project flow (load ops/project.json + state.json) |
| P2-03 | codex | todo | Implement new-project bootstrap (create ops/ structure from template) |
| P2-04 | codex | todo | Render project state on app load (phase, active run, last task) |
| P2-05 | claude | todo | Review Phase 2 output against plan |

---

## Phase 3: Task Composer + Checklist Engine

| ID | Owner | Status | Title |
|---|---|---|---|
| P3-01 | claude | todo | Write plan: task composer UI and checklist engine |
| P3-02 | codex | todo | Parse TASKS.md into structured task list |
| P3-03 | codex | todo | Render task board in UI (phase grouping, status, owner) |
| P3-04 | codex | todo | Implement task status update (write back to TASKS.md) |
| P3-05 | codex | todo | Parse CHECKLISTS.md into checklist definitions |
| P3-06 | codex | todo | Render checklist UI with check/uncheck and gate enforcement |
| P3-07 | claude | todo | Review Phase 3 output against plan |

---

## Phase 4: Planning Pipeline

| ID | Owner | Status | Title |
|---|---|---|---|
| P4-01 | claude | todo | Write plan: plan authoring and approval flow |
| P4-02 | codex | todo | Implement run ID generation and ops/runs/<id>/ folder creation |
| P4-03 | codex | todo | Implement plan editor (markdown, saved to ops/runs/<id>/plan.md) |
| P4-04 | codex | todo | Implement plan approval flow (approve / reject / revise) |
| P4-05 | codex | todo | Update ops/state.json on plan approval |
| P4-06 | claude | todo | Review Phase 4 output against plan |

---

## Phase 5: Run Execution Engine

| ID | Owner | Status | Title |
|---|---|---|---|
| P5-01 | claude | todo | Write plan: run execution engine |
| P5-02 | codex | todo | Implement provider dispatch (spawn Codex or Claude as child process) |
| P5-03 | codex | todo | Stream child process output to UI in real time |
| P5-04 | codex | todo | Handle run completion (exit 0, non-zero, cancellation) |
| P5-05 | codex | todo | Capture run output to ops/runs/<id>/output.log |
| P5-06 | codex | todo | Enforce one-active-run-per-project rule |
| P5-07 | claude | todo | Review Phase 5 output against plan |

---

## Phase 6: Changed-File Viewer

| ID | Owner | Status | Title |
|---|---|---|---|
| P6-01 | claude | todo | Write plan: changed-file diff viewer |
| P6-02 | codex | todo | Collect changed files after run completes (git diff) |
| P6-03 | codex | todo | Render changed-file list in UI |
| P6-04 | codex | todo | Render per-file diff view (unified diff format) |
| P6-05 | codex | todo | Save diff snapshot to ops/runs/<id>/diff.json |
| P6-06 | claude | todo | Review Phase 6 output against plan |

---

## Phase 7: Review Engine

| ID | Owner | Status | Title |
|---|---|---|---|
| P7-01 | claude | todo | Write plan: review engine and accept/reject/revise loop |
| P7-02 | codex | todo | Implement accept action (commit changed files) |
| P7-03 | codex | todo | Implement reject action (revert changed files, mark run failed) |
| P7-04 | codex | todo | Implement revise action (send fix list back to provider) |
| P7-05 | codex | todo | Enforce max review loop limit (3 loops, then escalate to human) |
| P7-06 | codex | todo | Update TASKS.md and ops/state.json on review resolution |
| P7-07 | claude | todo | Review Phase 7 output against plan |

---

## Phase 8: Second Provider + Routing

| ID | Owner | Status | Title |
|---|---|---|---|
| P8-01 | claude | todo | Write plan: provider routing and manual override |
| P8-02 | codex | todo | Implement provider selection UI (Claude vs Codex per task) |
| P8-03 | codex | todo | Implement manual override (write to run record) |
| P8-04 | codex | todo | Read routing defaults from ops/project.json |
| P8-05 | claude | todo | Review Phase 8 output against plan |

---

## Phase 9: Doctor / Validation

| ID | Owner | Status | Title |
|---|---|---|---|
| P9-01 | claude | todo | Write plan: doctor panel and validation checks |
| P9-02 | codex | todo | Implement doctor panel: check ops/ file integrity |
| P9-03 | codex | todo | Implement validation: detect broken state (orphaned runs, mismatched status) |
| P9-04 | codex | todo | Implement repair actions for common broken states |
| P9-05 | codex | todo | Surface validation warnings in UI |
| P9-06 | claude | todo | Review Phase 9 output against plan |
