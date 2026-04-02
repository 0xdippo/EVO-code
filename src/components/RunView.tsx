import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoSnapshot, RunOutputEvent, RunStatusEvent } from "../types/harness";

const MAX_VISIBLE_LINES = 400;

interface RunViewProps {
  snapshot: RepoSnapshot;
  isSaving: boolean;
  outputEvent: RunOutputEvent | null;
  statusEvent: RunStatusEvent | null;
  onStartRun: (runId: string) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
}

interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
}

function parseSavedOutput(content: string): LogLine[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[(stdout|stderr)\]\s?(.*)$/);
      if (!match) {
        return { stream: "stdout" as const, text: line };
      }

      return {
        stream: match[1] as "stdout" | "stderr",
        text: match[2] ?? "",
      };
    });
}

export function RunView({
  snapshot,
  isSaving,
  outputEvent,
  statusEvent,
  onStartRun,
  onCancelRun,
}: RunViewProps) {
  const run = snapshot.runRecord;
  const logRef = useRef<HTMLDivElement | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>(() =>
    run ? parseSavedOutput(run.outputContent) : [],
  );

  useEffect(() => {
    setLogLines(run ? parseSavedOutput(run.outputContent) : []);
    setRunError(null);
  }, [run?.runId, run?.outputContent, run?.status]);

  useEffect(() => {
    if (!run || !outputEvent) {
      return;
    }

    if (outputEvent.rootPath !== snapshot.rootPath || outputEvent.runId !== run.runId) {
      return;
    }

    setLogLines((current) => {
      const next = [...current, { stream: outputEvent.stream, text: outputEvent.chunk }];
      return next.slice(-MAX_VISIBLE_LINES);
    });
  }, [outputEvent, run, snapshot.rootPath]);

  useEffect(() => {
    if (!run || !statusEvent) {
      return;
    }

    if (statusEvent.rootPath !== snapshot.rootPath || statusEvent.runId !== run.runId) {
      return;
    }

    setRunError(null);
  }, [statusEvent, run, snapshot.rootPath]);

  const visibleLines = useMemo(() => logLines.slice(-MAX_VISIBLE_LINES), [logLines]);

  useEffect(() => {
    if (run?.status !== "running" || !logRef.current) {
      return;
    }

    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.status, visibleLines.length]);

  async function handleStartRun() {
    if (!run) {
      return;
    }

    try {
      setRunError(null);
      await onStartRun(run.runId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Failed to start run.");
    }
  }

  async function handleCancelRun() {
    if (!run) {
      return;
    }

    try {
      setRunError(null);
      await onCancelRun(run.runId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Failed to cancel run.");
    }
  }

  if (!run) {
    return (
      <section className="panel-grid">
        <article className="panel panel-span-full">
          <p className="eyebrow">Run</p>
          <div className="empty-state compact-empty-state">
            <h3>No dispatched run yet</h3>
            <p>Approve a plan first. The run view only appears once Phase 5 has something to execute.</p>
          </div>
        </article>
      </section>
    );
  }

  const isPlanned = run.status === "planned";
  const isRunning = run.status === "running";
  const isTerminal = run.status === "done" || run.status === "failed" || run.status === "cancelled";

  return (
    <section className="panel-grid">
      <article className="panel">
        <p className="eyebrow">Run State</p>
        <h2>{run.runId}</h2>
        <p className="muted">
          Provider dispatch is isolated here so planning stays separate from execution controls.
        </p>
        <dl className="key-value-list">
          <div>
            <dt>Status</dt>
            <dd>{run.status}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{run.provider}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{run.planPath}</dd>
          </div>
          <div>
            <dt>Log file</dt>
            <dd>{run.outputPath}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <p className="eyebrow">Controls</p>
        <h2>
          {isPlanned ? "Ready to run" : isRunning ? "Run active" : isTerminal ? "Run finished" : "Unavailable"}
        </h2>
        <p className="muted">
          {isPlanned
            ? "Only approved plans can start. Starting returns immediately while execution continues in the background."
            : isRunning
              ? "Output streams below while the child process is active. Cancellation is best-effort."
              : "Terminal runs remain readable here, including the saved output log."}
        </p>
        <div className="plan-actions">
          {isPlanned ? (
            <button className="primary-button" onClick={() => void handleStartRun()} disabled={isSaving}>
              Start Run
            </button>
          ) : null}
          {isRunning ? (
            <button className="secondary-button" onClick={() => void handleCancelRun()} disabled={isSaving}>
              Cancel Run
            </button>
          ) : null}
        </div>
        {runError ? <p className="error-copy">{runError}</p> : null}
      </article>

      <article className="panel panel-span-full editor-panel">
        <p className="eyebrow">Run Output</p>
        <div className="editor-header">
          <div>
            <h2>{isRunning ? "Live log" : "Saved log"}</h2>
            <p className="muted">
              The UI keeps a capped live view. `ops/runs/&lt;run-id&gt;/output.log` keeps the complete final output.
            </p>
          </div>
          <span className={`status-badge ${run.status}`}>{run.status}</span>
        </div>

        {visibleLines.length > 0 ? (
          <div className="run-log" ref={logRef}>
            {visibleLines.map((line, index) => (
              <div className={`run-log-line ${line.stream}`} key={`${line.stream}-${index}-${line.text}`}>
                <span className="run-log-stream">{line.stream}</span>
                <code>{line.text}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty-state">
            <h3>No output yet</h3>
            <p>{isPlanned ? "Start the run to begin streaming output." : "The provider has not produced any output."}</p>
          </div>
        )}
      </article>
    </section>
  );
}
