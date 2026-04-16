import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectHome } from "./components/ProjectHome";
import { RepoRulesPanel } from "./components/RepoRulesPanel";
import { RepoSelector } from "./components/RepoSelector";
import { SetupForm } from "./components/SetupForm";
import { ThreadView } from "./components/ThreadView";
import { WarningList } from "./components/WarningList";
import { getSetupFormDefaults, isProjectInitialized } from "./lib/setup";
import {
  openRepository,
  setupProject,
  writeRepositoryFile,
} from "./lib/transport";
import { loadRemoteConfig, saveRemoteConfig, type AppMode, type RemoteConfig } from "./lib/transport";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConfig,
  RepoSnapshot,
  SaveRepositoryFile,
  SetupFormValues,
} from "./types/harness";

type ViewMode = "setup" | "home" | "thread";
const LAST_REPO_STORAGE_KEY = "harness_last_repo";
const LAST_REMOTE_REPO_KEY = "harness_last_remote_repo";

interface ServerStatus {
  enabled: boolean;
  apiKey: string | null;
  port: number;
}

export function App() {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("home");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [theme, setTheme] = useState<string>(
    () => window.localStorage.getItem("evo_theme") ?? "noir",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  // Remote/host config
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig>(loadRemoteConfig);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const isHost = remoteConfig.mode === "host";
  const isRemote = remoteConfig.mode === "remote";

  // Load server status on mount if host mode
  useEffect(() => {
    if (isHost) {
      invoke<ServerStatus>("get_server_status")
        .then(setServerStatus)
        .catch(() => null);
    }
  }, [isHost]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("evo_theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [settingsOpen]);

  const initialized = isProjectInitialized(snapshot);
  const title = useMemo(() => {
    if (!snapshot?.projectConfig?.project_name) {
      return "HARNESS";
    }

    return snapshot.projectConfig.project_name;
  }, [snapshot?.projectConfig?.project_name]);
  const availableAgents = useMemo((): AgentConfig[] => {
    return snapshot?.projectConfig?.agents ?? [];
  }, [snapshot?.projectConfig?.agents]);
  const setupDefaults = useMemo(
    () => getSetupFormDefaults(snapshot?.projectConfig ?? null),
    [snapshot?.projectConfig],
  );

  useEffect(() => {
    const key = isRemote ? LAST_REMOTE_REPO_KEY : LAST_REPO_STORAGE_KEY;
    const storedPath = window.localStorage.getItem(key);
    if (!storedPath) return;
    void handleSelectRepo(storedPath, { silent: true });
  }, []);

  async function handleSelectRepo(path: string, options?: { silent?: boolean }) {
    try {
      setIsLoading(true);
      if (!options?.silent) {
        setAppError(null);
      }
      const nextSnapshot = await openRepository(path);
      setSelectedPath(path);
      setSnapshot(nextSnapshot);
      setView(isProjectInitialized(nextSnapshot) ? "home" : "setup");
      const saveKey = isRemote ? LAST_REMOTE_REPO_KEY : LAST_REPO_STORAGE_KEY;
      window.localStorage.setItem(saveKey, path);
    } catch (error) {
      setSnapshot(null);
      setSelectedPath(null);
      setView("setup");
      const saveKey = isRemote ? LAST_REMOTE_REPO_KEY : LAST_REPO_STORAGE_KEY;
      window.localStorage.removeItem(saveKey);
      if (!options?.silent) {
        setAppError(error instanceof Error ? error.message : "Failed to open repository.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSetupSubmit(values: SetupFormValues) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await setupProject(selectedPath, values);
      setSnapshot(nextSnapshot);
      setView(isProjectInitialized(nextSnapshot) ? "home" : "setup");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Failed to save setup.");
    } finally {
      setIsSaving(false);
    }
  }

  const handleSave: SaveRepositoryFile = async (path, content) => {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await writeRepositoryFile(selectedPath, path, content);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save file.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  };

  function handleModeChange(mode: AppMode) {
    const next = { ...remoteConfig, mode };
    setRemoteConfig(next);
    saveRemoteConfig(next);
    setServerError(null);
    if (mode === "host") {
      invoke<ServerStatus>("get_server_status").then(setServerStatus).catch(() => null);
    }
  }

  async function handleToggleServer() {
    setServerError(null);
    try {
      if (serverStatus?.enabled) {
        const status = await invoke<ServerStatus>("stop_remote_server");
        setServerStatus(status);
      } else {
        const status = await invoke<ServerStatus>("start_remote_server");
        setServerStatus(status);
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Server error");
    }
  }

  async function handleRegenerateKey() {
    setServerError(null);
    try {
      const status = await invoke<ServerStatus>("regenerate_api_key");
      setServerStatus(status);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Failed to regenerate key");
    }
  }

  function handleRemoteUrlChange(serverUrl: string) {
    const next = { ...remoteConfig, serverUrl };
    setRemoteConfig(next);
    saveRemoteConfig(next);
  }

  function handleRemoteKeyChange(apiKey: string) {
    const next = { ...remoteConfig, apiKey };
    setRemoteConfig(next);
    saveRemoteConfig(next);
  }

  return (
    <main className="app-shell">
      <header className="topbar compact-topbar">
        <p className="topbar-project-line">
          <span className="topbar-project-name">{title}</span>
          <span className="topbar-meta">{selectedPath ?? "No repository selected"}</span>
          {isHost && serverStatus?.enabled && (
            <span className="topbar-server-badge">
              Host: ON &nbsp;·&nbsp; key: {serverStatus.apiKey?.slice(0, 8)}…
            </span>
          )}
          {isRemote && (
            <span className="topbar-server-badge topbar-server-remote">
              Remote: {remoteConfig.serverUrl || "not configured"}
            </span>
          )}
        </p>
        <nav className="view-toggle compact-toggle">
          <button
            className={view === "home" ? "toggle-button active" : "toggle-button"}
            onClick={() => setView("home")}
          >
            Dashboard
          </button>
          <button
            className={view === "thread" ? "toggle-button active" : "toggle-button"}
            onClick={() => setView("thread")}
          >
            Thread
          </button>
          <button
            className={view === "setup" ? "toggle-button active" : "toggle-button"}
            onClick={() => setView("setup")}
          >
            Setup
          </button>
          <div className="settings-wrap" ref={settingsRef}>
            <button
              className={settingsOpen ? "settings-btn active" : "settings-btn"}
              onClick={() => setSettingsOpen((prev) => !prev)}
              title="Settings"
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </button>
            {settingsOpen && (
              <div className="settings-menu">
                <p className="settings-menu-label">Theme</p>
                {(["ember", "void", "noir", "slate", "linen"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={theme === t ? "settings-theme-btn active" : "settings-theme-btn"}
                    onClick={() => { setTheme(t); }}
                  >
                    {t === "ember"
                      ? "Ember"
                      : t === "void"
                        ? "Void"
                        : t === "noir"
                          ? "Noir"
                          : t === "slate"
                            ? "Slate"
                            : "Linen"}
                  </button>
                ))}

                <p className="settings-menu-label" style={{ marginTop: "10px" }}>Mode</p>
                {(["standalone", "host", "remote"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={remoteConfig.mode === m ? "settings-theme-btn active" : "settings-theme-btn"}
                    onClick={() => handleModeChange(m)}
                  >
                    {m === "standalone" ? "Standalone" : m === "host" ? "Host" : "Remote"}
                  </button>
                ))}

                {isHost && (
                  <div className="settings-server-section">
                    {serverError && <p className="settings-server-error">{serverError}</p>}
                    <div className="settings-server-row">
                      <span className="settings-server-status">
                        {serverStatus?.enabled ? "Running on :7700" : "Stopped"}
                      </span>
                      <button
                        type="button"
                        className={serverStatus?.enabled ? "settings-server-btn danger" : "settings-server-btn"}
                        onClick={() => void handleToggleServer()}
                      >
                        {serverStatus?.enabled ? "Stop" : "Start"}
                      </button>
                    </div>
                    {serverStatus?.apiKey && (
                      <div className="settings-key-row">
                        <code className="settings-key-display">{serverStatus.apiKey}</code>
                        <button
                          type="button"
                          className="settings-server-btn"
                          onClick={() => void handleRegenerateKey()}
                          title="Generate new key"
                        >
                          ↺
                        </button>
                        <button
                          type="button"
                          className="settings-server-btn"
                          onClick={() => void navigator.clipboard.writeText(serverStatus.apiKey!)}
                          title="Copy key"
                        >
                          Copy
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {isRemote && (
                  <div className="settings-server-section">
                    <label className="settings-field-label">Host URL</label>
                    <input
                      className="settings-field-input"
                      type="text"
                      placeholder="192.168.1.5:7700"
                      value={remoteConfig.serverUrl}
                      onChange={(e) => handleRemoteUrlChange(e.target.value)}
                    />
                    <label className="settings-field-label">API Key</label>
                    <input
                      className="settings-field-input"
                      type="password"
                      placeholder="Paste key from host"
                      value={remoteConfig.apiKey}
                      onChange={(e) => handleRemoteKeyChange(e.target.value)}
                    />
                    <button
                      type="button"
                      className="settings-server-btn"
                      style={{ marginTop: "4px", alignSelf: "flex-end" }}
                      onClick={() => setSettingsOpen(false)}
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </nav>
      </header>

      {appError ? <section className="status-panel error">{appError}</section> : null}

      {view === "setup" ? (
        <>
          <article className="panel config-header">
            <div className="config-title-row">
              <div>
                <p className="eyebrow">Setup</p>
                <h2>Project Configuration</h2>
              </div>
              <RepoSelector
                isLoading={isLoading}
                selectedPath={selectedPath}
                onSelect={handleSelectRepo}
                isRemote={isRemote}
              />
            </div>
          </article>
          {snapshot && <WarningList warnings={snapshot.warnings} />}
          <div className="config-body">
            <article className="panel">
              <SetupForm
                initialValues={setupDefaults}
                isSaving={isSaving}
                onSubmit={handleSetupSubmit}
              />
            </article>
            {snapshot ? (
              <RepoRulesPanel snapshot={snapshot} isSaving={isSaving} onSave={handleSave} />
            ) : (
              <article className="panel empty-state compact-empty-state">
                <h3>No repository loaded</h3>
                <p>Open a repository above to edit tracked files.</p>
              </article>
            )}
          </div>
        </>
      ) : (
        <div className="view-frame">
          {!initialized && (
            <div className="setup-gate">
              <div className="setup-gate-card">
                <p className="eyebrow">Not configured</p>
                <h2>Setup required</h2>
                <p className="muted">
                  {!snapshot
                    ? "Select a repository and configure at least one agent to continue."
                    : "Configure at least one agent to continue."}
                </p>
                <button className="primary-button" onClick={() => setView("setup")}>
                  Setup Project
                </button>
              </div>
            </div>
          )}
          {snapshot && <WarningList warnings={snapshot.warnings} />}
          {view === "home" && snapshot ? (
            <ProjectHome
              snapshot={snapshot}
              isSaving={isSaving}
              onConfigure={() => setView("setup")}
              onSave={handleSave}
            />
          ) : view === "thread" && snapshot ? (
            <ThreadView rootPath={snapshot.rootPath} availableAgents={availableAgents} />
          ) : null}
        </div>
      )}
    </main>
  );
}
