import { useEffect, useMemo, useState } from "react";
import { ChecklistView } from "./components/ChecklistView";
import { DoctorView } from "./components/DoctorView";
import { PlanView } from "./components/PlanView";
import { RepoSelector } from "./components/RepoSelector";
import { ProjectHome } from "./components/ProjectHome";
import { RepoRulesPanel } from "./components/RepoRulesPanel";
import { ReviewView } from "./components/ReviewView";
import { RunView } from "./components/RunView";
import { SetupScreen } from "./components/SetupScreen";
import { WarningList } from "./components/WarningList";
import { getSetupFormDefaults, isProjectInitialized } from "./lib/setup";
import {
  approvePlan,
  cancelRun,
  createPlanRun,
  listenForRunOutput,
  listenForRunStatus,
  openRepository,
  rejectPlan,
  runDoctorChecks,
  savePlan,
  setupProject,
  startRun,
  writeRepositoryFile,
} from "./lib/tauri";
import type {
  DoctorReport,
  RepoSnapshot,
  RunOutputEvent,
  RunStatusEvent,
  SaveRepositoryFile,
  SetupFormValues,
} from "./types/harness";

type ViewMode =
  | "review"
  | "doctor"
  | "home"
  | "checklists"
  | "plan"
  | "rules"
  | "run"
  | "setup";
const LAST_REPO_STORAGE_KEY = "harness_last_repo";

export function App() {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("home");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [runOutputEvent, setRunOutputEvent] = useState<RunOutputEvent | null>(null);
  const [runStatusEvent, setRunStatusEvent] = useState<RunStatusEvent | null>(null);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorLastCheckedAt, setDoctorLastCheckedAt] = useState<string | null>(null);
  const [isDoctorRunning, setIsDoctorRunning] = useState(false);

  const title = useMemo(() => {
    if (!snapshot?.projectConfig?.project_name) {
      return "HARNESS";
    }

    return `${snapshot.projectConfig.project_name} / HARNESS`;
  }, [snapshot?.projectConfig?.project_name]);

  const initialized = isProjectInitialized(snapshot);
  const setupDefaults = useMemo(
    () => getSetupFormDefaults(snapshot?.projectConfig ?? null),
    [snapshot?.projectConfig],
  );

  useEffect(() => {
    const storedPath = window.localStorage.getItem(LAST_REPO_STORAGE_KEY);
    if (!storedPath) {
      return;
    }

    void handleSelectRepo(storedPath, { silent: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let outputUnlisten: (() => void) | null = null;
    let statusUnlisten: (() => void) | null = null;

    void listenForRunOutput((event) => {
      if (!cancelled) {
        setRunOutputEvent(event);
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }

      outputUnlisten = unlisten;
    });

    void listenForRunStatus((event) => {
      if (cancelled) {
        return;
      }

      setRunStatusEvent(event);
      if (selectedPath && event.rootPath === selectedPath) {
        void handleSelectRepo(selectedPath, { silent: true });
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }

      statusUnlisten = unlisten;
    });

    return () => {
      cancelled = true;
      outputUnlisten?.();
      statusUnlisten?.();
    };
  }, [selectedPath]);

  async function handleSelectRepo(path: string, options?: { silent?: boolean }) {
    try {
      setIsLoading(true);
      if (!options?.silent) {
        setAppError(null);
      }
      const nextSnapshot = await openRepository(path);
      const isSamePath = selectedPath === path;
      setSelectedPath(path);
      setSnapshot(nextSnapshot);
      if (!isSamePath) {
        setDoctorReport(null);
        setDoctorLastCheckedAt(null);
      }
      setView((currentView) => {
        if (!isProjectInitialized(nextSnapshot)) {
          return "setup";
        }

        if (currentView === "run" && !nextSnapshot.runRecord) {
          return "home";
        }

        return currentView === "setup" ? "home" : currentView;
      });
      window.localStorage.setItem(LAST_REPO_STORAGE_KEY, path);
    } catch (error) {
      setSnapshot(null);
      setSelectedPath(null);
      setDoctorReport(null);
      setDoctorLastCheckedAt(null);
      setView("home");
      window.localStorage.removeItem(LAST_REPO_STORAGE_KEY);
      if (!options?.silent) {
        setAppError(error instanceof Error ? error.message : "Failed to open repository.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSetupSubmit(values: SetupFormValues) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await setupProject(selectedPath, values);
      setSnapshot(nextSnapshot);
      setView(isProjectInitialized(nextSnapshot) ? "home" : "setup");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Failed to save project setup.");
    } finally {
      setIsSaving(false);
    }
  }

  const handleSave: SaveRepositoryFile = async (path, content) => {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await writeRepositoryFile(selectedPath, path, content);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save file.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  };

  async function handleCreatePlan() {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await createPlanRun(selectedPath);
      setSnapshot(nextSnapshot);
      setView("plan");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create plan run.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSavePlan(runId: string, content: string) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await savePlan(selectedPath, runId, content);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save plan.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleApprovePlan(runId: string) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await approvePlan(selectedPath, runId);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to approve plan.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRejectPlan(runId: string) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await rejectPlan(selectedPath, runId);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reject plan.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleStartRun(runId: string) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await startRun(selectedPath, runId);
      setSnapshot(nextSnapshot);
      setView("run");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start run.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCancelRun(runId: string) {
    if (!selectedPath) {
      return;
    }

    try {
      setIsSaving(true);
      setAppError(null);
      const nextSnapshot = await cancelRun(selectedPath, runId);
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to cancel run.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRunDoctorChecks() {
    if (!selectedPath) {
      return;
    }

    try {
      setIsDoctorRunning(true);
      setAppError(null);
      const report = await runDoctorChecks(selectedPath);
      setDoctorReport(report);
      setDoctorLastCheckedAt(new Date().toLocaleString());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to run doctor checks.";
      setAppError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsDoctorRunning(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop Orchestration Workspace</p>
          <h1>{title}</h1>
        </div>
        {snapshot ? (
          <nav className="view-toggle">
            <button
              className={view === "setup" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("setup")}
            >
              Setup
            </button>
            <button
              className={view === "home" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("home")}
              disabled={!initialized}
            >
              Project Home
            </button>
            <button
              className={view === "plan" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("plan")}
              disabled={!initialized}
            >
              Plan
            </button>
            <button
              className={view === "run" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("run")}
              disabled={!initialized || !snapshot.runRecord}
            >
              Run
            </button>
            <button
              className={view === "review" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("review")}
              disabled={!initialized}
            >
              Review
            </button>
            <button
              className={view === "doctor" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("doctor")}
            >
              Doctor
            </button>
            <button
              className={view === "checklists" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("checklists")}
            >
              Checklists
            </button>
            <button
              className={view === "rules" ? "toggle-button active" : "toggle-button"}
              onClick={() => setView("rules")}
            >
              Repo Rules
            </button>
          </nav>
        ) : null}
      </header>

      <RepoSelector
        isLoading={isLoading}
        selectedPath={selectedPath}
        onSelect={handleSelectRepo}
      />

      {appError ? <section className="status-panel error">{appError}</section> : null}

      {snapshot ? (
        <>
          <WarningList warnings={snapshot.warnings} />
          {view === "setup" || (!initialized && view === "home") ? (
            <SetupScreen
              snapshot={snapshot}
              initialValues={setupDefaults}
              isSaving={isSaving}
              onSubmit={handleSetupSubmit}
            />
          ) : view === "home" ? (
            <ProjectHome
              snapshot={snapshot}
              isSaving={isSaving}
              onConfigure={() => setView("setup")}
              onSave={handleSave}
            />
          ) : view === "plan" ? (
            <PlanView
              snapshot={snapshot}
              isSaving={isSaving}
              onCreatePlan={handleCreatePlan}
              onSavePlan={handleSavePlan}
              onApprovePlan={handleApprovePlan}
              onRejectPlan={handleRejectPlan}
              onOpenRun={() => setView("run")}
            />
          ) : view === "run" ? (
            <RunView
              snapshot={snapshot}
              isSaving={isSaving}
              outputEvent={runOutputEvent}
              statusEvent={runStatusEvent}
              onStartRun={handleStartRun}
              onCancelRun={handleCancelRun}
            />
          ) : view === "review" ? (
            <ReviewView snapshot={snapshot} onSnapshotChange={setSnapshot} />
          ) : view === "doctor" ? (
            <DoctorView
              report={doctorReport}
              snapshot={snapshot}
              isRunning={isDoctorRunning}
              lastCheckedAt={doctorLastCheckedAt}
              onRunChecks={handleRunDoctorChecks}
            />
          ) : view === "checklists" ? (
            <ChecklistView snapshot={snapshot} />
          ) : (
            <RepoRulesPanel snapshot={snapshot} isSaving={isSaving} onSave={handleSave} />
          )}
        </>
      ) : (
        <section className="empty-state">
          <h2>Select a repository to begin</h2>
          <p>
            Phase 2 adds project setup detection, repo-local bootstrap writes, and
            a more meaningful Project Home while keeping the rest of the workflow
            intentionally out of scope.
          </p>
        </section>
      )}
    </main>
  );
}
