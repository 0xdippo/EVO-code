import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listSharedRepositories, type SharedRepository } from "../lib/transport";

interface RepoSelectorProps {
  isLoading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => Promise<void>;
  isRemote?: boolean;
}

export function RepoSelector({
  isLoading,
  selectedPath,
  onSelect,
  isRemote = false,
}: RepoSelectorProps) {
  const [remoteInput, setRemoteInput] = useState(
    selectedPath ?? window.localStorage.getItem("harness_last_remote_repo") ?? "",
  );
  const [remoteRepos, setRemoteRepos] = useState<SharedRepository[]>([]);
  const [loadingRemoteRepos, setLoadingRemoteRepos] = useState(false);
  const [remoteRepoError, setRemoteRepoError] = useState<string | null>(null);

  async function handlePick() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a HARNESS repository",
    });

    if (typeof selected === "string") {
      await onSelect(selected);
    }
  }

  async function handleRemoteOpen() {
    const trimmed = remoteInput.trim();
    if (trimmed) await onSelect(trimmed);
  }

  async function refreshRemoteRepos() {
    if (!isRemote) return;
    setLoadingRemoteRepos(true);
    setRemoteRepoError(null);
    try {
      const repos = await listSharedRepositories();
      setRemoteRepos(repos);
    } catch (error) {
      setRemoteRepoError(error instanceof Error ? error.message : "Failed to load host repositories.");
    } finally {
      setLoadingRemoteRepos(false);
    }
  }

  useEffect(() => {
    if (!isRemote) return;
    void refreshRemoteRepos();
  }, [isRemote]);

  if (isRemote) {
    return (
      <section className="repo-picker-inline">
        <div className="repo-picker-row">
          <input
            className="remote-path-input"
            type="text"
            placeholder="Remote repository path, e.g. /Volumes/NVMe/GitHub/myproject"
            value={remoteInput}
            onChange={(e) => setRemoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRemoteOpen(); }}
            disabled={isLoading}
          />
          <button className="primary-button" onClick={() => void handleRemoteOpen()} disabled={isLoading || !remoteInput.trim()}>
            {isLoading ? "Loading..." : "Open"}
          </button>
          <button
            className="secondary-button"
            onClick={() => void refreshRemoteRepos()}
            disabled={isLoading || loadingRemoteRepos}
          >
            {loadingRemoteRepos ? "Refreshing..." : "Browse Host Repos"}
          </button>
        </div>
        {remoteRepos.length > 0 && (
          <div className="repo-picker-row" style={{ marginTop: "8px" }}>
            <select
              className="settings-field-input"
              value=""
              onChange={(e) => {
                const nextPath = e.target.value;
                if (nextPath) setRemoteInput(nextPath);
              }}
              disabled={isLoading || loadingRemoteRepos}
            >
              <option value="">Select discovered host repo…</option>
              {remoteRepos.map((repo) => (
                <option key={repo.path} value={repo.path}>
                  {repo.name} — {repo.path}
                </option>
              ))}
            </select>
          </div>
        )}
        {remoteRepoError && (
          <p className="muted" style={{ marginTop: "8px" }}>
            {remoteRepoError}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="repo-picker-inline">
      <div className="repo-picker-row">
        <button className="primary-button" onClick={handlePick} disabled={isLoading}>
          {isLoading ? "Loading..." : "Open Repository"}
        </button>
        <div className="path-chip">
          {selectedPath ? selectedPath : "No repository selected"}
        </div>
      </div>
    </section>
  );
}
