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

  const isMissing = !file || file.status === "missing";

  return (
    <article className="panel file-editor-panel">
      <div className="file-editor-header">
        <p className="eyebrow">File Setup</p>
        <select
          className="file-select"
          value={selectedPath}
          onChange={(e) => setSelectedPath(e.target.value as TrackedFilePath)}
        >
          {TRACKED_FILES.map((path) => {
            const entry = getFileRecord(snapshot, path);
            const missing = !entry || entry.status === "missing";
            return (
              <option key={path} value={path}>
                {missing ? "⚠ " : ""}{formatFileLabel(path)}
              </option>
            );
          })}
        </select>
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
        <p className="muted">Edit tracked setup files directly. Missing files can be created here.</p>
        <button
          className="primary-button"
          onClick={() => void onSave(selectedPath, draft)}
          disabled={isSaving || !isEditable(file)}
        >
          {isSaving ? "Saving..." : "Save File"}
        </button>
      </div>
    </article>
  );
}
