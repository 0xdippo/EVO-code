# EVO Code

> Desktop interface for managing Claude and Codex agent sessions on a local repo.

---

### Get running

```bash
npm install
npm run tauri dev
```

Requires: [Rust](https://rustup.rs/), Node 18+, [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI, [`codex`](https://github.com/openai/codex) CLI

### First-time setup

1. Click **Setup** — open a local git repository
2. Enter project name, phase, and stack
3. Add at least one agent (provider → model → effort → Save)
4. Dashboard and Thread unlock automatically

---

## Overview

EVO Code wraps Claude and Codex CLIs in a persistent desktop UI. Point it at a repo, configure an agent roster, and chat with agents directly through a persistent thread. Responses stream in real time and are saved per-repo.

### Views

| View | Purpose |
|------|---------|
| **Dashboard** | Project overview and status |
| **Thread** | Persistent multi-agent chat |
| **Setup** | Project config and agent roster |

### Agent Roster

Each agent has:

- **Provider** — `claude` or `codex`
- **Model** — e.g. `claude-opus-4-6`, `gpt-5.3-codex`
- **Effort** — `low`, `medium`, or `high`
- **Permission mode** — `normal` or `yolo` (bypasses approval prompts)
- **Name** (optional) — custom display label; defaults to `model · Effort`
- **Extended thinking** (Claude only)

Multiple agents per provider are supported. The Thread composer lets you pick which agent receives each message.

### Context Injection

Every prompt automatically includes the contents of `PROJECT.md` and `AGENTS.md` from the repo root. Agents always know the project context without you repeating yourself.

### Include in Prompt

Each message bubble has a `+` toggle. Selected messages are appended after your typed prompt as context. Click the **context from N msgs** indicator in the composer to preview or remove individual entries.

### Per-repo Storage

Each repo EVO Code manages gets an `ops/` folder:

```
ops/project.json      — Agent roster and project config
ops/state.json        — Runtime state
ops/chat/thread.json  — Full message history
```

EVO Code reads this on open and writes it on save. Your config follows the repo.

### Editable Context Files

Manage these directly from the Setup panel:

```
PROJECT.md    — What the project is
AGENTS.md     — How agents should behave
TOOLS.md      — Available tools and scripts
CHECKLISTS.md — QA checklists
TASKS.md      — Task breakdown
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop shell | [Tauri](https://tauri.app/) v2 |
| Frontend | React 18 + TypeScript + Vite |
| Backend | Rust |
| Fonts | IBM Plex Sans + IBM Plex Mono |

## Development

```bash
# Frontend only (hot reload)
npm run dev

# Full app
npm run tauri dev

# Type check
npx tsc --noEmit

# Rust check
cd src-tauri && cargo check
```

## Project Structure

```
src/
  components/       React components
  lib/              tauri.ts (IPC), setup.ts, repo.ts
  types/harness.ts  Shared TypeScript types
src-tauri/
  src/lib.rs        Tauri commands and agent execution
```
