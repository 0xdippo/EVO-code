import { useEffect, useMemo, useState } from "react";
import type { RepoSnapshot } from "../types/harness";

interface PlanViewProps {
  snapshot: RepoSnapshot;
  isSaving: boolean;
  onCreatePlan: () => Promise<void>;
  onSavePlan: (runId: string, content: string) => Promise<void>;
  onApprovePlan: (runId: string) => Promise<void>;
  onRejectPlan: (runId: string) => Promise<void>;
  onOpenRun: () => void;
}

export function PlanView({
  snapshot,
  isSaving,
  onCreatePlan,
  onSavePlan,
  onApprovePlan,
  onRejectPlan,
  onOpenRun,
}: PlanViewProps) {
  const activePlan = snapshot.activePlan;
  const projectState = snapshot.projectState;
  const [draftContent, setDraftContent] = useState(activePlan?.content ?? "");
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    setDraftContent(activePlan?.content ?? "");
    setPlanError(null);
  }, [activePlan?.runId, activePlan?.content, activePlan?.status]);

  const isDirty = activePlan !== null && draftContent !== activePlan.content;
  const isSavedAndNonEmpty = Boolean(activePlan?.content.trim());
  const canReject = Boolean(activePlan && (activePlan.status === "draft" || activePlan.status === "planned"));
  const canApprove = Boolean(
    activePlan
      && activePlan.status === "draft"
      && !activePlan.isReadOnly
      && !isDirty
      && isSavedAndNonEmpty,
  );
  const stateSummary = useMemo(() => {
    if (activePlan) {
      return `Current plan is ${activePlan.status}.`;
    }

    if (projectState?.current_run_status === "rejected") {
      return "Last plan was rejected. No active planning run exists.";
    }

    return "No active planning run exists yet.";
  }, [activePlan, projectState?.current_run_status]);

  async function handleCreatePlan() {
    try {
      setPlanError(null);
      await onCreatePlan();
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Failed to create plan run.");
    }
  }

  async function handleSavePlan() {
    if (!activePlan) {
      return;
    }

    try {
      setPlanError(null);
      await onSavePlan(activePlan.runId, draftContent);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Failed to save plan.");
    }
  }

  async function handleApprovePlan() {
    if (!activePlan || !canApprove) {
      return;
    }

    try {
      setPlanError(null);
      await onApprovePlan(activePlan.runId);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Failed to approve plan.");
    }
  }

  async function handleRejectPlan() {
    if (!activePlan) {
      return;
    }

    try {
      setPlanError(null);
      await onRejectPlan(activePlan.runId);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Failed to reject plan.");
    }
  }

  if (activePlan === null) {
    return (
      <section className="panel-grid">
        <article className="panel panel-span-full">
          <p className="eyebrow">Plan</p>
          <div className="panel-header">
            <div>
              <h2>Planning Pipeline</h2>
              <p className="muted">{stateSummary}</p>
            </div>
            <button
              className="primary-button"
              onClick={() => void handleCreatePlan()}
              disabled={isSaving}
            >
              New Plan
            </button>
          </div>
          <div className="empty-state compact-empty-state">
            <h3>No active plan</h3>
            <p>
              Start a planning run to create `ops/runs/&lt;run-id&gt;/plan.md` before any
              execution exists.
            </p>
          </div>
          {planError ? <p className="error-copy">{planError}</p> : null}
        </article>
      </section>
    );
  }

  const plan = activePlan;

  return (
    <section className="panel-grid">
      <article className="panel">
        <p className="eyebrow">Planning State</p>
        <h2>{plan.runId}</h2>
        <p className="muted">{stateSummary}</p>
        <dl className="key-value-list">
          <div>
            <dt>Plan file</dt>
            <dd>{plan.path}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{plan.status}</dd>
          </div>
          <div>
            <dt>Dirty</dt>
            <dd>{isDirty ? "Unsaved changes" : "Saved"}</dd>
          </div>
          <div>
            <dt>Latest approved plan</dt>
            <dd>{projectState?.latest_plan_id ?? "None"}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <p className="eyebrow">Approval Gate</p>
        <h2>{plan.isReadOnly ? "Read-only" : "Draft controls"}</h2>
        <p className="muted">
          {plan.isReadOnly
            ? "Planned runs stay locked until a later phase introduces execution."
            : "Save the draft first. Approval only unlocks once the saved plan is non-empty."}
        </p>
        <div className="plan-state-stack">
          <div className="status-panel ok">
            <strong>Plan status</strong>
            <p>{plan.status}</p>
          </div>
          {plan.status === "planned" ? (
            <div className="status-panel ok">
              <strong>Execution handoff</strong>
              <p>Run controls live in the dedicated Run view for Phase 5.</p>
            </div>
          ) : null}
          {plan.status === "running" ? (
            <div className="status-panel ok">
              <strong>Execution in progress</strong>
              <p>The child process is already running. Follow progress in the Run view.</p>
            </div>
          ) : null}
          {!plan.isReadOnly && isDirty ? (
            <div className="status-panel warning">
              <strong>Unsaved changes</strong>
              <p>Approve Plan is blocked until the current draft is saved.</p>
            </div>
          ) : null}
          {!plan.isReadOnly && !isSavedAndNonEmpty ? (
            <div className="status-panel warning">
              <strong>Empty draft</strong>
              <p>Write plan content and save it before approval.</p>
            </div>
          ) : null}
        </div>
      </article>

      <article className="panel panel-span-full editor-panel">
        <p className="eyebrow">Plan Editor</p>
        <div className="editor-header">
          <div>
            <h2>{plan.isReadOnly ? "Locked Plan" : "Draft Plan"}</h2>
            <p className="muted">
              {plan.isReadOnly
                ? "This saved plan is locked because it has already moved into execution flow."
                : "Edit markdown, save explicitly, then approve or reject the planning run."}
            </p>
          </div>
          <span className={`status-badge ${plan.status}`}>{plan.status}</span>
        </div>

        <textarea
          className="editor"
          value={draftContent}
          onChange={(event) => setDraftContent(event.target.value)}
          placeholder="Write the planning artifact here."
          readOnly={plan.isReadOnly}
        />

        <div className="editor-actions">
          <div>
            {planError ? <p className="error-copy">{planError}</p> : null}
            {!plan.isReadOnly ? (
              <p className="muted">
                Saved to disk only when you use Save Draft. Reject clears the active planning run
                without executing anything.
              </p>
            ) : (
              <p className="muted">Execution is intentionally out of scope for this phase.</p>
            )}
          </div>
          <div className="plan-actions">
            {plan.isReadOnly ? (
              <button className="primary-button" onClick={onOpenRun} disabled={isSaving}>
                Open Run View
              </button>
            ) : null}
            {!plan.isReadOnly ? (
              <button
                className="secondary-button"
                onClick={() => void handleSavePlan()}
                disabled={isSaving || !isDirty}
              >
                Save Draft
              </button>
            ) : null}
            {!plan.isReadOnly ? (
              <button
                className="primary-button"
                onClick={() => void handleApprovePlan()}
                disabled={isSaving || !canApprove}
              >
                Approve Plan
              </button>
            ) : null}
            {canReject ? (
              <button
                className="secondary-button"
                onClick={() => void handleRejectPlan()}
                disabled={isSaving}
              >
                Reject Plan
              </button>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
