# TOOLS.md — Build-Time Routing and Tool Rules

## Provider Routing

### Use Claude for:
- Writing and refining plans
- Architecture decisions and tradeoffs
- Code review and acceptance
- Editing source-of-truth files (PROJECT.md, TASKS.md, AGENTS.md, TOOLS.md, CHECKLISTS.md)
- Asking questions that need judgment, not just execution
- Small surgical edits when Codex would be overkill

### Use Codex for:
- Implementing approved plans into working code
- Writing tests
- Mechanical refactors approved by Claude
- Bug fixes identified during review
- Boilerplate and scaffolding within an approved plan

### Do not use either provider for:
- Making architectural decisions that are not in an approved plan
- Deleting files without explicit review
- Modifying `/ops/` files except as part of a defined workflow step
- Pushing to git without human confirmation

---

## Source-of-Truth Files

These files are authoritative. Agents read them, but changes to them are reviewed by Claude or a human before being committed.

| File | Purpose |
|---|---|
| `PROJECT.md` | Project definition, goals, scope, workflow rules |
| `AGENTS.md` | Role definitions, baton-pass rules, review standards |
| `TOOLS.md` | Routing rules, tool permissions, thread rules |
| `CHECKLISTS.md` | Gate checklists for phase transitions |
| `TASKS.md` | Task board, phase tracking, ownership |
| `ops/project.json` | Machine-readable project config |
| `ops/state.json` | Current run state, last plan, active task |
| `ops/runs/` | Per-run plan, output, and diff records |

---

## Tool Permissions (Runtime)

Defined in `ops/project.json` under `tools`. These control what the orchestrator is allowed to do during a run:

| Tool | Default | Notes |
|---|---|---|
| terminal | true | Required for running Codex/Claude child processes |
| browser | true | Required for research tasks |
| package_install | true | Allowed during setup phases |
| file_delete | false | Requires explicit human confirmation |
| network_access | true | Required for provider API calls |
| deploy_commands | false | Not permitted in v1 |

---

## Thread Rules (Conceptual)

A "thread" is a single line of work: one plan → one run → one review. Rules:

1. **One thread active per project at a time.** No second thread starts until the first completes or is explicitly cancelled.
2. **Threads are recorded.** Each thread gets a run ID and a folder in `/ops/runs/`.
3. **Threads do not overlap phases.** A thread belongs to one phase. Cross-phase work is broken into separate threads.
4. **Cancelled threads are archived, not deleted.** The run folder is kept; state.json is updated.

---

## Notes

- Provider routing defaults are set in `ops/project.json` under `models` and `routing`
- Manual overrides are allowed (`allow_manual_override: true`) but must be noted in the run record
- These rules apply to building HARNESS itself and will also apply to projects managed by HARNESS once the app is running
