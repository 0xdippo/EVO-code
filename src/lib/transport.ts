/**
 * transport.ts — single entry point for all backend communication.
 *
 * Standalone mode: proxies directly to Tauri IPC (tauri.ts).
 * Remote mode: routes invoke() calls to HTTP POST and listen() calls
 * to a shared WebSocket connection on the host machine.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { agentDisplayName } from "./setup";
import * as local from "./tauri";
import type {
  AgentConfig,
  ChangedFileDiff,
  ChangedFilesSnapshot,
  ChangedFileType,
  ChatStreamEvent,
  ChatThreadUpdatedEvent,
  ChatThread,
  ChatToolEvent,
  DoctorReport,
  RepoSnapshot,
  ReviewDecision,
  RunOutputEvent,
  RunStatusEvent,
  SharedRepository,
  SetupFormValues,
  TrackedFilePath,
} from "../types/harness";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type AppMode = "standalone" | "remote";

export interface RemoteConfig {
  mode: AppMode;
  serverUrl: string; // e.g. "192.168.1.5:7700" or "mac-studio.tail1234.ts.net:7700"
  serviceToken: string;
}

const MODE_KEY = "evo_mode";
const URL_KEY = "evo_server_url";
const TOKEN_KEY = "evo_service_token";

export function loadRemoteConfig(): RemoteConfig {
  const storedMode = window.localStorage.getItem(MODE_KEY);
  const mode: AppMode = storedMode === "remote" ? "remote" : "standalone";
  if (storedMode !== mode) {
    window.localStorage.setItem(MODE_KEY, mode);
  }

  return {
    mode,
    serverUrl: window.localStorage.getItem(URL_KEY) ?? "",
    serviceToken: window.localStorage.getItem(TOKEN_KEY) ?? "",
  };
}

export function saveRemoteConfig(config: RemoteConfig): void {
  window.localStorage.setItem(MODE_KEY, config.mode);
  window.localStorage.setItem(URL_KEY, config.serverUrl);
  window.localStorage.setItem(TOKEN_KEY, config.serviceToken);
  // Reset the WebSocket so it reconnects with the new config on next listen()
  closeRemoteWs();
}

// ---------------------------------------------------------------------------
// Remote transport — HTTP invoke
// ---------------------------------------------------------------------------

async function remoteInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const config = loadRemoteConfig();
  const serverUrl = config.serverUrl.trim().replace(/\/+$/, "");
  const serviceToken = config.serviceToken.trim();
  if (!serverUrl) {
    throw new Error("Remote Host URL is required in Settings.");
  }
  if (!serviceToken) {
    throw new Error("Remote service token is required in Settings.");
  }

  const base = serverUrl.startsWith("http") ? serverUrl : `http://${serverUrl}`;
  let response: Response;
  try {
    response = await fetch(`${base}/api/${command}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify(args),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error.";
    throw new Error(
      `Could not reach remote host "${serverUrl}". Check Host URL/token formatting and connectivity. (${message})`,
    );
  }

  const json = await response.json() as unknown;
  if (!response.ok) {
    const err = (json as { error?: string }).error;
    throw new Error(err ?? `Remote command ${command} failed with status ${response.status}`);
  }

  return json as T;
}

// ---------------------------------------------------------------------------
// Remote transport — WebSocket listen
// ---------------------------------------------------------------------------

let remoteWs: WebSocket | null = null;
const wsListeners = new Map<string, Set<(payload: unknown) => void>>();

function getRemoteWs(): WebSocket {
  if (remoteWs && (remoteWs.readyState === WebSocket.OPEN || remoteWs.readyState === WebSocket.CONNECTING)) {
    return remoteWs;
  }

  const config = loadRemoteConfig();
  const serverUrl = config.serverUrl.trim().replace(/\/+$/, "");
  const serviceToken = config.serviceToken.trim();
  if (!serverUrl || !serviceToken) {
    throw new Error("Remote Host URL and service token are required in Settings.");
  }

  const host = serverUrl.replace(/^https?:\/\//, "");
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://${host}/ws?token=${encodeURIComponent(serviceToken)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown WebSocket error.";
    throw new Error(
      `Invalid remote Host URL "${serverUrl}". Use host:port (for example 192.168.1.5:7700). (${message})`,
    );
  }

  ws.addEventListener("message", (ev) => {
    try {
      const { event, payload } = JSON.parse(ev.data as string) as { event: string; payload: unknown };
      wsListeners.get(event)?.forEach((cb) => cb(payload));
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener("close", () => {
    if (remoteWs === ws) remoteWs = null;
  });

  remoteWs = ws;
  return ws;
}

function closeRemoteWs(): void {
  remoteWs?.close();
  remoteWs = null;
}

function remoteListen<T>(eventName: string, callback: (payload: T) => void): Promise<UnlistenFn> {
  if (!wsListeners.has(eventName)) wsListeners.set(eventName, new Set());
  const set = wsListeners.get(eventName)!;
  const cb = (p: unknown) => callback(p as T);
  set.add(cb);
  getRemoteWs(); // ensure connection is open
  return Promise.resolve(() => set.delete(cb));
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

function isRemote(): boolean {
  return loadRemoteConfig().mode === "remote";
}

// ---------------------------------------------------------------------------
// Public API — mirrors tauri.ts exactly
// ---------------------------------------------------------------------------

export type {
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
  SharedRepository,
  SetupFormValues,
  TrackedFilePath,
} from "../types/harness";

export async function listSharedRepositories(): Promise<SharedRepository[]> {
  if (!isRemote()) return [];
  return remoteInvoke<SharedRepository[]>("list_shared_repositories", {});
}

export async function openRepository(rootPath: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.openRepository(rootPath);
  return remoteInvoke<RepoSnapshot>("open_repository", { rootPath });
}

export async function writeRepositoryFile(
  rootPath: string,
  filePath: TrackedFilePath,
  content: string,
): Promise<RepoSnapshot> {
  if (!isRemote()) return local.writeRepositoryFile(rootPath, filePath, content);
  return remoteInvoke<RepoSnapshot>("write_repository_file", { rootPath, filePath, content });
}

export async function createPlanRun(rootPath: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.createPlanRun(rootPath);
  return remoteInvoke<RepoSnapshot>("create_plan_run", { rootPath });
}

export async function savePlan(rootPath: string, runId: string, content: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.savePlan(rootPath, runId, content);
  return remoteInvoke<RepoSnapshot>("save_plan", { rootPath, runId, content });
}

export async function approvePlan(rootPath: string, runId: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.approvePlan(rootPath, runId);
  return remoteInvoke<RepoSnapshot>("approve_plan", { rootPath, runId });
}

export async function rejectPlan(rootPath: string, runId: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.rejectPlan(rootPath, runId);
  return remoteInvoke<RepoSnapshot>("reject_plan", { rootPath, runId });
}

export async function startRun(rootPath: string, runId: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.startRun(rootPath, runId);
  return remoteInvoke<RepoSnapshot>("start_run", { rootPath, runId });
}

export async function cancelRun(rootPath: string, runId: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.cancelRun(rootPath, runId);
  return remoteInvoke<RepoSnapshot>("cancel_run", { rootPath, runId });
}

export async function setupProject(rootPath: string, values: SetupFormValues): Promise<RepoSnapshot> {
  if (!isRemote()) return local.setupProject(rootPath, values);
  const lastUpdated = new Date().toISOString().slice(0, 10);
  return remoteInvoke<RepoSnapshot>("setup_project", {
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
  if (!isRemote()) return local.listChangedFiles(rootPath);
  return remoteInvoke<ChangedFilesSnapshot>("list_changed_files", { rootPath });
}

export async function loadChangedFileDiff(
  rootPath: string,
  path: string,
  changeType: ChangedFileType,
): Promise<ChangedFileDiff> {
  if (!isRemote()) return local.loadChangedFileDiff(rootPath, path, changeType);
  return remoteInvoke<ChangedFileDiff>("load_changed_file_diff", { rootPath, path, changeType });
}

export async function applyReviewDecision(
  rootPath: string,
  path: string,
  changeType: ChangedFileType,
  decision: Exclude<ReviewDecision, "skip">,
  previousPath?: string | null,
): Promise<void> {
  if (!isRemote()) return local.applyReviewDecision(rootPath, path, changeType, decision, previousPath);
  return remoteInvoke<void>("apply_review_decision", { input: { rootPath, path, changeType, decision, previousPath } });
}

export async function clearAcceptedReviewDecision(
  rootPath: string,
  path: string,
  previousPath?: string | null,
): Promise<void> {
  if (!isRemote()) return local.clearAcceptedReviewDecision(rootPath, path, previousPath);
  return remoteInvoke<void>("clear_accepted_review_decision", { input: { rootPath, path, previousPath } });
}

export async function commitAcceptedChanges(rootPath: string, message: string): Promise<RepoSnapshot> {
  if (!isRemote()) return local.commitAcceptedChanges(rootPath, message);
  return remoteInvoke<RepoSnapshot>("commit_accepted_changes", { rootPath, message });
}

export async function runDoctorChecks(rootPath: string): Promise<DoctorReport> {
  if (!isRemote()) return local.runDoctorChecks(rootPath);
  return remoteInvoke<DoctorReport>("run_doctor_checks", { rootPath });
}

export async function loadChatThread(rootPath: string): Promise<ChatThread> {
  if (!isRemote()) return local.loadChatThread(rootPath);
  return remoteInvoke<ChatThread>("load_chat_thread", { rootPath });
}

export async function sendChatMessage(
  rootPath: string,
  agent: AgentConfig,
  content: string,
): Promise<ChatThread> {
  if (!isRemote()) return local.sendChatMessage(rootPath, agent, content);
  return remoteInvoke<ChatThread>("send_chat_message", {
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

export async function cancelChatMessage(): Promise<void> {
  if (!isRemote()) return local.cancelChatMessage();
  return remoteInvoke<void>("cancel_chat_message", {});
}

export function listenForRunOutput(
  listener: (event: RunOutputEvent) => void,
): Promise<UnlistenFn> {
  if (!isRemote()) return local.listenForRunOutput(listener);
  return remoteListen<RunOutputEvent>("run-output", listener);
}

export function listenForRunStatus(
  listener: (event: RunStatusEvent) => void,
): Promise<UnlistenFn> {
  if (!isRemote()) return local.listenForRunStatus(listener);
  return remoteListen<RunStatusEvent>("run-status", listener);
}

export function listenForChatStream(
  listener: (event: ChatStreamEvent) => void,
): Promise<UnlistenFn> {
  if (!isRemote()) return local.listenForChatStream(listener);
  return remoteListen<ChatStreamEvent>("chat-stream", listener);
}

export function listenForChatTool(
  listener: (event: ChatToolEvent) => void,
): Promise<UnlistenFn> {
  if (!isRemote()) return local.listenForChatTool(listener);
  return remoteListen<ChatToolEvent>("chat-tool", listener);
}

export function listenForChatThreadUpdated(
  listener: (event: ChatThreadUpdatedEvent) => void,
): Promise<UnlistenFn> {
  if (!isRemote()) return local.listenForChatThreadUpdated(listener);
  return remoteListen<ChatThreadUpdatedEvent>("chat-thread-updated", listener);
}
