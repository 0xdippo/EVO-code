import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

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

  if (isRemote) {
    return (
      <section className="repo-picker-inline">
        <div className="repo-picker-row">
          <input
            className="remote-path-input"
            type="text"
            placeholder="Host repository path, e.g. /Volumes/NVMe/GitHub/myproject"
            value={remoteInput}
            onChange={(e) => setRemoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRemoteOpen(); }}
            disabled={isLoading}
          />
          <button className="primary-button" onClick={() => void handleRemoteOpen()} disabled={isLoading || !remoteInput.trim()}>
            {isLoading ? "Loading..." : "Open"}
          </button>
        </div>
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
