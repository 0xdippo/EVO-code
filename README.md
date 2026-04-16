# EVO Code

> Tauri desktop app for Claude/Codex agent workflows in either local Standalone mode or Remote mode backed by a separate `evo-host` service.

---

## What It Is

EVO Code is the desktop UI. It manages:

- agent roster configuration
- persistent chat threads
- plan/run/review workflow files in your repo
- repo-scoped context files (`PROJECT.md`, `AGENTS.md`, etc.)

The app supports two execution modes:

- **Standalone** (default): all agent execution runs on the same machine as the app.
- **Remote**: app acts as a thin client, execution runs on a host machine via the separate **`evo-host` repository**.

---

## Repositories

- **App repo** (this repo): UI + local Tauri runtime
- **Host repo**: `evo-host` (separate repo/service process)

Remote mode requires both:

1. EVO Code app on client machine
2. `evo-host` running on host machine

---

## Requirements

### App (EVO-Code)

- Node 18+
- Rust toolchain
- `claude` CLI and/or `codex` CLI for providers you plan to use

### Host (`evo-host`)

- Rust toolchain
- `claude` and/or `codex` installed on host
- host config at `~/.config/evo-host/config.toml`

---

## Quick Start (Standalone)

```bash
npm install
npm run tauri dev
```

Then in the app:

1. Open a local git repository in **Setup**
2. Configure project metadata
3. Add at least one agent to roster
4. Use **Thread** to chat/run tasks

---

## Quick Start (Remote)

### 1) Run `evo-host` on host machine

From the `evo-host` repo:

```bash
mkdir -p ~/.config/evo-host
cp config/config.example.toml ~/.config/evo-host/config.toml
```

Edit config:

```toml
listen_addr = "0.0.0.0:7700"
service_token = "<your-token>"
allowed_repo_roots = [
  "/Volumes/External/GitHub",
]
```

Install as launchd service (macOS):

```bash
./ops/launchd/install.sh
./ops/launchd/status.sh
```

Health checks on host:

```bash
curl -sS http://127.0.0.1:7700/healthz
curl -sS http://127.0.0.1:7700/readyz
```

### 2) Configure EVO Code app on remote machine

1. Open **Settings → Mode → Remote**
2. Set **Host URL** (example: `192.168.1.203:7700`)
3. Set **Service Token** (must match host config)
4. In **Setup**, use **Browse Host Repos** (or manual path) and open repo

---

## Modes

| Mode | Behavior |
|------|----------|
| Standalone | Uses local Tauri commands and local machine CLIs |
| Remote | Uses HTTP/WS to `evo-host`; execution happens on host machine |

---

## Data and Repo Files

EVO Code writes and reads per-repo state under `ops/`:

```text
ops/project.json      # project config + agent roster
ops/state.json        # run/phase state
ops/chat/thread.json  # persistent thread history
ops/runs/*            # plan/output artifacts
```

Tracked context files shown in Setup:

```text
PROJECT.md
AGENTS.md
TOOLS.md
CHECKLISTS.md
TASKS.md
README.md
```

Warnings above Thread/Setup indicate missing/malformed tracked files or directories.

---

## Remote Connectivity Checklist

If remote shows `Load failed` / cannot reach host:

1. From remote machine:
```bash
nc -vz <host-ip> 7700
curl -v http://<host-ip>:7700/healthz
```
2. Confirm token match in app and host config
3. Confirm host listener:
```bash
lsof -nP -iTCP:7700 -sTCP:LISTEN
```
4. If app fails but `curl` works, ensure host has CORS-enabled build and restart `evo-host`

---

## Host CLI Resolution Tip (launchd)

If remote thread errors with:

`Failed to run provider claude: No such file or directory (os error 2)`

`evo-host` can’t find provider binary in launchd PATH. Add PATH in:

`~/Library/LaunchAgents/com.evo.host.plist`

Include your CLI locations (for example NVM bin path), then reload service.

---

## Development

```bash
# app frontend
npm run dev

# app desktop
npm run tauri dev

# app production build
npm run build

# app rust check
cd src-tauri && cargo check
```

---

## Architecture Snapshot

```text
EVO-Code (this repo)
  src/               # React app
  src-tauri/         # local runtime + IPC commands

Remote flow:
  EVO-Code UI -> HTTP/WS -> evo-host -> claude/codex CLIs -> repo ops/
```
