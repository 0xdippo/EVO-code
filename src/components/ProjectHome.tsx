import { useMemo, useState } from "react";
import { getCurrentPhase } from "../lib/setup";
import {
  isCompletedTaskStatus,
  parseTasksDocument,
  updateTaskStatusInMarkdown,
} from "../lib/tasks";
import type { RepoSnapshot, SaveRepositoryFile } from "../types/harness";

interface ProjectHomeProps {
  snapshot: RepoSnapshot;
  isSaving: boolean;
  onConfigure: () => void;
  onSave: SaveRepositoryFile;
}

type WorkflowStepState = "active" | "done" | "pending";

interface WorkflowSummary {
  plan: WorkflowStepState;
  run: WorkflowStepState;
  review: WorkflowStepState;
  nextAction: string;
}

function deriveWorkflowSummary(snapshot: RepoSnapshot): WorkflowSummary {
  const status = snapshot.projectState?.current_run_status?.trim().toLowerCase() ?? "";
  const hasPlan = Boolean(snapshot.projectState?.latest_plan_id);

  if (status === "reviewed") {
    return {
      plan: "done",
      run: "done",
      review: "done",
      nextAction: "Start the next planning thread when a new task is ready.",
    };
  }

  if (status === "done" || status === "failed" || status === "cancelled") {
    return {
      plan: "done",
      run: "done",
      review: "active",
      nextAction: "Review the latest run diff and resolve the workflow.",
    };
  }

  if (status === "running") {
    return {
      plan: "done",
      run: "active",
      review: "pending",
      nextAction: "Wait for the active run to finish before review.",
    };
  }

  if (status === "planned") {
    return {
      plan: "done",
      run: "active",
      review: "pending",
      nextAction: "Start the approved run when the task is ready for implementation.",
    };
  }

  if (status === "draft") {
    return {
      plan: "active",
      run: "pending",
      review: "pending",
      nextAction: "Finish the draft plan, then approve it to unlock the run.",
    };
  }

  if (status === "rejected") {
    return {
      plan: hasPlan ? "done" : "active",
      run: "pending",
      review: "pending",
      nextAction: "Create a fresh plan before starting another workflow thread.",
    };
  }

  if (hasPlan) {
    return {
      plan: "done",
      run: "pending",
      review: "pending",
      nextAction: "Start a run from the latest approved plan.",
    };
  }

  return {
    plan: "active",
    run: "pending",
    review: "pending",
    nextAction: "Create the first plan to begin the workflow.",
  };
}

export function ProjectHome({ snapshot, isSaving, onConfigure, onSave }: ProjectHomeProps) {
  const config = snapshot.projectConfig;
  const state = snapshot.projectState;
  const currentPhase = getCurrentPhase(snapshot);
  const tasksFile = snapshot.files.find((file) => file.path === "TASKS.md") ?? null;
  const tasksContent = tasksFile?.content ?? "";
  const hasActiveRun = Boolean(state?.current_run_id);
  const latestPlanLabel = state?.latest_plan_id ?? "None";
  const runStatusLabel = hasActiveRun
    ? state?.current_run_status ?? "Unknown"
    : state?.current_run_status === "rejected"
      ? "rejected"
      : "idle";
  const [taskError, setTaskError] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const taskDocument = useMemo(
    () => parseTasksDocument(tasksContent, tasksFile?.status),
    [tasksContent, tasksFile?.status],
  );
  const workflow = useMemo(() => deriveWorkflowSummary(snapshot), [snapshot]);
  const taskProgress = useMemo(() => {
    if (taskDocument.kind !== "parsed") {
      return null;
    }

    const phases = taskDocument.phases.map((phase) => {
      const completedTasks = phase.tasks.filter((task) =>
        isCompletedTaskStatus(task.status, taskDocument.statusDefinitions),
      ).length;

      return {
        ...phase,
        completedTasks,
      };
    });
    const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const completedTasks = phases.reduce((sum, phase) => sum + phase.completedTasks, 0);

    return {
      phases,
      totalTasks,
      completedTasks,
    };
  }, [taskDocument]);

  async function handleStatusChange(taskId: string, nextStatus: string) {
    if (taskDocument.kind !== "parsed") {
      return;
    }

    try {
      setTaskError(null);
      setUpdatingTaskId(taskId);
      const nextContent = updateTaskStatusInMarkdown(tasksContent, taskId, nextStatus);
      await onSave("TASKS.md", nextContent);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Failed to update TASKS.md.");
    } finally {
      setUpdatingTaskId(null);
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel">
        <p className="eyebrow">Project Home</p>
        <div className="panel-header">
          <div>
            <h2>{config?.project_name ?? "Unnamed project"}</h2>
            <p className="muted">
              {config?.description ?? "No project description found in ops/project.json."}
            </p>
          </div>
          <button className="secondary-button" onClick={onConfigure}>
            Configure
          </button>
        </div>
        <div className="phase-banner">
          <span className="eyebrow">Current Phase</span>
          <strong>{currentPhase}</strong>
        </div>
        <p className="muted">
          HARNESS reads the active phase from `ops/state.json` first and falls back to
          `ops/project.json` when state has not moved yet.
        </p>
        <div className="workflow-strip" aria-label="Workflow status">
          {(["plan", "run", "review"] as const).map((step) => (
            <div
              className={`workflow-step ${workflow[step]}`}
              key={step}
            >
              <span className="workflow-step-label">
                {step === "plan" ? "Plan" : step === "run" ? "Run" : "Review"}
              </span>
              <strong>{workflow[step]}</strong>
            </div>
          ))}
        </div>
        <p className="workflow-next-action">
          <span className="eyebrow">Next action</span>
          <strong>{workflow.nextAction}</strong>
        </p>
        <dl className="key-value-list">
          <div>
            <dt>Type</dt>
            <dd>{config?.project_type ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Configured phase</dt>
            <dd>{config?.phase ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Last completed task</dt>
            <dd>{state?.last_completed_task ?? "None"}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <p className="eyebrow">Run State</p>
        <h2>{hasActiveRun ? state?.current_run_id : "No active run"}</h2>
        <p className="muted">
          {hasActiveRun
            ? `Status: ${state?.current_run_status ?? "Unknown"}`
            : runStatusLabel === "rejected"
              ? "The latest planning run was rejected and the active slot is clear."
              : "No run is currently active for this repository."}
        </p>
        <dl className="key-value-list">
          <div>
            <dt>Repository root</dt>
            <dd>{snapshot.rootPath}</dd>
          </div>
          <div>
            <dt>`ops/` directory</dt>
            <dd>{snapshot.hasOpsDirectory ? "Present" : "Missing"}</dd>
          </div>
          <div>
            <dt>`ops/runs/` directory</dt>
            <dd>{snapshot.hasRunsDirectory ? "Present" : "Missing"}</dd>
          </div>
          <div>
            <dt>Run status</dt>
            <dd>{runStatusLabel}</dd>
          </div>
          <div>
            <dt>Latest plan</dt>
            <dd>{latestPlanLabel}</dd>
          </div>
        </dl>
      </article>

      <article className="panel panel-span-full">
        <p className="eyebrow">Tasks</p>
        <div className="panel-header">
          <div>
            <h2>Task Board</h2>
            <p className="muted">
              Phase-grouped task view from `TASKS.md`, limited to status updates only.
            </p>
          </div>
        </div>

        {taskProgress && taskProgress.totalTasks > 0 ? (
          <div className="task-progress-summary">
            <strong>
              {taskProgress.completedTasks} of {taskProgress.totalTasks} tasks completed
            </strong>
          </div>
        ) : null}

        {taskError ? <p className="error-copy">{taskError}</p> : null}

        {taskDocument.kind === "parsed" && taskProgress ? (
          <div className="task-board">
            {taskProgress.phases.map((phase) => (
              <section className="task-phase" key={phase.heading}>
                <div className="task-phase-header">
                  <h3>{phase.heading}</h3>
                  <span>
                    {phase.completedTasks}/{phase.tasks.length} completed
                  </span>
                </div>
                <div className="task-table-scroll">
                  <table className="task-table">
                    <thead>
                      <tr>
                        <th scope="col">Task ID</th>
                        <th scope="col">Title</th>
                        <th scope="col">Owner</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {phase.tasks.map((task) => {
                        const isUpdating = updatingTaskId === task.id;

                        return (
                          <tr key={task.id}>
                            <td className="task-id">{task.id}</td>
                            <td>{task.title}</td>
                            <td>
                              <span className="task-meta">{task.owner}</span>
                            </td>
                            <td>
                              <select
                                className="task-status-select"
                                value={task.status}
                                onChange={(event) =>
                                  void handleStatusChange(task.id, event.target.value)
                                }
                                disabled={isSaving || isUpdating}
                              >
                                {taskDocument.statusOptions.map((status) => (
                                  <option key={status} value={status}>
                                    {status}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        ) : taskDocument.kind === "raw" && taskDocument.reason === "parse-error" ? (
          <div className="task-fallback">
            <section className="status-panel warning">{taskDocument.message}</section>
            <pre className="tasks-viewer">
              {taskDocument.rawContent || "TASKS.md is present but could not be rendered."}
            </pre>
          </div>
        ) : taskDocument.kind === "raw" ? (
          <div className="empty-state compact-empty-state">
            <h3>No task board yet</h3>
            <p>{taskDocument.message}</p>
          </div>
        ) : null}
      </article>
    </section>
  );
}
