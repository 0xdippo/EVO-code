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

The same HARNESS app runs in three modes — Standalone, Host, or Remote — so you can run all compute on one machine and control it from another.
There is no separate "Host app" and "Remote app": both sides run the same app binary and differ only by selected mode.

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

---

## Remote Mode

One binary, three modes. Switch in **Settings (⚙) → Mode**.

| Mode | Description |
|------|-------------|
| **Standalone** | All compute runs locally. Default. |
| **Host** | Runs normally, and also starts an HTTP + WebSocket server on port 7700 so a Remote client can connect. |
| **Remote** | Thin client — UI is identical but all commands relay to the Host over the network. Claude and Codex run on the Host machine only. |

### Thread Sync Behavior

- Chat execution happens on the Host machine in Remote mode.
- `ops/chat/thread.json` is the source of truth for chat history.
- Thread updates are broadcast so connected clients refresh thread content after writes.

### Host setup (e.g. Mac Studio)

1. Settings → Mode → **Host**
2. Click **Start** — server binds to `0.0.0.0:7700`
3. Copy the generated API key
4. The topbar shows `Host: ON · key: xxxxxxxx…`

### Remote setup (e.g. MacBook Air)

1. Settings → Mode → **Remote**
2. Enter the host's IP or Tailscale hostname: `192.168.1.x:7700`
3. Paste the API key → **Save**
4. Go to **Setup**, enter the repo path *as it exists on the Host* (e.g. `/Volumes/External/GitHub/myproject`), click **Open**

The path is saved — subsequent launches connect and load automatically.

### Remote connectivity troubleshooting

- `Could not reach remote host ... (Load failed)` usually means network/firewall/connectivity issues to `host:7700`.
- `{"error":"unauthorized"}` means the API key on the Remote client does not match the current Host key.
- Repo path must be the absolute path **as it exists on the Host machine**, not the Remote machine.

Quick checks from terminal:

```bash
# On Host: confirm listener
lsof -nP -iTCP:7700 -sTCP:LISTEN

# From Remote machine: verify HTTP reachability and key
curl -sS -X POST http://<host-ip>:7700/api/open_repository \
  -H "content-type: application/json" \
  -H "x-api-key: <host-key>" \
  -d '{"rootPath":"/"}'
```

### Off-network access

Works with [Tailscale](https://tailscale.com/) out of the box. Use the Host's Tailscale hostname instead of a local IP (e.g. `mac-studio.tail1234.ts.net:7700`). No additional app configuration needed.

### Syncthing users

If you sync the repo between machines, add a `.stignore` to exclude build artifacts:

```
src-tauri/target/
node_modules/
dist/
```

This prevents compiled paths from one machine breaking builds on the other.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop shell | [Tauri](https://tauri.app/) v2 |
| Frontend | React 18 + TypeScript + Vite |
| Backend | Rust (Axum for remote server) |
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
  lib/
    transport.ts    Transport layer (local IPC or remote HTTP/WS)
    tauri.ts        Local Tauri IPC calls
    setup.ts        Project setup utilities
  types/harness.ts  Shared TypeScript types
src-tauri/
  src/lib.rs        Tauri commands, agent execution, Axum remote server
```
