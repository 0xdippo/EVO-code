import { useEffect, useState } from "react";
import { formatFileLabel, getFileRecord, isEditable } from "../lib/repo";
import type { RepoSnapshot, SaveRepositoryFile, TrackedFilePath } from "../types/harness";
import { TRACKED_FILES } from "../types/harness";

interface RepoRulesPanelProps {
  snapshot: RepoSnapshot;
  isSaving: boolean;
  onSave: SaveRepositoryFile;
}

export function RepoRulesPanel({
  snapshot,
  isSaving,
  onSave,
}: RepoRulesPanelProps) {
  const [selectedPath, setSelectedPath] = useState<TrackedFilePath>("PROJECT.md");
  const file = getFileRecord(snapshot, selectedPath);
  const [draft, setDraft] = useState(file?.content ?? "");

  useEffect(() => {
    setDraft(file?.content ?? "");
  }, [file?.content, selectedPath]);

  return (
    <section className="rules-layout">
      <aside className="panel rules-sidebar">
        <p className="eyebrow">Repo Rules</p>
        <h2>Source of truth</h2>
        <ul className="file-nav">
          {TRACKED_FILES.map((path) => {
            const entry = getFileRecord(snapshot, path);
            return (
              <li key={path}>
                <button
                  className={path === selectedPath ? "file-link active" : "file-link"}
                  onClick={() => setSelectedPath(path)}
                >
                  <span>{formatFileLabel(path)}</span>
                  <strong>{entry?.status ?? "missing"}</strong>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <article className="panel editor-panel">
        <div className="editor-header">
          <div>
            <p className="eyebrow">Viewing</p>
            <h2>{selectedPath}</h2>
          </div>
          <div className={`status-badge ${file?.status ?? "missing"}`}>
            {file?.status ?? "missing"}
          </div>
        </div>

        {file?.error ? <p className="error-copy">{file.error}</p> : null}

        <textarea
          className="editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="This file is missing. Saving will create it without overwriting unrelated files."
          disabled={!isEditable(file)}
        />

        <div className="editor-actions">
          <p className="muted">
            Only the tracked HARNESS files are writable in Phase 1. Missing files
            can be created from here if needed.
          </p>
          <button
            className="primary-button"
            onClick={() => void onSave(selectedPath, draft)}
            disabled={isSaving || !isEditable(file)}
          >
            {isSaving ? "Saving..." : "Save File"}
          </button>
        </div>
      </article>
    </section>
  );
}
