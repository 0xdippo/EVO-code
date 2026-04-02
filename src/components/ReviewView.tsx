import { useEffect, useMemo, useState } from "react";
import {
  applyReviewDecision,
  clearAcceptedReviewDecision,
  commitAcceptedChanges,
  listChangedFiles,
  loadChangedFileDiff,
} from "../lib/tauri";
import type {
  ChangedFileDiff,
  ChangedFileEntry,
  ChangedFilesSnapshot,
  RepoSnapshot,
  ReviewDecision,
} from "../types/harness";

interface ReviewViewProps {
  snapshot: RepoSnapshot;
  onSnapshotChange: (snapshot: RepoSnapshot) => void;
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

function nextDecisionMap(
  current: Record<string, ReviewDecision>,
  path: string,
  decision: ReviewDecision | null,
): Record<string, ReviewDecision> {
  const next = { ...current };

  if (!decision) {
    delete next[path];
    return next;
  }

  next[path] = decision;
  return next;
}

export function ReviewView({ snapshot, onSnapshotChange }: ReviewViewProps) {
  const [changes, setChanges] = useState<ChangedFilesSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffsByPath, setDiffsByPath] = useState<Record<string, ChangedFileDiff>>({});
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({});
  const [commitMessage, setCommitMessage] = useState("");
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [activeDecisionPath, setActiveDecisionPath] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    setChanges(null);
    setSelectedPath(null);
    setDiffsByPath({});
    setDecisions({});
    setCommitMessage("");
    setChangesError(null);
    setDiffError(null);
    setReviewError(null);
    void handleRefresh();
  }, [snapshot.rootPath]);

  const selectedFile = useMemo<ChangedFileEntry | null>(
    () => changes?.files.find((file) => file.path === selectedPath) ?? null,
    [changes?.files, selectedPath],
  );

  const selectedDiff = selectedPath ? diffsByPath[selectedPath] ?? null : null;
  const acceptedCount = Object.values(decisions).filter((decision) => decision === "accept").length;
  const rejectedCount = Object.values(decisions).filter((decision) => decision === "reject").length;
  const skippedCount = Object.values(decisions).filter((decision) => decision === "skip").length;
  const totalFiles = changes?.files.length ?? 0;
  const decidedCount = changes?.files.filter((file) => decisions[file.path] !== undefined).length ?? 0;
  const undecidedCount = totalFiles - decidedCount;
  const allFilesDecided = totalFiles > 0 && undecidedCount === 0;
  const canCommit = allFilesDecided && acceptedCount > 0 && commitMessage.trim().length > 0;

  async function handleRefresh() {
    try {
      setIsLoadingChanges(true);
      setChangesError(null);
      setDiffError(null);
      setReviewError(null);

      const nextChanges = await listChangedFiles(snapshot.rootPath);
      setChanges(nextChanges);
      setDiffsByPath({});
      setDecisions({});
      setCommitMessage("");

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
      setDecisions({});
      setCommitMessage("");
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

  async function handleDecision(file: ChangedFileEntry, decision: ReviewDecision) {
    const currentDecision = decisions[file.path];
    setReviewError(null);

    try {
      setActiveDecisionPath(file.path);

      if (currentDecision === decision) {
        if (decision === "reject") {
          return;
        }

        if (decision === "accept") {
          await clearAcceptedReviewDecision(snapshot.rootPath, file.path, file.previousPath);
        }

        setDecisions((current) => nextDecisionMap(current, file.path, null));
        return;
      }

      if (currentDecision === "accept") {
        await clearAcceptedReviewDecision(snapshot.rootPath, file.path, file.previousPath);
      }

      if (decision === "accept" || decision === "reject") {
        await applyReviewDecision(
          snapshot.rootPath,
          file.path,
          file.changeType,
          decision,
          file.previousPath,
        );
      }

      if (decision === "reject") {
        setDiffsByPath((current) => {
          const next = { ...current };
          delete next[file.path];
          return next;
        });
        if (selectedPath === file.path) {
          setDiffError(null);
        }
      }

      setDecisions((current) => nextDecisionMap(current, file.path, decision));
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Failed to apply review decision.");
    } finally {
      setActiveDecisionPath(null);
    }
  }

  async function handleCommit() {
    if (!canCommit) {
      return;
    }

    try {
      setIsCommitting(true);
      setReviewError(null);
      const nextSnapshot = await commitAcceptedChanges(snapshot.rootPath, commitMessage.trim());
      onSnapshotChange(nextSnapshot);
      await handleRefresh();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Failed to commit accepted changes.");
    } finally {
      setIsCommitting(false);
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel">
        <p className="eyebrow">Review</p>
        <div className="panel-header">
          <div>
            <h2>Review Summary</h2>
            <p className="muted">
              Decisions are session-only. Refresh reloads the changed-file list and clears every
              decision.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void handleRefresh()}
            disabled={isLoadingChanges || isCommitting}
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
            <dd>{changes?.repoRoot ?? "Loading..."}</dd>
          </div>
          <div>
            <dt>Run context</dt>
            <dd>{describeRunContext(snapshot)}</dd>
          </div>
          <div>
            <dt>Files in review</dt>
            <dd>{totalFiles}</dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd>{acceptedCount}</dd>
          </div>
          <div>
            <dt>Rejected</dt>
            <dd>{rejectedCount}</dd>
          </div>
          <div>
            <dt>Skipped</dt>
            <dd>{skippedCount}</dd>
          </div>
          <div>
            <dt>Undecided</dt>
            <dd>{Math.max(undecidedCount, 0)}</dd>
          </div>
        </dl>
        {changesError ? <p className="error-copy">{changesError}</p> : null}
        {reviewError ? <p className="error-copy">{reviewError}</p> : null}
      </article>

      <article className="panel">
        <p className="eyebrow">Changed Files</p>
        <h2>Decision List</h2>
        <p className="muted">
          Accept stages the file, reject restores it based on the current git change type, and skip
          leaves git alone.
        </p>

        {!changes && !changesError ? (
          <div className="empty-state compact-empty-state">
            <h3>Loading review set</h3>
            <p>HARNESS is querying the working tree.</p>
          </div>
        ) : null}

        {changes && changes.files.length === 0 ? (
          <div className="empty-state compact-empty-state">
            <h3>No changed files</h3>
            <p>The working tree is clean.</p>
          </div>
        ) : null}

        {changes && changes.files.length > 0 ? (
          <ul className="change-list" aria-label="Changed files for review">
            {changes.files.map((file) => {
              const decision = decisions[file.path];
              const isApplying = activeDecisionPath === file.path;

              return (
                <li key={`${file.changeType}:${file.path}`} className="review-file-item">
                  <button
                    className={selectedPath === file.path ? "file-link active" : "file-link"}
                    onClick={() => void handleSelectFile(file)}
                  >
                    <span className="change-file-copy">
                      <strong>{file.path}</strong>
                      {file.previousPath ? <small>{file.previousPath}</small> : null}
                    </span>
                    <span className="review-file-meta">
                      <span className={`status-badge change-badge ${file.changeType}`}>
                        {file.changeType}
                      </span>
                      <span className={`status-badge review-badge ${decision ?? "undecided"}`}>
                        {decision ?? "undecided"}
                      </span>
                    </span>
                  </button>
                  <div className="review-controls">
                    <button
                      className={decision === "accept" ? "review-action active" : "review-action"}
                      onClick={() => void handleDecision(file, "accept")}
                      disabled={isApplying || isCommitting}
                    >
                      Accept
                    </button>
                    <button
                      className={decision === "reject" ? "review-action active" : "review-action"}
                      onClick={() => void handleDecision(file, "reject")}
                      disabled={isApplying || isCommitting}
                    >
                      Reject
                    </button>
                    <button
                      className={decision === "skip" ? "review-action active" : "review-action"}
                      onClick={() => void handleDecision(file, "skip")}
                      disabled={isApplying || isCommitting}
                    >
                      Skip
                    </button>
                  </div>
                </li>
              );
            })}
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
                ? "Diff text stays read-only. Reject clears any cached diff for that file."
                : "Choose a changed file to inspect the diff."}
            </p>
          </div>
          {selectedFile ? (
            <div className="review-file-meta">
              <span className={`status-badge change-badge ${selectedFile.changeType}`}>
                {selectedFile.changeType}
              </span>
              <span
                className={`status-badge review-badge ${
                  decisions[selectedFile.path] ?? "undecided"
                }`}
              >
                {decisions[selectedFile.path] ?? "undecided"}
              </span>
            </div>
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

      <article className="panel panel-span-full">
        <p className="eyebrow">Commit</p>
        <h2>Accepted Changes</h2>
        <p className="muted">
          Commit stays disabled until every listed file has a decision, at least one file is
          accepted, and the message is not empty.
        </p>
        <label className="field-label" htmlFor="review-commit-message">
          Commit message
        </label>
        <input
          id="review-commit-message"
          className="text-input"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Describe the accepted changes"
          disabled={isCommitting}
        />
        <div className="review-commit-summary">
          <span>{allFilesDecided ? "All files decided" : "Every listed file needs a decision"}</span>
          <span>{acceptedCount > 0 ? "Accepted files staged" : "Accept at least one file"}</span>
          <span>{commitMessage.trim() ? "Commit message ready" : "Commit message required"}</span>
        </div>
        <div className="editor-actions">
          <button
            className="primary-button"
            onClick={() => void handleCommit()}
            disabled={!canCommit || isCommitting}
          >
            {isCommitting ? "Committing..." : "Commit Accepted Changes"}
          </button>
        </div>
      </article>
    </section>
  );
}
