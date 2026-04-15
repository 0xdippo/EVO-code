import { useMemo, useState } from "react";
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

export function ProjectHome({ snapshot, isSaving, onConfigure, onSave }: ProjectHomeProps) {
  const config = snapshot.projectConfig;
  const tasksFile = snapshot.files.find((file) => file.path === "TASKS.md") ?? null;
  const tasksContent = tasksFile?.content ?? "";
  const [taskError, setTaskError] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const taskDocument = useMemo(
    () => parseTasksDocument(tasksContent, tasksFile?.status),
    [tasksContent, tasksFile?.status],
  );

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
      <article className="panel panel-span-full">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h2>{config?.project_name ?? "Unnamed project"}</h2>
            <p className="muted">
              {config?.description ?? "No project description found in ops/project.json."}
            </p>
          </div>
          <button className="secondary-button" onClick={onConfigure}>
            Edit Setup
          </button>
        </div>
        <dl className="key-value-list compact-kv-list">
          <div>
            <dt>Type</dt>
            <dd>{config?.project_type ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Claude agent</dt>
            <dd>
              {config?.execution?.claude_enabled === false
                ? "disabled"
                : `enabled (${config?.execution?.claude_permission_mode ?? "normal"})`}
            </dd>
          </div>
          <div>
            <dt>Codex agent</dt>
            <dd>
              {config?.execution?.codex_enabled === false
                ? "disabled"
                : `enabled (${config?.execution?.codex_permission_mode ?? "normal"})`}
            </dd>
          </div>
        </dl>
      </article>

      <article className="panel panel-span-full">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Tasks</p>
            <h2>Task Board</h2>
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
