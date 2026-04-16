import { useEffect, useMemo, useState } from "react";
import { listChangedFiles, loadChangedFileDiff } from "../lib/transport";
import type {
  ChangedFileDiff,
  ChangedFileEntry,
  ChangedFilesSnapshot,
  RepoSnapshot,
} from "../types/harness";

interface ChangesViewProps {
  snapshot: RepoSnapshot;
}

function describeRunContext(snapshot: RepoSnapshot): string {
  const state = snapshot.projectState;
  const run = snapshot.runRecord;

  if (run) {
    return `${run.runId} · ${run.status} · ${run.provider}`;
  }

  if (state?.current_run_id) {
    return `${state.current_run_id} · ${state.current_run_status ?? "unknown"}`;
  }

  if (state?.last_run_id) {
    return `${state.last_run_id} · ${state.current_run_status ?? "last known status unavailable"}`;
  }

  return "No run context available.";
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "diff-line meta";
  }

  if (line.startsWith("@@")) {
    return "diff-line hunk";
  }

  if (line.startsWith("+")) {
    return "diff-line added";
  }

  if (line.startsWith("-")) {
    return "diff-line removed";
  }

  return "diff-line";
}

export function ChangesView({ snapshot }: ChangesViewProps) {
  const [changes, setChanges] = useState<ChangedFilesSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffsByPath, setDiffsByPath] = useState<Record<string, ChangedFileDiff>>({});
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    setChanges(null);
    setSelectedPath(null);
    setDiffsByPath({});
    setChangesError(null);
    setDiffError(null);
  }, [snapshot.rootPath]);

  const selectedFile = useMemo<ChangedFileEntry | null>(
    () => changes?.files.find((file) => file.path === selectedPath) ?? null,
    [changes?.files, selectedPath],
  );

  const selectedDiff = selectedPath ? diffsByPath[selectedPath] ?? null : null;

  async function handleRefresh() {
    try {
      setIsLoadingChanges(true);
      setChangesError(null);
      setDiffError(null);
      const nextChanges = await listChangedFiles(snapshot.rootPath);
      setChanges(nextChanges);
      setDiffsByPath({});

      if (nextChanges.files.length === 0) {
        setSelectedPath(null);
        return;
      }

      const nextSelectedPath = nextChanges.files.some((file) => file.path === selectedPath)
        ? selectedPath
        : nextChanges.files[0]?.path ?? null;
      setSelectedPath(nextSelectedPath);
    } catch (error) {
      setChanges(null);
      setSelectedPath(null);
      setDiffsByPath({});
      setChangesError(error instanceof Error ? error.message : "Failed to inspect changed files.");
    } finally {
      setIsLoadingChanges(false);
    }
  }

  async function handleSelectFile(file: ChangedFileEntry) {
    setSelectedPath(file.path);
    setDiffError(null);

    if (diffsByPath[file.path]) {
      return;
    }

    try {
      setIsLoadingDiff(true);
      const diff = await loadChangedFileDiff(snapshot.rootPath, file.path, file.changeType);
      setDiffsByPath((current) => ({
        ...current,
        [file.path]: diff,
      }));
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : "Failed to load diff.");
    } finally {
      setIsLoadingDiff(false);
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel">
        <p className="eyebrow">Changes</p>
        <div className="panel-header">
          <div>
            <h2>Working Tree</h2>
            <p className="muted">
              Read-only git inspection against the repository root. Refresh is manual.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void handleRefresh()}
            disabled={isLoadingChanges}
          >
            {isLoadingChanges ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <dl className="key-value-list">
          <div>
            <dt>Selected root</dt>
            <dd>{snapshot.rootPath}</dd>
          </div>
          <div>
            <dt>Git repo root</dt>
            <dd>{changes?.repoRoot ?? "Refresh to inspect"}</dd>
          </div>
          <div>
            <dt>Run context</dt>
            <dd>{describeRunContext(snapshot)}</dd>
          </div>
          <div>
            <dt>Changed files</dt>
            <dd>{changes ? changes.files.length : "Not loaded"}</dd>
          </div>
        </dl>
        {changesError ? <p className="error-copy">{changesError}</p> : null}
      </article>

      <article className="panel">
        <p className="eyebrow">Changed Files</p>
        <h2>File List</h2>
        <p className="muted">
          Change types come directly from `git status`. Select a file to load its diff on demand.
        </p>

        {!changes && !changesError ? (
          <div className="empty-state compact-empty-state">
            <h3>Inspection is idle</h3>
            <p>Use Refresh to query the working tree.</p>
          </div>
        ) : null}

        {changes && changes.files.length === 0 ? (
          <div className="empty-state compact-empty-state">
            <h3>No changed files</h3>
            <p>The working tree is clean.</p>
          </div>
        ) : null}

        {changes && changes.files.length > 0 ? (
          <ul className="change-list" aria-label="Changed files">
            {changes.files.map((file) => (
              <li key={`${file.changeType}:${file.path}`}>
                <button
                  className={selectedPath === file.path ? "file-link active" : "file-link"}
                  onClick={() => void handleSelectFile(file)}
                >
                  <span className="change-file-copy">
                    <strong>{file.path}</strong>
                    {file.previousPath ? <small>{file.previousPath}</small> : null}
                  </span>
                  <span className={`status-badge change-badge ${file.changeType}`}>
                    {file.changeType}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </article>

      <article className="panel panel-span-full editor-panel">
        <p className="eyebrow">Unified Diff</p>
        <div className="editor-header">
          <div>
            <h2>{selectedFile ? selectedFile.path : "Select a file"}</h2>
            <p className="muted">
              {selectedFile
                ? "Diff text is read-only and loaded only for the selected file."
                : "Choose a changed file after refreshing the working tree."}
            </p>
          </div>
          {selectedFile ? (
            <span className={`status-badge change-badge ${selectedFile.changeType}`}>
              {selectedFile.changeType}
            </span>
          ) : null}
        </div>

        {diffError ? <p className="error-copy">{diffError}</p> : null}

        {!selectedFile ? (
          <div className="empty-state compact-empty-state">
            <h3>No file selected</h3>
            <p>Select a changed file to inspect its unified diff.</p>
          </div>
        ) : isLoadingDiff && !selectedDiff ? (
          <div className="empty-state compact-empty-state">
            <h3>Loading diff</h3>
            <p>Git is generating the diff for the selected file.</p>
          </div>
        ) : selectedDiff && selectedDiff.diff.trim().length === 0 ? (
          <div className="empty-state compact-empty-state">
            <h3>No diff output</h3>
            <p>Git returned no unified diff text for this file.</p>
          </div>
        ) : selectedDiff ? (
          <pre className="diff-viewer" aria-label={`Unified diff for ${selectedDiff.path}`}>
            {selectedDiff.diff.split(/\r?\n/).map((line, index) => (
              <span className={diffLineClass(line)} key={`${selectedDiff.path}-${index}-${line}`}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <div className="empty-state compact-empty-state">
            <h3>Diff not loaded</h3>
            <p>Select the file again if the diff has not been requested yet.</p>
          </div>
        )}
      </article>
    </section>
  );
}
