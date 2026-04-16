import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentConfig,
  ChatStreamEvent,
  ChatThreadUpdatedEvent,
  ChatToolEvent,
  ChatThread,
  ChangedFileDiff,
  ChangedFilesSnapshot,
  ChangedFileType,
  DoctorReport,
  RepoSnapshot,
  ReviewDecision,
  RunOutputEvent,
  RunStatusEvent,
  SetupFormValues,
  TrackedFilePath,
} from "../types/harness";
import { agentDisplayName } from "./setup";

export async function openRepository(rootPath: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("open_repository", { rootPath });
}

export async function writeRepositoryFile(
  rootPath: string,
  filePath: TrackedFilePath,
  content: string,
): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("write_repository_file", {
    rootPath,
    filePath,
    content,
  });
}

export async function createPlanRun(rootPath: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("create_plan_run", { rootPath });
}

export async function savePlan(
  rootPath: string,
  runId: string,
  content: string,
): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("save_plan", { rootPath, runId, content });
}

export async function approvePlan(rootPath: string, runId: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("approve_plan", { rootPath, runId });
}

export async function rejectPlan(rootPath: string, runId: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("reject_plan", { rootPath, runId });
}

export async function startRun(rootPath: string, runId: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("start_run", { rootPath, runId });
}

export async function cancelRun(rootPath: string, runId: string): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("cancel_run", { rootPath, runId });
}

export function listenForRunOutput(
  listener: (event: RunOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<RunOutputEvent>("run-output", (event) => listener(event.payload));
}

export function listenForRunStatus(
  listener: (event: RunStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<RunStatusEvent>("run-status", (event) => listener(event.payload));
}

export async function setupProject(
  rootPath: string,
  values: SetupFormValues,
): Promise<RepoSnapshot> {
  const lastUpdated = new Date().toISOString().slice(0, 10);

  return invoke<RepoSnapshot>("setup_project", {
    rootPath,
    input: {
      projectName: values.projectName,
      description: values.description,
      projectType: values.projectType,
      phase: values.phase,
      stack: values.stack,
      agents: values.agents,
      lastUpdated,
    },
  });
}

export async function listChangedFiles(rootPath: string): Promise<ChangedFilesSnapshot> {
  return invoke<ChangedFilesSnapshot>("list_changed_files", { rootPath });
}

export async function loadChangedFileDiff(
  rootPath: string,
  path: string,
  changeType: ChangedFileType,
): Promise<ChangedFileDiff> {
  return invoke<ChangedFileDiff>("load_changed_file_diff", {
    rootPath,
    path,
    changeType,
  });
}

export async function applyReviewDecision(
  rootPath: string,
  path: string,
  changeType: ChangedFileType,
  decision: Exclude<ReviewDecision, "skip">,
  previousPath?: string | null,
): Promise<void> {
  return invoke<void>("apply_review_decision", {
    input: {
      rootPath,
      path,
      changeType,
      decision,
      previousPath,
    },
  });
}

export async function clearAcceptedReviewDecision(
  rootPath: string,
  path: string,
  previousPath?: string | null,
): Promise<void> {
  return invoke<void>("clear_accepted_review_decision", {
    input: {
      rootPath,
      path,
      previousPath,
    },
  });
}

export async function commitAcceptedChanges(
  rootPath: string,
  message: string,
): Promise<RepoSnapshot> {
  return invoke<RepoSnapshot>("commit_accepted_changes", {
    rootPath,
    message,
  });
}

export async function runDoctorChecks(rootPath: string): Promise<DoctorReport> {
  return invoke<DoctorReport>("run_doctor_checks", { rootPath });
}

export async function loadChatThread(rootPath: string): Promise<ChatThread> {
  return invoke<ChatThread>("load_chat_thread", { rootPath });
}

export async function sendChatMessage(
  rootPath: string,
  agent: AgentConfig,
  content: string,
): Promise<ChatThread> {
  return invoke<ChatThread>("send_chat_message", {
    input: {
      rootPath,
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      extendedThinking: agent.extendedThinking ?? false,
      agentName: agentDisplayName(agent),
      permissionMode: agent.permissionMode ?? "normal",
      content,
    },
  });
}

export function listenForChatStream(
  listener: (event: ChatStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChatStreamEvent>("chat-stream", (event) => listener(event.payload));
}

export async function cancelChatMessage(): Promise<void> {
  return invoke<void>("cancel_chat_message");
}

export function listenForChatTool(
  listener: (event: ChatToolEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChatToolEvent>("chat-tool", (event) => listener(event.payload));
}

export function listenForChatThreadUpdated(
  listener: (event: ChatThreadUpdatedEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChatThreadUpdatedEvent>("chat-thread-updated", (event) => listener(event.payload));
}
