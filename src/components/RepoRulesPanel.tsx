import { useEffect, useState } from "react";
import { formatFileLabel, getFileRecord, isEditable } from "../lib/repo";
import type { RepoSnapshot, SaveRepositoryFile, TrackedFilePath } from "../types/harness";
import { TRACKED_FILES } from "../types/harness";

interface RepoRulesPanelProps {
  snapshot: RepoSnapshot;
  isSaving: boolean;
  onSave: SaveRepositoryFile;
}

function missingFileHint(path: TrackedFilePath): string {
  switch (path) {
    case "PROJECT.md":
      return "Missing PROJECT.md. Use this to describe project goals, scope, and workflow rules for agents.";
    case "AGENTS.md":
      return "Missing AGENTS.md. Use this to define agent roles, baton passing, and review/build ownership.";
    case "TOOLS.md":
      return "Missing TOOLS.md. Document available commands/scripts and when each should be used.";
    case "CHECKLISTS.md":
      return "Missing CHECKLISTS.md. Add required pre-send/review checklists to gate phase transitions.";
    case "TASKS.md":
      return "Missing TASKS.md. Track task IDs, owners, and statuses for the active project phase.";
    case "README.md":
      return "Missing README.md. Add a project overview, setup steps, and usage notes for humans.";
    case "ops/project.json":
      return "Missing ops/project.json. Saving will create project config and agent routing defaults.";
    case "ops/state.json":
      return "Missing ops/state.json. Saving will create runtime state tracking for plan/run progress.";
    default:
      return "This file is missing. Saving will create it without overwriting unrelated files.";
  }
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
        placeholder={missingFileHint(selectedPath)}
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
