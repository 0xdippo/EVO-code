export const TRACKED_FILES = [
  "PROJECT.md",
  "AGENTS.md",
  "TOOLS.md",
  "CHECKLISTS.md",
  "TASKS.md",
  "ops/project.json",
  "ops/state.json",
] as const;

export type TrackedFilePath = (typeof TRACKED_FILES)[number];

export type FileStatus = "present" | "missing" | "malformed";

export interface RepoFileRecord {
  path: TrackedFilePath;
  status: FileStatus;
  content: string | null;
  error: string | null;
}

export interface RepoWarning {
  kind: "missing_file" | "missing_directory" | "malformed_json" | "io_error";
  path: string;
  message: string;
}

export type DoctorSeverity = "warning" | "error";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  title: string;
  detail: string;
}

export interface DoctorReport {
  rootPath: string;
  repoRoot: string | null;
  findings: DoctorFinding[];
}

export type ProviderModel = "claude" | "codex";
export type PermissionMode = "normal" | "yolo";
export type AgentEffort = "low" | "medium" | "high";

export interface AgentConfig {
  id: string;
  name?: string;
  provider: ProviderModel;
  model: string;
  effort: AgentEffort;
  extendedThinking?: boolean;
  permissionMode?: PermissionMode;
}

export interface ProjectConfig {
  project_name?: string;
  description?: string;
  project_type?: string;
  phase?: string;
  stack?: string | Record<string, string>;
  models?: {
    planning?: ProviderModel;
    implementation?: ProviderModel;
    review?: ProviderModel;
    research?: ProviderModel;
  };
  execution?: {
    permission_mode?: PermissionMode;
    claude_permission_mode?: PermissionMode;
    codex_permission_mode?: PermissionMode;
    claude_enabled?: boolean;
    codex_enabled?: boolean;
  };
  agents?: AgentConfig[];
}

export interface ProjectState {
  latest_plan_path?: string | null;
  latest_plan_id?: string | null;
  last_run_id?: string | null;
  current_phase?: string;
  current_run_id?: string | null;
  current_run_status?: string | null;
  last_completed_task?: string | null;
  last_updated?: string | null;
}

export interface ActivePlan {
  runId: string;
  path: string;
  status: string;
  content: string;
  isReadOnly: boolean;
}

export interface RunRecord {
  runId: string;
  status: string;
  provider: string;
  planPath: string;
  outputPath: string;
  planContent: string;
  outputContent: string;
}

export type ChangedFileType = "modified" | "added" | "deleted" | "untracked" | "renamed";

export type ReviewDecision = "accept" | "reject" | "skip";

export interface ChangedFileEntry {
  path: string;
  previousPath: string | null;
  changeType: ChangedFileType;
  statusCode: string;
}

export interface ChangedFilesSnapshot {
  repoRoot: string;
  files: ChangedFileEntry[];
}

export interface ChangedFileDiff {
  repoRoot: string;
  path: string;
  previousPath: string | null;
  changeType: ChangedFileType;
  diff: string;
}

export interface RunOutputEvent {
  rootPath: string;
  runId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface RunStatusEvent {
  rootPath: string;
  runId: string;
  status: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  provider: string;
  content: string;
  createdAt: string;
}

export interface ChatThread {
  rootPath: string;
  path: string;
  messages: ChatMessage[];
}

export interface ChatStreamEvent {
  rootPath: string;
  messageId: string;
  provider: string;
  stream: "stdout" | "stderr";
  chunk: string;
  done: boolean;
}

export interface ToolBlock {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  isError: boolean;
}

export interface ChatToolEvent {
  rootPath: string;
  messageId: string;
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  isError: boolean;
}

export interface RepoSnapshot {
  rootPath: string;
  hasOpsDirectory: boolean;
  hasRunsDirectory: boolean;
  files: RepoFileRecord[];
  warnings: RepoWarning[];
  projectConfig: ProjectConfig | null;
  projectState: ProjectState | null;
  activePlan: ActivePlan | null;
  runRecord: RunRecord | null;
}

export type SaveRepositoryFile = (path: TrackedFilePath, content: string) => Promise<void>;

export interface SetupFormValues {
  projectName: string;
  description: string;
  projectType: string;
  phase: string;
  stack: string;
  agents: AgentConfig[];
}
