use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State as AxumState,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Local;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    net::TcpListener as StdTcpListener,
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

const TRACKED_FILES: [&str; 7] = [
    "PROJECT.md",
    "AGENTS.md",
    "TOOLS.md",
    "CHECKLISTS.md",
    "TASKS.md",
    "ops/project.json",
    "ops/state.json",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoSnapshot {
    root_path: String,
    has_ops_directory: bool,
    has_runs_directory: bool,
    files: Vec<RepoFileRecord>,
    warnings: Vec<RepoWarning>,
    project_config: Option<ProjectConfig>,
    project_state: Option<ProjectState>,
    active_plan: Option<PlanArtifact>,
    run_record: Option<RunArtifact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoFileRecord {
    path: String,
    status: String,
    content: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct RepoWarning {
    kind: String,
    path: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanArtifact {
    run_id: String,
    path: String,
    status: String,
    content: String,
    is_read_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunArtifact {
    run_id: String,
    status: String,
    provider: String,
    plan_path: String,
    output_path: String,
    plan_content: String,
    output_content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFilesSnapshot {
    repo_root: String,
    files: Vec<ChangedFileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFileEntry {
    path: String,
    previous_path: Option<String>,
    change_type: String,
    status_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFileDiff {
    repo_root: String,
    path: String,
    previous_path: Option<String>,
    change_type: String,
    diff: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewDecisionInput {
    root_path: String,
    path: String,
    change_type: String,
    decision: String,
    previous_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearAcceptedDecisionInput {
    root_path: String,
    path: String,
    previous_path: Option<String>,
}

struct GitCommandResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    id: String,
    name: Option<String>,
    provider: String,
    model: String,
    effort: String,
    extended_thinking: Option<bool>,
    permission_mode: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectConfig {
    project_name: Option<String>,
    description: Option<String>,
    project_type: Option<String>,
    phase: Option<String>,
    stack: Option<Value>,
    models: Option<ProjectModels>,
    execution: Option<ProjectExecution>,
    agents: Option<Vec<AgentConfig>>,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectState {
    latest_plan_path: Option<String>,
    latest_plan_id: Option<String>,
    last_run_id: Option<String>,
    current_phase: Option<String>,
    current_run_id: Option<String>,
    current_run_status: Option<String>,
    last_completed_task: Option<String>,
    last_updated: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectModels {
    planning: Option<String>,
    implementation: Option<String>,
    review: Option<String>,
    research: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectExecution {
    permission_mode: Option<String>,
    claude_enabled: Option<bool>,
    codex_enabled: Option<bool>,
    claude_permission_mode: Option<String>,
    codex_permission_mode: Option<String>,
}

struct RunManager {
    runs: Mutex<Vec<ActiveRun>>,
}

struct ActiveRun {
    root_path: String,
    run_id: String,
    child: Arc<Mutex<Child>>,
    cancel_requested: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunOutputEvent {
    root_path: String,
    run_id: String,
    stream: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatusEvent {
    root_path: String,
    run_id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamEvent {
    root_path: String,
    message_id: String,
    provider: String,
    stream: String,
    chunk: String,
    done: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatToolEvent {
    root_path: String,
    message_id: String,
    tool_id: String,
    tool_name: String,
    input: Value,
    result: Option<String>,
    is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatThreadUpdatedEvent {
    root_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    role: String,
    provider: String,
    content: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatThread {
    root_path: String,
    path: String,
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    root_path: String,
    repo_root: Option<String>,
    findings: Vec<DoctorFinding>,
}

#[derive(Serialize)]
struct DoctorFinding {
    id: String,
    severity: String,
    title: String,
    detail: String,
}

/// Events broadcast to all connected remote WebSocket clients.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
enum RemoteEvent {
    #[serde(rename = "chat-stream")]
    ChatStream(ChatStreamEvent),
    #[serde(rename = "chat-tool")]
    ChatTool(ChatToolEvent),
    #[serde(rename = "chat-thread-updated")]
    ChatThreadUpdated(ChatThreadUpdatedEvent),
    #[serde(rename = "run-output")]
    RunOutput(RunOutputEvent),
    #[serde(rename = "run-status")]
    RunStatus(RunStatusEvent),
}

struct RemoteServer {
    api_key: Mutex<Option<String>>,
    enabled: Mutex<bool>,
    event_tx: broadcast::Sender<RemoteEvent>,
}

impl RemoteServer {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        RemoteServer {
            api_key: Mutex::new(None),
            enabled: Mutex::new(false),
            event_tx: tx,
        }
    }

    fn generate_key() -> String {
        let mut rng = rand::thread_rng();
        (0..32)
            .map(|_| rng.sample(rand::distributions::Alphanumeric) as char)
            .collect()
    }

    fn is_enabled(&self) -> bool {
        *self.enabled.lock().unwrap()
    }

    fn broadcast(&self, event: RemoteEvent) {
        if self.is_enabled() {
            let _ = self.event_tx.send(event);
        }
    }
}

impl RunManager {
    fn ensure_slot_available(&self, root_path: &str) -> Result<(), String> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| "Run manager lock was poisoned.".to_string())?;

        if runs.iter().any(|run| run.root_path == root_path) {
            return Err(format!(
                "A run is already active for {root_path}. Finish or cancel it before starting another."
            ));
        }

        Ok(())
    }

    fn start_run(
        &self,
        root_path: &str,
        run_id: &str,
        child: Child,
        cancel_requested: Arc<AtomicBool>,
    ) -> Result<Arc<Mutex<Child>>, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Run manager lock was poisoned.".to_string())?;

        let child = Arc::new(Mutex::new(child));
        runs.push(ActiveRun {
            root_path: root_path.into(),
            run_id: run_id.into(),
            child: Arc::clone(&child),
            cancel_requested,
        });

        Ok(child)
    }

    fn cancel_run(&self, root_path: &str, run_id: &str) -> Result<(), String> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| "Run manager lock was poisoned.".to_string())?;
        let Some(run) = runs
            .iter()
            .find(|run| run.root_path == root_path && run.run_id == run_id)
        else {
            return Err(format!("Run {run_id} is not active, so it cannot be cancelled."));
        };

        run.cancel_requested.store(true, Ordering::SeqCst);

        let mut child = run
            .child
            .lock()
            .map_err(|_| "Run process lock was poisoned.".to_string())?;
        match child.kill() {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Err(format!(
                "Run {run_id} has already exited and can no longer be cancelled."
            )),
            Err(error) => Err(format!("Failed to cancel run {run_id}: {error}")),
        }
    }

    fn remove_run(&self, root_path: &str, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.retain(|run| !(run.root_path == root_path && run.run_id == run_id));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupProjectInput {
    project_name: String,
    description: String,
    project_type: String,
    phase: String,
    stack: String,
    agents: Vec<AgentConfig>,
    last_updated: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendChatMessageInput {
    root_path: String,
    provider: String,
    model: String,
    effort: String,
    #[allow(dead_code)]
    extended_thinking: Option<bool>,
    agent_name: Option<String>,
    permission_mode: String,
    content: String,
}


fn validate_tracked_path(file_path: &str) -> Result<(), String> {
    if !TRACKED_FILES.contains(&file_path) {
        return Err(format!("Unsupported file path: {file_path}"));
    }

    let path = Path::new(file_path);
    if path.is_absolute() {
        return Err("Absolute paths are not allowed.".into());
    }

    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("Parent directory traversal is not allowed.".into());
    }

    Ok(())
}

fn validate_repo_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("Repository path does not exist: {}", root.display()));
    }

    if !root.is_dir() {
        return Err(format!("Repository path is not a directory: {}", root.display()));
    }

    let git_path = root.join(".git");
    if !git_path.exists() {
        return Err(format!(
            "Selected directory is not a git repository: {} is missing.",
            git_path.display()
        ));
    }

    Ok(())
}

fn validate_relative_repo_path(file_path: &str) -> Result<(), String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("File path is required.".into());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("Absolute paths are not allowed.".into());
    }

    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Parent directory traversal is not allowed.".into());
    }

    Ok(())
}

fn ensure_repo_structure(root: &Path) -> Result<(bool, bool), String> {
    let ops_dir = root.join("ops");
    let runs_dir = ops_dir.join("runs");
    let had_ops_directory = ops_dir.exists();
    let had_runs_directory = runs_dir.exists();

    fs::create_dir_all(&runs_dir).map_err(|error| format!("Failed to create ops directories: {error}"))?;

    let gitkeep_path = runs_dir.join(".gitkeep");
    if !gitkeep_path.exists() {
        fs::write(&gitkeep_path, "").map_err(|error| format!("Failed to create ops/runs/.gitkeep: {error}"))?;
    }

    Ok((had_ops_directory, had_runs_directory))
}

fn read_text_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }

    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))
}

fn canonicalize_with_fallback(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        path.canonicalize()
            .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))
    } else if let Some(parent) = path.parent() {
        let parent = parent
            .canonicalize()
            .map_err(|error| format!("Failed to resolve {}: {error}", parent.display()))?;
        let file_name = path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", path.display()))?;
        Ok(parent.join(file_name))
    } else {
        Err(format!("Invalid path: {}", path.display()))
    }
}

fn ensure_path_within_repo(repo_root: &Path, relative_path: &str) -> Result<(), String> {
    validate_relative_repo_path(relative_path)?;

    let repo_root = repo_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", repo_root.display()))?;
    let target = canonicalize_with_fallback(&repo_root.join(relative_path))?;

    if !target.starts_with(&repo_root) {
        return Err(format!("Path escapes repository root: {relative_path}"));
    }

    Ok(())
}

fn read_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let Some(content) = read_text_file(path)? else {
        return Ok(None);
    };

    let json_value = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;

    match json_value {
        Value::Object(map) => Ok(Some(map)),
        _ => Err(format!("Expected {} to contain a JSON object.", path.display())),
    }
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;

    fs::write(path, content).map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn run_git_command(repo_root: &Path, args: &[&str]) -> Result<GitCommandResult, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|error| format!("Failed to run git {}: {error}", args.join(" ")))?;

    Ok(GitCommandResult {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn resolve_git_repo_root(root: &Path) -> Result<PathBuf, String> {
    let result = run_git_command(root, &["rev-parse", "--show-toplevel"])?;
    if result.code != Some(0) {
        let detail = result.stderr.trim();
        return Err(if detail.is_empty() {
            "Failed to resolve git repository root.".into()
        } else {
            format!("Failed to resolve git repository root: {detail}")
        });
    }

    let repo_root = result.stdout.trim();
    if repo_root.is_empty() {
        return Err("Git repository root command returned an empty path.".into());
    }

    Ok(PathBuf::from(repo_root))
}

fn today_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn generate_run_id() -> String {
    Local::now().format("run-%Y%m%d-%H%M%S").to_string()
}

fn parse_change_type(status_code: &str, default_rename: bool) -> String {
    if default_rename {
        return "renamed".into();
    }

    let bytes = status_code.as_bytes();
    let index = bytes.first().copied().unwrap_or(b' ');
    let worktree = bytes.get(1).copied().unwrap_or(b' ');

    if index == b'R' || worktree == b'R' {
        "renamed".into()
    } else if index == b'A' || worktree == b'A' {
        "added".into()
    } else if index == b'D' || worktree == b'D' {
        "deleted".into()
    } else {
        "modified".into()
    }
}

fn parse_changed_files(repo_root: &Path) -> Result<Vec<ChangedFileEntry>, String> {
    let result = run_git_command(
        repo_root,
        &["status", "--porcelain=v2", "-z", "--find-renames", "--untracked-files=all"],
    )?;

    if result.code != Some(0) {
        let detail = result.stderr.trim();
        return Err(if detail.is_empty() {
            "git status failed.".into()
        } else {
            format!("git status failed: {detail}")
        });
    }

    let mut files = Vec::new();
    let mut entries = result
        .stdout
        .split('\0')
        .filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        if let Some(path) = entry.strip_prefix("? ") {
            files.push(ChangedFileEntry {
                path: path.into(),
                previous_path: None,
                change_type: "untracked".into(),
                status_code: "??".into(),
            });
            continue;
        }

        if entry.starts_with("1 ") {
            let parts: Vec<&str> = entry.splitn(9, ' ').collect();
            if parts.len() != 9 {
                continue;
            }

            files.push(ChangedFileEntry {
                path: parts[8].into(),
                previous_path: None,
                change_type: parse_change_type(parts[1], false),
                status_code: parts[1].into(),
            });
            continue;
        }

        if entry.starts_with("2 ") {
            let parts: Vec<&str> = entry.splitn(10, ' ').collect();
            if parts.len() != 10 {
                continue;
            }

            let previous_path = entries.next().map(str::to_owned);
            files.push(ChangedFileEntry {
                path: parts[9].into(),
                previous_path,
                change_type: parse_change_type(parts[1], true),
                status_code: parts[1].into(),
            });
        }
    }

    Ok(files)
}

fn diff_tracked_file(repo_root: &Path, path: &str) -> Result<String, String> {
    let result = run_git_command(repo_root, &["diff", "--find-renames", "HEAD", "--", path])?;
    match result.code {
        Some(0) => Ok(result.stdout),
        Some(1) => Ok(result.stdout),
        _ => {
            let detail = result.stderr.trim();
            Err(if detail.is_empty() {
                format!("git diff failed for {path}.")
            } else {
                format!("git diff failed for {path}: {detail}")
            })
        }
    }
}

fn diff_untracked_or_added_file(repo_root: &Path, path: &str) -> Result<String, String> {
    // TODO: replace /dev/null with a Windows-safe null file strategy when Windows support is added.
    let result = run_git_command(repo_root, &["diff", "--no-index", "--", "/dev/null", path])?;
    match result.code {
        Some(0) | Some(1) => Ok(result.stdout),
        _ => {
            let detail = result.stderr.trim();
            Err(if detail.is_empty() {
                format!("git diff failed for {path}.")
            } else {
                format!("git diff failed for {path}: {detail}")
            })
        }
    }
}

fn find_changed_file(
    repo_root: &Path,
    path: &str,
    change_type: Option<&str>,
) -> Result<ChangedFileEntry, String> {
    validate_relative_repo_path(path)?;

    let file = parse_changed_files(repo_root)?
        .into_iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| format!("Path is not currently reported by git status: {path}"))?;

    if let Some(expected_change_type) = change_type {
        if file.change_type != expected_change_type {
            return Err(format!(
                "Requested change type {expected_change_type} does not match current git status {} for {path}.",
                file.change_type
            ));
        }
    }

    ensure_path_within_repo(repo_root, &file.path)?;
    if let Some(previous_path) = file.previous_path.as_deref() {
        ensure_path_within_repo(repo_root, previous_path)?;
    }

    Ok(file)
}

fn git_command_error(action: &str, result: &GitCommandResult) -> String {
    let detail = result.stderr.trim();
    if detail.is_empty() {
        format!("{action} failed.")
    } else {
        format!("{action} failed: {detail}")
    }
}

fn run_git_command_checked(repo_root: &Path, args: &[&str], action: &str) -> Result<(), String> {
    let result = run_git_command(repo_root, args)?;
    if result.code == Some(0) {
        Ok(())
    } else {
        Err(git_command_error(action, &result))
    }
}

fn run_git_command_allow_missing_path(
    repo_root: &Path,
    args: &[&str],
    action: &str,
) -> Result<(), String> {
    let result = run_git_command(repo_root, args)?;
    if result.code == Some(0) {
        return Ok(());
    }

    let stderr = result.stderr.trim();
    if stderr.contains("pathspec") && stderr.contains("did not match any file") {
        return Ok(());
    }

    Err(git_command_error(action, &result))
}

fn remove_path_from_repo(repo_root: &Path, relative_path: &str) -> Result<(), String> {
    ensure_path_within_repo(repo_root, relative_path)?;

    let target = repo_root.join(relative_path);
    if !target.exists() {
        return Ok(());
    }

    if target.is_dir() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Failed to remove {relative_path}: {error}"))?;
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("Failed to remove {relative_path}: {error}"))?;
    }

    Ok(())
}

fn reject_changed_file(repo_root: &Path, file: &ChangedFileEntry) -> Result<(), String> {
    match file.change_type.as_str() {
        "modified" | "deleted" => run_git_command_checked(
            repo_root,
            &["restore", "--source=HEAD", "--staged", "--worktree", "--", &file.path],
            &format!("Rejecting {}", file.path),
        ),
        "added" => run_git_command_checked(
            repo_root,
            &["rm", "--force", "--", &file.path],
            &format!("Rejecting {}", file.path),
        ),
        "untracked" => remove_path_from_repo(repo_root, &file.path),
        "renamed" => {
            let previous_path = file.previous_path.as_deref().ok_or_else(|| {
                format!("Cannot reject renamed file {} without its previous path.", file.path)
            })?;

            run_git_command_checked(
                repo_root,
                &["restore", "--source=HEAD", "--staged", "--worktree", "--", previous_path],
                &format!("Rejecting {}", file.path),
            )?;
            run_git_command_allow_missing_path(
                repo_root,
                &["rm", "--cached", "--force", "--", &file.path],
                &format!("Cleaning index state for {}", file.path),
            )?;
            remove_path_from_repo(repo_root, &file.path)
        }
        other => Err(format!("Unsupported review change type: {other}")),
    }
}

fn staged_files(repo_root: &Path) -> Result<Vec<String>, String> {
    let result = run_git_command(
        repo_root,
        &["diff", "--cached", "--name-only", "--diff-filter=ACMRD"],
    )?;
    if result.code != Some(0) {
        return Err(git_command_error("Inspecting staged files", &result));
    }

    Ok(result
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn read_state_map(root: &Path) -> Result<Map<String, Value>, String> {
    read_json_object(&root.join("ops/state.json")).map(|state| state.unwrap_or_default())
}

fn write_state_map(root: &Path, state: Map<String, Value>) -> Result<(), String> {
    write_json_file(&root.join("ops/state.json"), &Value::Object(state))
}

fn current_run_id_from_state(state: &Map<String, Value>) -> Option<String> {
    state
        .get("current_run_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn current_run_status_from_state(state: &Map<String, Value>) -> Option<String> {
    state
        .get("current_run_status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn ensure_no_active_run(state: &Map<String, Value>) -> Result<(), String> {
    let status = current_run_status_from_state(state);
    if let Some(run_id) = current_run_id_from_state(state) {
        return Err(format!(
            "Cannot create a new plan while run {run_id} is still active with status {}.",
            status.unwrap_or_else(|| "unknown".into())
        ));
    }

    if matches!(status.as_deref(), Some("planned" | "running")) {
        return Err(format!(
            "Cannot create a new plan while the project still reports an active status of {}.",
            status.unwrap_or_else(|| "unknown".into())
        ));
    }

    Ok(())
}

fn push_doctor_finding(
    findings: &mut Vec<DoctorFinding>,
    id: &str,
    severity: &str,
    title: &str,
    detail: impl Into<String>,
) {
    findings.push(DoctorFinding {
        id: id.into(),
        severity: severity.into(),
        title: title.into(),
        detail: detail.into(),
    });
}

fn checked_run_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn run_doctor_report(root_path: &str) -> Result<DoctorReport, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("Repository path does not exist: {}", root.display()));
    }

    if !root.is_dir() {
        return Err(format!("Repository path is not a directory: {}", root.display()));
    }

    let mut findings = Vec::new();

    let git_available = match Command::new("git").arg("--version").output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    };

    let repo_root = if git_available {
        match run_git_command(&root, &["rev-parse", "--show-toplevel"]) {
            Ok(result) if result.code == Some(0) => {
                let resolved = result.stdout.trim();
                if resolved.is_empty() {
                    push_doctor_finding(
                        &mut findings,
                        "not_git_repo",
                        "error",
                        "Not a Git repository",
                        "Git could not resolve a repository root for this folder.",
                    );
                    None
                } else {
                    Some(resolved.to_string())
                }
            }
            Ok(result) => {
                let detail = result.stderr.trim();
                push_doctor_finding(
                    &mut findings,
                    "not_git_repo",
                    "error",
                    "Not a Git repository",
                    if detail.is_empty() {
                        "Git could not resolve a repository root for this folder.".into()
                    } else {
                        format!("Git reported that this folder is not a repository: {detail}")
                    },
                );
                None
            }
            Err(error) => {
                push_doctor_finding(
                    &mut findings,
                    "not_git_repo",
                    "error",
                    "Not a Git repository",
                    format!("Git could not inspect this folder: {error}"),
                );
                None
            }
        }
    } else {
        push_doctor_finding(
            &mut findings,
            "git_unavailable",
            "error",
            "Git unavailable",
            "The git executable is not available, so repository validation cannot run.",
        );
        None
    };

    let ops_dir = root.join("ops");
    if !ops_dir.is_dir() {
        push_doctor_finding(
            &mut findings,
            "ops_missing",
            "error",
            "ops directory missing",
            format!("Expected HARNESS state directory at {}.", ops_dir.display()),
        );
    }

    let project_path = ops_dir.join("project.json");
    match read_json_object(&project_path) {
        Ok(Some(config)) => {
            match serde_json::from_value::<ProjectConfig>(Value::Object(config)) {
                Ok(_) => {}
                Err(error) => push_doctor_finding(
                    &mut findings,
                    "config_malformed",
                    "error",
                    "Project config malformed",
                    format!("{} could not be decoded: {error}", project_path.display()),
                ),
            }
        }
        Ok(None) => push_doctor_finding(
            &mut findings,
            "config_missing",
            "warning",
            "Project config missing",
            format!("Expected HARNESS config file at {}.", project_path.display()),
        ),
        Err(error) => push_doctor_finding(
            &mut findings,
            "config_malformed",
            "error",
            "Project config malformed",
            error,
        ),
    }

    let state_path = ops_dir.join("state.json");
    let mut project_state: Option<ProjectState> = None;
    match read_json_object(&state_path) {
        Ok(Some(state)) => match serde_json::from_value::<ProjectState>(Value::Object(state)) {
            Ok(parsed_state) => {
                project_state = Some(parsed_state);
            }
            Err(error) => push_doctor_finding(
                &mut findings,
                "state_malformed",
                "error",
                "Project state malformed",
                format!("{} could not be decoded: {error}", state_path.display()),
            ),
        },
        Ok(None) => push_doctor_finding(
            &mut findings,
            "state_missing",
            "warning",
            "Project state missing",
            format!("Expected HARNESS state file at {}.", state_path.display()),
        ),
        Err(error) => push_doctor_finding(
            &mut findings,
            "state_malformed",
            "error",
            "Project state malformed",
            error,
        ),
    }

    if let Some(state) = project_state.as_ref() {
        if let Some(run_id) = checked_run_id(state.current_run_id.as_deref()) {
            let active_run_dir = root.join("ops/runs").join(run_id);
            let active_run_dir_exists = active_run_dir.is_dir();
            if !active_run_dir_exists {
                push_doctor_finding(
                    &mut findings,
                    "active_run_folder_missing",
                    "error",
                    "Active run folder missing",
                    format!(
                        "state.json points to active run {run_id}, but {} does not exist.",
                        active_run_dir.display()
                    ),
                );
            }

            let active_plan_path = active_run_dir.join("plan.md");
            if active_run_dir_exists && !active_plan_path.is_file() {
                push_doctor_finding(
                    &mut findings,
                    "active_plan_file_missing",
                    "error",
                    "Active plan file missing",
                    format!(
                        "state.json points to active run {run_id}, but {} does not exist.",
                        active_plan_path.display()
                    ),
                );
            }
        }

        if let Some(latest_plan_path) = state
            .latest_plan_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            match ensure_path_within_repo(&root, latest_plan_path) {
                Ok(()) => {
                    if !root.join(latest_plan_path).is_file() {
                        push_doctor_finding(
                            &mut findings,
                            "latest_plan_file_missing",
                            "warning",
                            "Latest plan file missing",
                            format!(
                                "state.json points to {}, but that file does not exist.",
                                latest_plan_path
                            ),
                        );
                    }
                }
                Err(error) => push_doctor_finding(
                    &mut findings,
                    "latest_plan_file_missing",
                    "warning",
                    "Latest plan file missing",
                    format!("latest_plan_path is invalid: {error}"),
                ),
            }
        }

        if let Some(last_run_id) = checked_run_id(state.last_run_id.as_deref()) {
            let last_run_dir = root.join("ops/runs").join(last_run_id);
            if !last_run_dir.is_dir() {
                push_doctor_finding(
                    &mut findings,
                    "last_run_folder_missing",
                    "warning",
                    "Last run folder missing",
                    format!(
                        "state.json points to last run {last_run_id}, but {} does not exist.",
                        last_run_dir.display()
                    ),
                );
            }
        }
    }

    Ok(DoctorReport {
        root_path: root_path.into(),
        repo_root,
        findings,
    })
}

fn merge_state_value(root: &Path, updates: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let mut state = read_state_map(root)?;
    updates(&mut state);
    write_state_map(root, state)
}

fn active_plan_from_state(root: &Path, project_state: Option<&ProjectState>) -> Result<Option<PlanArtifact>, String> {
    let Some(state) = project_state else {
        return Ok(None);
    };

    let Some(run_id) = state.current_run_id.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let status = state
        .current_run_status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("draft");
    let relative_path = format!("ops/runs/{run_id}/plan.md");
    let content = read_text_file(&root.join(&relative_path))?.unwrap_or_default();

    Ok(Some(PlanArtifact {
        run_id: run_id.to_string(),
        path: relative_path,
        status: status.to_string(),
        content,
        is_read_only: status != "draft",
    }))
}

fn implementation_provider(project_config: Option<&ProjectConfig>) -> String {
    project_config
        .and_then(|config| config.models.as_ref())
        .and_then(|models| models.implementation.as_ref())
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "codex".into())
}

fn provider_permission_mode(project_config: Option<&ProjectConfig>, provider: &str) -> String {
    let execution = project_config.and_then(|config| config.execution.as_ref());
    let provider_specific = match provider {
        "claude" => execution.and_then(|entry| entry.claude_permission_mode.as_ref()),
        "codex" => execution.and_then(|entry| entry.codex_permission_mode.as_ref()),
        _ => None,
    };

    provider_specific
        .or_else(|| execution.and_then(|entry| entry.permission_mode.as_ref()))
        .map(|value| value.trim().to_lowercase())
        .filter(|value| matches!(value.as_str(), "normal" | "yolo"))
        .unwrap_or_else(|| "normal".into())
}

fn run_record_from_state(
    root: &Path,
    project_config: Option<&ProjectConfig>,
    project_state: Option<&ProjectState>,
) -> Result<Option<RunArtifact>, String> {
    let Some(state) = project_state else {
        return Ok(None);
    };

    let status = state
        .current_run_status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let run_id = state
        .current_run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            state
                .last_run_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            state
                .latest_plan_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        });

    let Some(run_id) = run_id else {
        return Ok(None);
    };

    let Some(status) = status else {
        return Ok(None);
    };

    if !matches!(
        status.as_str(),
        "planned" | "running" | "done" | "failed" | "cancelled" | "reviewed"
    ) {
        return Ok(None);
    }

    let plan_path = format!("ops/runs/{run_id}/plan.md");
    let output_path = format!("ops/runs/{run_id}/output.log");
    let plan_content = read_text_file(&root.join(&plan_path))?.unwrap_or_default();
    let output_content = read_text_file(&root.join(&output_path))?.unwrap_or_default();

    Ok(Some(RunArtifact {
        run_id,
        status,
        provider: implementation_provider(project_config),
        plan_path,
        output_path,
        plan_content,
        output_content,
    }))
}

fn merge_setup_input(
    mut project: Map<String, Value>,
    input: &SetupProjectInput,
) -> Map<String, Value> {
    project.insert("project_name".into(), Value::String(input.project_name.trim().into()));
    project.insert("description".into(), Value::String(input.description.trim().into()));
    project.insert("project_type".into(), Value::String(input.project_type.trim().into()));
    project.insert("phase".into(), Value::String(input.phase.trim().into()));

    let stack_value = input.stack.trim();
    if !stack_value.is_empty() {
        match project.get_mut("stack") {
            Some(Value::Object(existing_stack)) => {
                existing_stack.insert("summary".into(), Value::String(stack_value.into()));
            }
            _ => {
                project.insert("stack".into(), Value::String(stack_value.into()));
            }
        }
    }

    let agents_value = serde_json::to_value(&input.agents).unwrap_or(Value::Array(vec![]));
    project.insert("agents".into(), agents_value);

    project
}

fn chat_thread_relative_path() -> &'static str {
    "ops/chat/thread.json"
}

fn ensure_chat_directory(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("ops/chat"))
        .map_err(|error| format!("Failed to create ops/chat directory: {error}"))
}

fn read_chat_messages(root: &Path) -> Result<Vec<ChatMessage>, String> {
    ensure_chat_directory(root)?;
    let thread_path = root.join(chat_thread_relative_path());
    let Some(content) = read_text_file(&thread_path)? else {
        return Ok(Vec::new());
    };

    serde_json::from_str::<Vec<ChatMessage>>(&content)
        .map_err(|error| format!("Failed to parse {}: {error}", thread_path.display()))
}

fn write_chat_messages(root: &Path, messages: &[ChatMessage]) -> Result<(), String> {
    ensure_chat_directory(root)?;
    let thread_path = root.join(chat_thread_relative_path());
    let content = serde_json::to_string_pretty(messages)
        .map_err(|error| format!("Failed to serialize chat thread: {error}"))?;

    fs::write(&thread_path, content)
        .map_err(|error| format!("Failed to write {}: {error}", thread_path.display()))
}

fn build_chat_prompt(messages: &[ChatMessage], provider: &str, root: &Path) -> String {
    let transcript = messages
        .iter()
        .rev()
        .take(50)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            if message.role == "user" {
                format!("User -> {}: {}", message.provider, message.content)
            } else {
                format!("{}: {}", message.provider, message.content)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    let project_section = read_text_file(&root.join("PROJECT.md"))
        .ok()
        .flatten()
        .map(|content| format!("\n--- PROJECT ---\n{content}\n"))
        .unwrap_or_default();

    let agents_section = read_text_file(&root.join("AGENTS.md"))
        .ok()
        .flatten()
        .map(|content| format!("\n--- AGENT INSTRUCTIONS ---\n{content}\n"))
        .unwrap_or_default();

    format!(
        "You are participating in a shared engineering group chat.\n\
Answer as {provider}.\n\
Keep responses concise and practical.\
{project_section}\
{agents_section}\n\
--- CONVERSATION ---\n\
{transcript}\n\n\
Respond to the latest user message."
    )
}

fn now_timestamp() -> String {
    Local::now().to_rfc3339()
}

fn next_message_id(messages: &[ChatMessage]) -> String {
    format!("m-{}-{}", Local::now().timestamp_millis(), messages.len() + 1)
}

fn build_snapshot(root_path: &str) -> Result<RepoSnapshot, String> {
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;

    let (had_ops_directory, had_runs_directory) = ensure_repo_structure(&root)?;
    let mut warnings = Vec::new();
    let mut files = Vec::new();
    let mut project_config = None;
    let mut project_state = None;

    for relative_path in TRACKED_FILES {
        let full_path = root.join(relative_path);
        match read_text_file(&full_path) {
            Ok(Some(content)) => {
                let mut status = "present";
                if relative_path.ends_with(".json") {
                    match serde_json::from_str::<Value>(&content) {
                        Ok(json_value) => {
                            if relative_path == "ops/project.json" {
                                project_config = serde_json::from_value::<ProjectConfig>(json_value).ok();
                            } else if relative_path == "ops/state.json" {
                                project_state = serde_json::from_value::<ProjectState>(json_value).ok();
                            }
                        }
                        Err(_) => {
                            warnings.push(RepoWarning {
                                kind: "malformed_json".into(),
                                path: relative_path.into(),
                                message: "File exists but could not be parsed as JSON.".into(),
                            });
                            status = "malformed";
                        }
                    }
                };

                files.push(RepoFileRecord {
                    path: relative_path.into(),
                    status: status.into(),
                    content: Some(content),
                    error: None,
                });
            }
            Ok(None) => {
                warnings.push(RepoWarning {
                    kind: "missing_file".into(),
                    path: relative_path.into(),
                    message: "File is missing. It can be created from the Repo Rules panel.".into(),
                });
                files.push(RepoFileRecord {
                    path: relative_path.into(),
                    status: "missing".into(),
                    content: Some(String::new()),
                    error: None,
                });
            }
            Err(error) => {
                warnings.push(RepoWarning {
                    kind: "io_error".into(),
                    path: relative_path.into(),
                    message: error.clone(),
                });
                files.push(RepoFileRecord {
                    path: relative_path.into(),
                    status: "missing".into(),
                    content: Some(String::new()),
                    error: Some(error),
                });
            }
        }
    }

    if !had_ops_directory {
        warnings.push(RepoWarning {
            kind: "missing_directory".into(),
            path: "ops".into(),
            message: "ops directory was missing and has been created.".into(),
        });
    }

    if !had_runs_directory {
        warnings.push(RepoWarning {
            kind: "missing_directory".into(),
            path: "ops/runs".into(),
            message: "ops/runs directory was missing and has been created.".into(),
        });
    }

    let active_plan = active_plan_from_state(&root, project_state.as_ref())?;
    let run_record = run_record_from_state(&root, project_config.as_ref(), project_state.as_ref())?;

    Ok(RepoSnapshot {
        root_path: root_path.into(),
        has_ops_directory: true,
        has_runs_directory: true,
        files,
        warnings,
        project_config,
        project_state,
        active_plan,
        run_record,
    })
}

fn spawn_provider(
    provider: &str,
    root: &Path,
    prompt: &str,
    model: &str,
    effort: &str,
    permission_mode: &str,
) -> Result<Command, String> {
    let yolo_mode = permission_mode == "yolo";
    let mut command = match provider {
        "claude" => {
            let mut command = Command::new("claude");
            command.arg("--print").arg("--verbose").arg("--output-format").arg("stream-json");
            if !model.is_empty() {
                command.arg("--model").arg(model);
            }
            if yolo_mode {
                command.arg("--permission-mode").arg("bypassPermissions");
            }
            command.arg(prompt);
            command
        }
        "codex" => {
            let mut command = Command::new("codex");
            command
                .arg("exec")
                .arg("--cd")
                .arg(root)
                .arg("--skip-git-repo-check");
            if !model.is_empty() {
                command.arg("--model").arg(model);
            }
            if !effort.is_empty() && effort != "medium" {
                command.arg("--effort").arg(effort);
            }
            if yolo_mode {
                command.arg("--dangerously-bypass-approvals-and-sandbox");
            }
            command.arg(prompt);
            command
        }
        unsupported => {
            return Err(format!("Unsupported implementation provider: {unsupported}"));
        }
    };

    command.current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(command)
}

fn emit_run_status(app: &AppHandle, root_path: &str, run_id: &str, status: &str) {
    let event = RunStatusEvent {
        root_path: root_path.into(),
        run_id: run_id.into(),
        status: status.into(),
    };
    let _ = app.emit("run-status", event.clone());
    app.state::<RemoteServer>().broadcast(RemoteEvent::RunStatus(event));
}

fn stream_claude_json(
    app: &AppHandle,
    root_path: &str,
    message_id: &str,
    display_name: &str,
    stdout: impl Read,
) -> String {
    use std::collections::HashMap;
    let reader = BufReader::new(stdout);
    let mut result_text = String::new();
    // pending: tool_id -> (tool_name, input) waiting for their result
    let mut pending: HashMap<String, (String, Value)> = HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                let Some(blocks) = event["message"]["content"].as_array() else {
                    continue;
                };
                for block in blocks {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    emit_chat_stream(app, root_path, message_id, display_name, "stdout", text, false);
                                    result_text.push_str(text);
                                }
                            }
                        }
                        "tool_use" => {
                            let tool_id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let tool_name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = block
                                .get("input")
                                .cloned()
                                .unwrap_or_else(|| Value::Object(Default::default()));
                            pending.insert(tool_id.clone(), (tool_name.clone(), input.clone()));
                            let tool_event = ChatToolEvent {
                                root_path: root_path.into(),
                                message_id: message_id.into(),
                                tool_id,
                                tool_name,
                                input,
                                result: None,
                                is_error: false,
                            };
                            let _ = app.emit("chat-tool", tool_event.clone());
                            app.state::<RemoteServer>().broadcast(RemoteEvent::ChatTool(tool_event));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                let Some(blocks) = event["message"]["content"].as_array() else {
                    continue;
                };
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let tool_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let result_str = match block.get("content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(arr)) => arr
                            .iter()
                            .filter_map(|item| item.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    if let Some((tool_name, input)) = pending.get(&tool_id) {
                        let tool_event = ChatToolEvent {
                            root_path: root_path.into(),
                            message_id: message_id.into(),
                            tool_id,
                            tool_name: tool_name.clone(),
                            input: input.clone(),
                            result: Some(result_str),
                            is_error,
                        };
                        let _ = app.emit("chat-tool", tool_event.clone());
                        app.state::<RemoteServer>().broadcast(RemoteEvent::ChatTool(tool_event));
                    }
                }
            }
            "result" => {
                if let Some(text) = event.get("result").and_then(Value::as_str) {
                    if !text.is_empty() {
                        result_text = text.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    result_text
}

fn emit_chat_stream(
    app: &AppHandle,
    root_path: &str,
    message_id: &str,
    provider: &str,
    stream: &str,
    chunk: &str,
    done: bool,
) {
    let event = ChatStreamEvent {
        root_path: root_path.into(),
        message_id: message_id.into(),
        provider: provider.into(),
        stream: stream.into(),
        chunk: chunk.into(),
        done,
    };
    let _ = app.emit("chat-stream", event.clone());
    app.state::<RemoteServer>().broadcast(RemoteEvent::ChatStream(event));
}

fn emit_chat_thread_updated(app: &AppHandle, root_path: &str) {
    let event = ChatThreadUpdatedEvent {
        root_path: root_path.into(),
    };
    let _ = app.emit("chat-thread-updated", event.clone());
    app.state::<RemoteServer>()
        .broadcast(RemoteEvent::ChatThreadUpdated(event));
}

fn spawn_output_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    root_path: String,
    run_id: String,
    stream: &'static str,
    reader: R,
    output: Arc<Mutex<Vec<String>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };

            let normalized = format!("[{stream}] {line}");
            if let Ok(mut all_output) = output.lock() {
                all_output.push(normalized.clone());
            }

            let event = RunOutputEvent {
                root_path: root_path.clone(),
                run_id: run_id.clone(),
                stream: stream.into(),
                chunk: line,
            };
            let _ = app.emit("run-output", event.clone());
            app.state::<RemoteServer>().broadcast(RemoteEvent::RunOutput(event));
        }
    })
}

fn finalize_run(
    app: AppHandle,
    root_path: String,
    run_id: String,
    cancel_requested: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
    output: Arc<Mutex<Vec<String>>>,
    stdout_handle: thread::JoinHandle<()>,
    stderr_handle: thread::JoinHandle<()>,
) {
    thread::spawn(move || {
        let final_status = loop {
            let try_wait_result = {
                let mut child = match child.lock() {
                    Ok(child) => child,
                    Err(_) => break "failed".to_string(),
                };
                child.try_wait()
            };

            match try_wait_result {
                Ok(Some(status)) => {
                    let cancelled = cancel_requested.load(Ordering::SeqCst);
                    break if cancelled {
                        "cancelled".into()
                    } else if status.success() {
                        "done".into()
                    } else {
                        "failed".into()
                    };
                }
                Ok(None) => {
                    thread::sleep(Duration::from_millis(150));
                }
                Err(_) => break "failed".into(),
            }
        };

        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        let root = PathBuf::from(&root_path);
        let output_path = root.join("ops/runs").join(&run_id).join("output.log");
        let combined_output = output
            .lock()
            .map(|entries| entries.join("\n"))
            .unwrap_or_default();
        let _ = fs::write(&output_path, if combined_output.is_empty() {
            String::new()
        } else {
            format!("{combined_output}\n")
        });

        let _ = merge_state_value(&root, |state| {
            state.insert("last_run_id".into(), Value::String(run_id.clone()));
            state.insert("current_run_id".into(), Value::Null);
            state.insert("current_run_status".into(), Value::String(final_status.clone()));
            state.insert("last_updated".into(), Value::String(today_string()));
        });

        app.state::<RunManager>().remove_run(&root_path, &run_id);
        emit_run_status(&app, &root_path, &run_id, &final_status);
    });
}

#[tauri::command]
fn cancel_chat_message(state: State<ChatProcessState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_repository(root_path: String) -> Result<RepoSnapshot, String> {
    build_snapshot(&root_path)
}

#[tauri::command]
fn run_doctor_checks(root_path: String) -> Result<DoctorReport, String> {
    run_doctor_report(&root_path)
}

#[tauri::command]
fn load_chat_thread(root_path: String) -> Result<ChatThread, String> {
    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let messages = read_chat_messages(&root)?;

    Ok(ChatThread {
        root_path,
        path: chat_thread_relative_path().into(),
        messages,
    })
}

fn send_chat_message_impl(app: AppHandle, input: SendChatMessageInput) -> Result<ChatThread, String> {
    let root = PathBuf::from(&input.root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let provider = input.provider.trim().to_lowercase();
    if !matches!(provider.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported provider: {}", input.provider));
    }

    let content = input.content.trim();
    if content.is_empty() {
        return Err("Message content is required.".into());
    }

    let display_name = input.agent_name
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(&provider)
        .to_string();

    let mut messages = read_chat_messages(&root)?;

    messages.push(ChatMessage {
        id: next_message_id(&messages),
        role: "user".into(),
        provider: display_name.clone(),
        content: content.into(),
        created_at: now_timestamp(),
    });

    let assistant_message_id = next_message_id(&messages);
    let model = input.model.trim();
    let effort = input.effort.trim();
    let permission_mode = input.permission_mode.trim().to_lowercase();
    let permission_mode = if matches!(permission_mode.as_str(), "normal" | "yolo") {
        permission_mode
    } else {
        "normal".to_string()
    };

    let prompt = build_chat_prompt(&messages, &display_name, &root);
    let mut command = spawn_provider(&provider, &root, &prompt, model, effort, &permission_mode)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to run provider {provider}: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture provider stdout.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture provider stderr.".to_string())?;

    // Store child so cancel_chat_message can kill it
    {
        let state = app.state::<ChatProcessState>();
        *state.child.lock().unwrap() = Some(child);
    }

    let root_path_for_stream = input.root_path.clone();
    let display_name_for_stream = display_name.clone();
    let assistant_id_for_stream = assistant_message_id.clone();
    let app_for_stderr = app.clone();

    let stderr_handle = thread::spawn(move || -> String {
        let mut stderr_output = String::new();
        let mut buffer = [0u8; 512];

        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read_count) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read_count]).to_string();
                    stderr_output.push_str(&chunk);
                    emit_chat_stream(
                        &app_for_stderr,
                        &root_path_for_stream,
                        &assistant_id_for_stream,
                        &display_name_for_stream,
                        "stderr",
                        &chunk,
                        false,
                    );
                }
                Err(_) => break,
            }
        }

        stderr_output
    });

    let stdout_output = if provider == "claude" {
        stream_claude_json(&app, &input.root_path, &assistant_message_id, &display_name, stdout)
    } else {
        let mut output = String::new();
        let mut stdout_buffer = [0u8; 512];
        loop {
            match stdout.read(&mut stdout_buffer) {
                Ok(0) => break,
                Ok(read_count) => {
                    let chunk = String::from_utf8_lossy(&stdout_buffer[..read_count]).to_string();
                    output.push_str(&chunk);
                    emit_chat_stream(
                        &app,
                        &input.root_path,
                        &assistant_message_id,
                        &display_name,
                        "stdout",
                        &chunk,
                        false,
                    );
                }
                Err(error) => {
                    return Err(format!("Failed while reading provider output: {error}"));
                }
            }
        }
        output
    };

    let mut taken_child = app.state::<ChatProcessState>().child.lock().unwrap().take();
    let status = match taken_child.as_mut() {
        Some(c) => c.wait().map_err(|error| format!("Failed waiting for provider {provider}: {error}"))?,
        None => return Err("Cancelled.".into()),
    };
    let stderr_output = stderr_handle
        .join()
        .unwrap_or_else(|_| String::new());

    let stdout_trimmed = stdout_output.trim().to_string();
    let stderr_trimmed = stderr_output.trim().to_string();
    let assistant_content = if status.success() {
        if stdout_trimmed.is_empty() {
            "(No output returned.)".to_string()
        } else {
            stdout_trimmed
        }
    } else if !stderr_trimmed.is_empty() {
        format!("Provider error: {stderr_trimmed}")
    } else if !stdout_trimmed.is_empty() {
        stdout_trimmed
    } else {
        "Provider failed without output.".to_string()
    };

    messages.push(ChatMessage {
        id: assistant_message_id.clone(),
        role: "assistant".into(),
        provider: display_name.clone(),
        content: assistant_content,
        created_at: now_timestamp(),
    });

    write_chat_messages(&root, &messages)?;
    emit_chat_thread_updated(&app, &input.root_path);

    Ok(ChatThread {
        root_path: input.root_path,
        path: chat_thread_relative_path().into(),
        messages,
    })
}

#[tauri::command]
async fn send_chat_message(app: AppHandle, input: SendChatMessageInput) -> Result<ChatThread, String> {
    let app_for_worker = app.clone();
    let root_path = input.root_path.clone();
    let display_name = input.agent_name
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(input.provider.trim())
        .to_string();
    let result = tauri::async_runtime::spawn_blocking(move || send_chat_message_impl(app_for_worker, input))
        .await
        .map_err(|error| format!("Failed to join chat worker: {error}"))?;

    if let Ok(thread) = &result {
        if let Some(last_assistant_message) = thread.messages.iter().rev().find(|message| message.role == "assistant")
        {
            emit_chat_stream(
                &app,
                &root_path,
                &last_assistant_message.id,
                &last_assistant_message.provider,
                "stdout",
                "",
                true,
            );
        }
    } else {
        emit_chat_stream(&app, &root_path, "", &display_name, "stderr", "", true);
    }

    result
}

#[tauri::command]
fn list_changed_files(root_path: String) -> Result<ChangedFilesSnapshot, String> {
    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;

    let repo_root = resolve_git_repo_root(&root)?;
    let files = parse_changed_files(&repo_root)?;

    Ok(ChangedFilesSnapshot {
        repo_root: repo_root.display().to_string(),
        files,
    })
}

#[tauri::command]
fn load_changed_file_diff(
    root_path: String,
    path: String,
    change_type: String,
) -> Result<ChangedFileDiff, String> {
    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;

    let repo_root = resolve_git_repo_root(&root)?;
    let file = find_changed_file(&repo_root, &path, Some(&change_type))?;

    let diff = match file.change_type.as_str() {
        "added" | "untracked" => diff_untracked_or_added_file(&repo_root, &file.path)?,
        "modified" | "deleted" | "renamed" => diff_tracked_file(&repo_root, &file.path)?,
        other => {
            return Err(format!("Unsupported change type for diffing: {other}"));
        }
    };

    Ok(ChangedFileDiff {
        repo_root: repo_root.display().to_string(),
        path: file.path,
        previous_path: file.previous_path,
        change_type: file.change_type,
        diff,
    })
}

#[tauri::command]
fn apply_review_decision(input: ReviewDecisionInput) -> Result<(), String> {
    let root = PathBuf::from(&input.root_path);
    validate_repo_root(&root)?;

    let repo_root = resolve_git_repo_root(&root)?;
    let file = find_changed_file(&repo_root, &input.path, Some(&input.change_type))?;

    if let Some(previous_path) = input.previous_path.as_deref() {
        if file.previous_path.as_deref() != Some(previous_path) {
            return Err(format!(
                "Previous path does not match current git status for {}.",
                input.path
            ));
        }
    }

    match input.decision.as_str() {
        "accept" => run_git_command_checked(
            &repo_root,
            &["add", "--", &file.path],
            &format!("Staging {}", file.path),
        ),
        "reject" => reject_changed_file(&repo_root, &file),
        other => Err(format!("Unsupported review decision: {other}")),
    }
}

#[tauri::command]
fn clear_accepted_review_decision(input: ClearAcceptedDecisionInput) -> Result<(), String> {
    let root = PathBuf::from(&input.root_path);
    validate_repo_root(&root)?;

    let repo_root = resolve_git_repo_root(&root)?;
    validate_relative_repo_path(&input.path)?;
    ensure_path_within_repo(&repo_root, &input.path)?;
    if let Some(previous_path) = input.previous_path.as_deref() {
        ensure_path_within_repo(&repo_root, previous_path)?;
    }

    let mut args = vec!["restore", "--staged", "--"];
    if let Some(previous_path) = input.previous_path.as_deref() {
        args.push(previous_path);
    }
    args.push(&input.path);

    run_git_command_allow_missing_path(
        &repo_root,
        &args,
        &format!("Unstaging {}", input.path),
    )
}

#[tauri::command]
fn commit_accepted_changes(root_path: String, message: String) -> Result<RepoSnapshot, String> {
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Commit message is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let repo_root = resolve_git_repo_root(&root)?;
    let staged = staged_files(&repo_root)?;
    if staged.is_empty() {
        return Err("There are no staged accepted files to commit.".into());
    }

    let result = Command::new("git")
        .args(["commit", "-m", trimmed_message])
        .current_dir(&repo_root)
        .output()
        .map_err(|error| format!("Failed to run git commit: {error}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let stdout = String::from_utf8_lossy(&result.stdout);
        let detail = stderr.trim();
        let fallback = stdout.trim();
        return Err(if !detail.is_empty() {
            format!("git commit failed: {detail}")
        } else if !fallback.is_empty() {
            format!("git commit failed: {fallback}")
        } else {
            "git commit failed.".into()
        });
    }

    merge_state_value(&root, |state| {
        state.insert("current_run_status".into(), Value::String("reviewed".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;

    build_snapshot(&root_path)
}

#[tauri::command]
fn write_repository_file(root_path: String, file_path: String, content: String) -> Result<RepoSnapshot, String> {
    validate_tracked_path(&file_path)?;

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;

    ensure_repo_structure(&root)?;

    let target = root.join(&file_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create parent directories for {file_path}: {error}"))?;
    }

    if file_path.ends_with(".json") {
        serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Refusing to save malformed JSON to {file_path}: {error}"))?;
    }

    fs::write(&target, content).map_err(|error| format!("Failed to write {file_path}: {error}"))?;
    build_snapshot(&root_path)
}

#[tauri::command]
fn create_plan_run(root_path: String) -> Result<RepoSnapshot, String> {
    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    ensure_no_active_run(&state)?;

    let run_id = generate_run_id();
    let run_dir = root.join("ops/runs").join(&run_id);
    if run_dir.exists() {
        return Err(format!("Run folder already exists: {}", run_dir.display()));
    }

    fs::create_dir(&run_dir)
        .map_err(|error| format!("Failed to create run folder {}: {error}", run_dir.display()))?;

    let plan_path = run_dir.join("plan.md");
    fs::write(&plan_path, "").map_err(|error| format!("Failed to create {}: {error}", plan_path.display()))?;

    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(run_id.clone()));
        state.insert("current_run_status".into(), Value::String("draft".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;

    build_snapshot(&root_path)
}

#[tauri::command]
fn save_plan(root_path: String, run_id: String, content: String) -> Result<RepoSnapshot, String> {
    let trimmed_run_id = run_id.trim();
    if trimmed_run_id.is_empty() {
        return Err("runId is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    let current_run_id = current_run_id_from_state(&state);
    let current_status = current_run_status_from_state(&state);

    if current_run_id.as_deref() != Some(trimmed_run_id) {
        return Err(format!("Run {trimmed_run_id} is not the active planning run."));
    }

    if current_status.as_deref() != Some("draft") {
        return Err("Only draft plans can be edited.".into());
    }

    let plan_path = root.join("ops/runs").join(trimmed_run_id).join("plan.md");
    if !plan_path.exists() {
        return Err(format!("Plan file does not exist: {}", plan_path.display()));
    }

    fs::write(&plan_path, content)
        .map_err(|error| format!("Failed to save {}: {error}", plan_path.display()))?;

    merge_state_value(&root, |state| {
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;

    build_snapshot(&root_path)
}

#[tauri::command]
fn approve_plan(root_path: String, run_id: String) -> Result<RepoSnapshot, String> {
    let trimmed_run_id = run_id.trim();
    if trimmed_run_id.is_empty() {
        return Err("runId is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    let current_run_id = current_run_id_from_state(&state);
    let current_status = current_run_status_from_state(&state);

    if current_run_id.as_deref() != Some(trimmed_run_id) {
        return Err(format!("Run {trimmed_run_id} is not the active planning run."));
    }

    if current_status.as_deref() != Some("draft") {
        return Err("Only draft plans can be approved.".into());
    }

    let relative_plan_path = format!("ops/runs/{trimmed_run_id}/plan.md");
    let plan_path = root.join(&relative_plan_path);
    let content = read_text_file(&plan_path)?.unwrap_or_default();
    if content.trim().is_empty() {
        return Err("Plan must be saved with non-empty content before approval.".into());
    }

    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(trimmed_run_id.into()));
        state.insert("current_run_status".into(), Value::String("planned".into()));
        state.insert("latest_plan_id".into(), Value::String(trimmed_run_id.into()));
        state.insert("latest_plan_path".into(), Value::String(relative_plan_path));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;

    build_snapshot(&root_path)
}

#[tauri::command]
fn reject_plan(root_path: String, run_id: String) -> Result<RepoSnapshot, String> {
    let trimmed_run_id = run_id.trim();
    if trimmed_run_id.is_empty() {
        return Err("runId is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    let current_run_id = current_run_id_from_state(&state);

    if current_run_id.as_deref() != Some(trimmed_run_id) {
        return Err(format!("Run {trimmed_run_id} is not the active planning run."));
    }

    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::Null);
        state.insert("current_run_status".into(), Value::String("rejected".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;

    build_snapshot(&root_path)
}

#[tauri::command]
fn start_run(
    app: AppHandle,
    manager: State<'_, RunManager>,
    root_path: String,
    run_id: String,
) -> Result<RepoSnapshot, String> {
    let trimmed_run_id = run_id.trim();
    if trimmed_run_id.is_empty() {
        return Err("runId is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    let current_run_id = current_run_id_from_state(&state);
    let current_status = current_run_status_from_state(&state);

    if current_run_id.as_deref() != Some(trimmed_run_id) {
        return Err(format!("Run {trimmed_run_id} is not the active approved run."));
    }

    if current_status.as_deref() != Some("planned") {
        return Err("Only approved plans with status planned can start.".into());
    }

    let relative_plan_path = format!("ops/runs/{trimmed_run_id}/plan.md");
    let plan_path = root.join(&relative_plan_path);
    let plan_content = read_text_file(&plan_path)?.unwrap_or_default();
    if plan_content.trim().is_empty() {
        return Err("Approved plan is empty and cannot be dispatched.".into());
    }

    let project_config = read_json_object(&root.join("ops/project.json"))?
        .map(|value| serde_json::from_value::<ProjectConfig>(Value::Object(value)).unwrap_or_default())
        .unwrap_or_default();
    let provider = implementation_provider(Some(&project_config));
    let prompt = format!(
        "Implement the approved HARNESS plan for run {trimmed_run_id} in repository {}.\nRead and follow the plan at {relative_plan_path}.\nStay within that scope.\n\n{plan_content}",
        root.display()
    );

    manager.ensure_slot_available(&root_path)?;

    let permission_mode = provider_permission_mode(Some(&project_config), &provider);
    let mut command = spawn_provider(&provider, &root, &prompt, "", "medium", &permission_mode)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn provider {provider}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture child stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture child stderr.".to_string())?;

    let cancel_requested = Arc::new(AtomicBool::new(false));
    let child = match manager.start_run(&root_path, trimmed_run_id, child, Arc::clone(&cancel_requested)) {
        Ok(child) => child,
        Err(error) => {
            return Err(error);
        }
    };
    let output = Arc::new(Mutex::new(Vec::new()));
    let stdout_handle = spawn_output_reader(
        app.clone(),
        root_path.clone(),
        trimmed_run_id.into(),
        "stdout",
        stdout,
        Arc::clone(&output),
    );
    let stderr_handle = spawn_output_reader(
        app.clone(),
        root_path.clone(),
        trimmed_run_id.into(),
        "stderr",
        stderr,
        Arc::clone(&output),
    );

    if let Err(error) = merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(trimmed_run_id.into()));
        state.insert("current_run_status".into(), Value::String("running".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    }) {
        if let Ok(mut active_child) = child.lock() {
            let _ = active_child.kill();
        }
        manager.remove_run(&root_path, trimmed_run_id);
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        return Err(error);
    }
    emit_run_status(&app, &root_path, trimmed_run_id, "running");

    finalize_run(
        app,
        root_path.clone(),
        trimmed_run_id.into(),
        cancel_requested,
        child,
        output,
        stdout_handle,
        stderr_handle,
    );

    build_snapshot(&root_path)
}

#[tauri::command]
fn cancel_run(
    manager: State<'_, RunManager>,
    root_path: String,
    run_id: String,
) -> Result<RepoSnapshot, String> {
    let trimmed_run_id = run_id.trim();
    if trimmed_run_id.is_empty() {
        return Err("runId is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let state = read_state_map(&root)?;
    let current_run_id = current_run_id_from_state(&state);
    let current_status = current_run_status_from_state(&state);

    if current_run_id.as_deref() != Some(trimmed_run_id) || current_status.as_deref() != Some("running") {
        return Err(format!("Run {trimmed_run_id} is not currently running."));
    }

    manager.cancel_run(&root_path, trimmed_run_id)?;
    build_snapshot(&root_path)
}

#[tauri::command]
fn setup_project(root_path: String, input: SetupProjectInput) -> Result<RepoSnapshot, String> {
    let project_name = input.project_name.trim();
    if project_name.is_empty() {
        return Err("Project Name is required.".into());
    }

    let phase = input.phase.trim();
    if phase.is_empty() {
        return Err("Phase is required.".into());
    }

    if input.agents.is_empty() {
        return Err("At least one agent is required.".into());
    }

    let last_updated = input.last_updated.trim();
    if last_updated.is_empty() {
        return Err("lastUpdated is required.".into());
    }

    let root = PathBuf::from(&root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;

    let project_path = root.join("ops/project.json");
    let state_path = root.join("ops/state.json");
    let is_first_time_setup = !state_path.exists();

    let existing_project = read_json_object(&project_path)?.unwrap_or_default();
    let merged_project = merge_setup_input(existing_project, &input);
    write_json_file(&project_path, &Value::Object(merged_project))?;

    if is_first_time_setup {
        let mut state = Map::new();
        state.insert("latest_plan_path".into(), Value::Null);
        state.insert("latest_plan_id".into(), Value::Null);
        state.insert("last_run_id".into(), Value::Null);
        state.insert("current_run_id".into(), Value::Null);
        state.insert("current_run_status".into(), Value::Null);
        state.insert("current_phase".into(), Value::String(phase.into()));
        state.insert("last_completed_task".into(), Value::Null);
        state.insert("last_updated".into(), Value::String(last_updated.into()));
        write_json_file(&state_path, &Value::Object(state))?;
    }

    build_snapshot(&root_path)
}

struct ChatProcessState {
    child: Mutex<Option<Child>>,
}

// ---------------------------------------------------------------------------
// Axum HTTP / WebSocket server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
}

fn check_api_key(headers: &HeaderMap, app: &AppHandle) -> bool {
    let server = app.state::<RemoteServer>();
    let stored = server.api_key.lock().unwrap();
    let Some(ref key) = *stored else { return false };
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == key.as_str())
        .unwrap_or(false)
}

macro_rules! require_key {
    ($headers:expr, $state:expr) => {
        if !check_api_key(&$headers, &$state.app) {
            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
        }
    };
}

// --- Request bodies ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPathBody {
    root_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileBody {
    root_path: String,
    file_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunIdBody {
    root_path: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePlanBody {
    root_path: String,
    run_id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffBody {
    root_path: String,
    path: String,
    change_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitBody {
    root_path: String,
    message: String,
}

// --- Handlers ---

async fn handle_open_repository(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RootPathBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match build_snapshot(&body.root_path) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_setup_project(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let root_path = match body.get("rootPath").and_then(Value::as_str) {
        Some(v) => v.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "rootPath required"}))).into_response(),
    };
    let input: SetupProjectInput = match serde_json::from_value(body.get("input").cloned().unwrap_or_else(|| body.clone())) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    match setup_project_impl(&root_path, input) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_write_repository_file(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<WriteFileBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match write_repository_file_impl(&body.root_path, &body.file_path, body.content) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_create_plan_run(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RootPathBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match create_plan_run_impl(&body.root_path) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_save_plan(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<SavePlanBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match save_plan_impl(&body.root_path, &body.run_id, body.content) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_approve_plan(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RunIdBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match approve_plan_impl(&body.root_path, &body.run_id) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_reject_plan(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RunIdBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match reject_plan_impl(&body.root_path, &body.run_id) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_start_run(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RunIdBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let app = s.app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<RunManager>();
        start_run_impl(&app, &manager, &body.root_path, &body.run_id)
    }).await;
    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn handle_cancel_run(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RunIdBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let app = s.app.clone();
    let manager = app.state::<RunManager>();
    match cancel_run_impl(&manager, &body.root_path, &body.run_id) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_list_changed_files(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RootPathBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let root = PathBuf::from(&body.root_path);
    let result = (|| -> Result<ChangedFilesSnapshot, String> {
        validate_repo_root(&root)?;
        let repo_root = resolve_git_repo_root(&root)?;
        let files = parse_changed_files(&repo_root)?;
        Ok(ChangedFilesSnapshot { repo_root: repo_root.display().to_string(), files })
    })();
    match result {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_load_changed_file_diff(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<DiffBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let root = PathBuf::from(&body.root_path);
    let result = (|| -> Result<ChangedFileDiff, String> {
        validate_repo_root(&root)?;
        let repo_root = resolve_git_repo_root(&root)?;
        let file = find_changed_file(&repo_root, &body.path, Some(&body.change_type))?;
        let diff = match file.change_type.as_str() {
            "added" | "untracked" => diff_untracked_or_added_file(&repo_root, &file.path)?,
            _ => diff_tracked_file(&repo_root, &file.path)?,
        };
        Ok(ChangedFileDiff { repo_root: repo_root.display().to_string(), path: file.path, previous_path: file.previous_path, change_type: file.change_type, diff })
    })();
    match result {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_apply_review_decision(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let input: ReviewDecisionInput = match serde_json::from_value(body.get("input").cloned().unwrap_or(body)) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    let root = PathBuf::from(&input.root_path);
    let result = (|| -> Result<(), String> {
        validate_repo_root(&root)?;
        let repo_root = resolve_git_repo_root(&root)?;
        let file = find_changed_file(&repo_root, &input.path, Some(&input.change_type))?;
        if let Some(pp) = input.previous_path.as_deref() {
            if file.previous_path.as_deref() != Some(pp) {
                return Err(format!("Previous path mismatch for {}.", input.path));
            }
        }
        match input.decision.as_str() {
            "accept" => run_git_command_checked(&repo_root, &["add", "--", &file.path], &format!("Staging {}", file.path)),
            "reject" => reject_changed_file(&repo_root, &file),
            other => Err(format!("Unsupported review decision: {other}")),
        }
    })();
    match result {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!(null))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_clear_accepted_review_decision(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let input: ClearAcceptedDecisionInput = match serde_json::from_value(body.get("input").cloned().unwrap_or(body)) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    let root = PathBuf::from(&input.root_path);
    let result = (|| -> Result<(), String> {
        validate_repo_root(&root)?;
        let repo_root = resolve_git_repo_root(&root)?;
        validate_relative_repo_path(&input.path)?;
        ensure_path_within_repo(&repo_root, &input.path)?;
        let mut args = vec!["restore", "--staged", "--"];
        if let Some(pp) = input.previous_path.as_deref() { args.push(pp); }
        args.push(&input.path);
        run_git_command_allow_missing_path(&repo_root, &args, &format!("Unstaging {}", input.path))
    })();
    match result {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!(null))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_commit_accepted_changes(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<CommitBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match commit_accepted_changes_impl(&body.root_path, &body.message) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_run_doctor_checks(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RootPathBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    match run_doctor_report(&body.root_path) {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_load_chat_thread(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<RootPathBody>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let root = PathBuf::from(&body.root_path);
    let result = (|| -> Result<ChatThread, String> {
        validate_repo_root(&root)?;
        ensure_repo_structure(&root)?;
        let messages = read_chat_messages(&root)?;
        Ok(ChatThread { root_path: body.root_path, path: chat_thread_relative_path().into(), messages })
    })();
    match result {
        Ok(v) => (StatusCode::OK, Json(serde_json::to_value(v).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

async fn handle_send_chat_message(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    require_key!(headers, s);
    let input: SendChatMessageInput = match serde_json::from_value(body.get("input").cloned().unwrap_or(body)) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    let app = s.app.clone();
    let app2 = app.clone();
    let root_path = input.root_path.clone();
    let display_name = input.agent_name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(input.provider.trim()).to_string();
    let result = tauri::async_runtime::spawn_blocking(move || send_chat_message_impl(app, input)).await;
    match result {
        Ok(Ok(ref thread)) => {
            if let Some(last) = thread.messages.iter().rev().find(|m| m.role == "assistant") {
                emit_chat_stream(&app2, &root_path, &last.id, &last.provider, "stdout", "", true);
            }
            (StatusCode::OK, Json(serde_json::to_value(thread).unwrap())).into_response()
        }
        Ok(Err(ref e)) => {
            emit_chat_stream(&app2, &root_path, "", &display_name, "stderr", "", true);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
        Err(ref e) => {
            emit_chat_stream(&app2, &root_path, "", &display_name, "stderr", "", true);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn handle_cancel_chat_message(
    AxumState(s): AxumState<HttpState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    require_key!(headers, s);
    let state = s.app.state::<ChatProcessState>();
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    (StatusCode::OK, Json(serde_json::json!(null))).into_response()
}

#[derive(Deserialize)]
struct WsQuery { key: Option<String> }

async fn handle_ws(
    AxumState(s): AxumState<HttpState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let server = s.app.state::<RemoteServer>();
    let stored = server.api_key.lock().unwrap().clone();
    let authed = stored.as_deref()
        .zip(query.key.as_deref())
        .map(|(stored, provided)| stored == provided)
        .unwrap_or(false);

    if !authed {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    let rx = server.event_tx.subscribe();
    ws.on_upgrade(move |socket| ws_handler(socket, rx))
}

async fn ws_handler(mut socket: WebSocket, mut rx: broadcast::Receiver<RemoteEvent>) {
    loop {
        match rx.recv().await {
            Ok(event) => {
                if let Ok(text) = serde_json::to_string(&event) {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn build_router(app: AppHandle) -> Router {
    let state = HttpState { app };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/open_repository", post(handle_open_repository))
        .route("/api/setup_project", post(handle_setup_project))
        .route("/api/write_repository_file", post(handle_write_repository_file))
        .route("/api/create_plan_run", post(handle_create_plan_run))
        .route("/api/save_plan", post(handle_save_plan))
        .route("/api/approve_plan", post(handle_approve_plan))
        .route("/api/reject_plan", post(handle_reject_plan))
        .route("/api/start_run", post(handle_start_run))
        .route("/api/cancel_run", post(handle_cancel_run))
        .route("/api/list_changed_files", post(handle_list_changed_files))
        .route("/api/load_changed_file_diff", post(handle_load_changed_file_diff))
        .route("/api/apply_review_decision", post(handle_apply_review_decision))
        .route("/api/clear_accepted_review_decision", post(handle_clear_accepted_review_decision))
        .route("/api/commit_accepted_changes", post(handle_commit_accepted_changes))
        .route("/api/run_doctor_checks", post(handle_run_doctor_checks))
        .route("/api/load_chat_thread", post(handle_load_chat_thread))
        .route("/api/send_chat_message", post(handle_send_chat_message))
        .route("/api/cancel_chat_message", post(handle_cancel_chat_message))
        .route("/ws", get(handle_ws))
        .layer(cors)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tauri commands for server management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    enabled: bool,
    api_key: Option<String>,
    port: u16,
}

fn make_server_status(server: &RemoteServer) -> ServerStatus {
    let enabled = server.is_enabled();
    let api_key = server.api_key.lock().unwrap().clone();
    ServerStatus { enabled, api_key, port: 7700 }
}

#[tauri::command]
fn get_server_status(app: AppHandle) -> ServerStatus {
    make_server_status(&app.state::<RemoteServer>())
}

#[tauri::command]
fn start_remote_server(app: AppHandle) -> Result<ServerStatus, String> {
    let server = app.state::<RemoteServer>();

    {
        let mut enabled = server.enabled.lock().unwrap();
        if *enabled {
            return Ok(make_server_status(&server));
        }
        *enabled = true;
    }

    // Generate API key if not yet set
    {
        let mut key = server.api_key.lock().unwrap();
        if key.is_none() {
            *key = Some(RemoteServer::generate_key());
        }
    }

    // Preflight bind to catch immediate port/permission issues before reporting success.
    let preflight = StdTcpListener::bind("0.0.0.0:7700")
        .map_err(|error| {
            *server.enabled.lock().unwrap() = false;
            format!("Failed to bind host server on port 7700: {error}")
        })?;
    drop(preflight);

    let router = build_router(app.clone());
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("0.0.0.0:7700").await {
            Ok(listener) => listener,
            Err(error) => {
                *app_for_task.state::<RemoteServer>().enabled.lock().unwrap() = false;
                eprintln!("Failed to bind host server on port 7700: {error}");
                return;
            }
        };

        if let Err(error) = axum::serve(listener, router).await {
            *app_for_task.state::<RemoteServer>().enabled.lock().unwrap() = false;
            eprintln!("Host server terminated: {error}");
        }
    });

    Ok(make_server_status(&server))
}

#[tauri::command]
fn stop_remote_server(app: AppHandle) -> ServerStatus {
    let server = app.state::<RemoteServer>();
    *server.enabled.lock().unwrap() = false;
    // Note: we mark disabled but the tokio task keeps the port bound until restart.
    // New WS connections will be rejected by the enabled check; existing ones drain naturally.
    make_server_status(&server)
}

#[tauri::command]
fn regenerate_api_key(app: AppHandle) -> ServerStatus {
    let server = app.state::<RemoteServer>();
    *server.api_key.lock().unwrap() = Some(RemoteServer::generate_key());
    make_server_status(&server)
}

// ---------------------------------------------------------------------------
// Extracted impl functions (shared by Tauri commands and HTTP handlers)
// ---------------------------------------------------------------------------

fn write_repository_file_impl(root_path: &str, file_path: &str, content: String) -> Result<RepoSnapshot, String> {
    validate_tracked_path(file_path)?;
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let target = root.join(file_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories for {file_path}: {e}"))?;
    }
    if file_path.ends_with(".json") {
        serde_json::from_str::<Value>(&content)
            .map_err(|e| format!("Refusing to save malformed JSON to {file_path}: {e}"))?;
    }
    fs::write(&target, content).map_err(|e| format!("Failed to write {file_path}: {e}"))?;
    build_snapshot(root_path)
}

fn create_plan_run_impl(root_path: &str) -> Result<RepoSnapshot, String> {
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    ensure_no_active_run(&state)?;
    let run_id = generate_run_id();
    let run_dir = root.join("ops/runs").join(&run_id);
    if run_dir.exists() {
        return Err(format!("Run folder already exists: {}", run_dir.display()));
    }
    fs::create_dir(&run_dir)
        .map_err(|e| format!("Failed to create run folder {}: {e}", run_dir.display()))?;
    let plan_path = run_dir.join("plan.md");
    fs::write(&plan_path, "").map_err(|e| format!("Failed to create {}: {e}", plan_path.display()))?;
    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(run_id.clone()));
        state.insert("current_run_status".into(), Value::String("draft".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;
    build_snapshot(root_path)
}

fn save_plan_impl(root_path: &str, run_id: &str, content: String) -> Result<RepoSnapshot, String> {
    let trimmed = run_id.trim();
    if trimmed.is_empty() { return Err("runId is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    if current_run_id_from_state(&state).as_deref() != Some(trimmed) {
        return Err(format!("Run {trimmed} is not the active planning run."));
    }
    if current_run_status_from_state(&state).as_deref() != Some("draft") {
        return Err("Only draft plans can be edited.".into());
    }
    let plan_path = root.join("ops/runs").join(trimmed).join("plan.md");
    if !plan_path.exists() { return Err(format!("Plan file does not exist: {}", plan_path.display())); }
    fs::write(&plan_path, content).map_err(|e| format!("Failed to save {}: {e}", plan_path.display()))?;
    merge_state_value(&root, |state| { state.insert("last_updated".into(), Value::String(today_string())); })?;
    build_snapshot(root_path)
}

fn approve_plan_impl(root_path: &str, run_id: &str) -> Result<RepoSnapshot, String> {
    let trimmed = run_id.trim();
    if trimmed.is_empty() { return Err("runId is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    if current_run_id_from_state(&state).as_deref() != Some(trimmed) {
        return Err(format!("Run {trimmed} is not the active planning run."));
    }
    if current_run_status_from_state(&state).as_deref() != Some("draft") {
        return Err("Only draft plans can be approved.".into());
    }
    let relative_plan_path = format!("ops/runs/{trimmed}/plan.md");
    let content = read_text_file(&root.join(&relative_plan_path))?.unwrap_or_default();
    if content.trim().is_empty() { return Err("Plan must be saved with non-empty content before approval.".into()); }
    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(trimmed.into()));
        state.insert("current_run_status".into(), Value::String("planned".into()));
        state.insert("latest_plan_id".into(), Value::String(trimmed.into()));
        state.insert("latest_plan_path".into(), Value::String(relative_plan_path));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;
    build_snapshot(root_path)
}

fn reject_plan_impl(root_path: &str, run_id: &str) -> Result<RepoSnapshot, String> {
    let trimmed = run_id.trim();
    if trimmed.is_empty() { return Err("runId is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    if current_run_id_from_state(&state).as_deref() != Some(trimmed) {
        return Err(format!("Run {trimmed} is not the active planning run."));
    }
    merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::Null);
        state.insert("current_run_status".into(), Value::String("rejected".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;
    build_snapshot(root_path)
}

fn start_run_impl(app: &AppHandle, manager: &RunManager, root_path: &str, run_id: &str) -> Result<RepoSnapshot, String> {
    let trimmed = run_id.trim();
    if trimmed.is_empty() { return Err("runId is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    if current_run_id_from_state(&state).as_deref() != Some(trimmed) {
        return Err(format!("Run {trimmed} is not the active approved run."));
    }
    if current_run_status_from_state(&state).as_deref() != Some("planned") {
        return Err("Only approved plans with status planned can start.".into());
    }
    let relative_plan_path = format!("ops/runs/{trimmed}/plan.md");
    let plan_content = read_text_file(&root.join(&relative_plan_path))?.unwrap_or_default();
    if plan_content.trim().is_empty() { return Err("Approved plan is empty and cannot be dispatched.".into()); }
    let project_config = read_json_object(&root.join("ops/project.json"))?
        .map(|v| serde_json::from_value::<ProjectConfig>(Value::Object(v)).unwrap_or_default())
        .unwrap_or_default();
    let provider = implementation_provider(Some(&project_config));
    let prompt = format!(
        "Implement the approved HARNESS plan for run {trimmed} in repository {}.\nRead and follow the plan at {relative_plan_path}.\nStay within that scope.\n\n{plan_content}",
        root.display()
    );
    manager.ensure_slot_available(root_path)?;
    let permission_mode = provider_permission_mode(Some(&project_config), &provider);
    let mut command = spawn_provider(&provider, &root, &prompt, "", "medium", &permission_mode)?;
    let mut child = command.spawn().map_err(|e| format!("Failed to spawn provider {provider}: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "Failed to capture child stdout.".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Failed to capture child stderr.".to_string())?;
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let child = manager.start_run(root_path, trimmed, child, Arc::clone(&cancel_requested))?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let stdout_handle = spawn_output_reader(app.clone(), root_path.into(), trimmed.into(), "stdout", stdout, Arc::clone(&output));
    let stderr_handle = spawn_output_reader(app.clone(), root_path.into(), trimmed.into(), "stderr", stderr, Arc::clone(&output));
    if let Err(error) = merge_state_value(&root, |state| {
        state.insert("current_run_id".into(), Value::String(trimmed.into()));
        state.insert("current_run_status".into(), Value::String("running".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    }) {
        if let Ok(mut active_child) = child.lock() { let _ = active_child.kill(); }
        manager.remove_run(root_path, trimmed);
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        return Err(error);
    }
    emit_run_status(app, root_path, trimmed, "running");
    finalize_run(app.clone(), root_path.into(), trimmed.into(), cancel_requested, child, output, stdout_handle, stderr_handle);
    build_snapshot(root_path)
}

fn cancel_run_impl(manager: &RunManager, root_path: &str, run_id: &str) -> Result<RepoSnapshot, String> {
    let trimmed = run_id.trim();
    if trimmed.is_empty() { return Err("runId is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let state = read_state_map(&root)?;
    if current_run_id_from_state(&state).as_deref() != Some(trimmed) || current_run_status_from_state(&state).as_deref() != Some("running") {
        return Err(format!("Run {trimmed} is not currently running."));
    }
    manager.cancel_run(root_path, trimmed)?;
    build_snapshot(root_path)
}

fn commit_accepted_changes_impl(root_path: &str, message: &str) -> Result<RepoSnapshot, String> {
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() { return Err("Commit message is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let repo_root = resolve_git_repo_root(&root)?;
    let staged = staged_files(&repo_root)?;
    if staged.is_empty() { return Err("There are no staged accepted files to commit.".into()); }
    let result = Command::new("git")
        .args(["commit", "-m", trimmed_message])
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let stdout = String::from_utf8_lossy(&result.stdout);
        let detail = stderr.trim();
        let fallback = stdout.trim();
        return Err(if !detail.is_empty() {
            format!("git commit failed: {detail}")
        } else if !fallback.is_empty() {
            format!("git commit failed: {fallback}")
        } else {
            "git commit failed.".into()
        });
    }
    merge_state_value(&root, |state| {
        state.insert("current_run_status".into(), Value::String("reviewed".into()));
        state.insert("last_updated".into(), Value::String(today_string()));
    })?;
    build_snapshot(root_path)
}

fn setup_project_impl(root_path: &str, input: SetupProjectInput) -> Result<RepoSnapshot, String> {
    let project_name = input.project_name.trim();
    if project_name.is_empty() { return Err("Project Name is required.".into()); }
    let phase = input.phase.trim();
    if phase.is_empty() { return Err("Phase is required.".into()); }
    if input.agents.is_empty() { return Err("At least one agent is required.".into()); }
    let last_updated = input.last_updated.trim();
    if last_updated.is_empty() { return Err("lastUpdated is required.".into()); }
    let root = PathBuf::from(root_path);
    validate_repo_root(&root)?;
    ensure_repo_structure(&root)?;
    let project_path = root.join("ops/project.json");
    let state_path = root.join("ops/state.json");
    let is_first_time_setup = !state_path.exists();
    let existing_project = read_json_object(&project_path)?.unwrap_or_default();
    let merged_project = merge_setup_input(existing_project, &input);
    write_json_file(&project_path, &Value::Object(merged_project))?;
    if is_first_time_setup {
        let mut state = Map::new();
        state.insert("latest_plan_path".into(), Value::Null);
        state.insert("latest_plan_id".into(), Value::Null);
        state.insert("last_run_id".into(), Value::Null);
        state.insert("current_run_id".into(), Value::Null);
        state.insert("current_run_status".into(), Value::Null);
        state.insert("current_phase".into(), Value::String(phase.into()));
        state.insert("last_completed_task".into(), Value::Null);
        state.insert("last_updated".into(), Value::String(last_updated.into()));
        write_json_file(&state_path, &Value::Object(state))?;
    }
    build_snapshot(root_path)
}

pub fn run() {
    tauri::Builder::default()
        .manage(RunManager {
            runs: Mutex::new(Vec::new()),
        })
        .manage(ChatProcessState {
            child: Mutex::new(None),
        })
        .manage(RemoteServer::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repository,
            run_doctor_checks,
            load_chat_thread,
            send_chat_message,
            cancel_chat_message,
            list_changed_files,
            load_changed_file_diff,
            apply_review_decision,
            clear_accepted_review_decision,
            commit_accepted_changes,
            write_repository_file,
            create_plan_run,
            save_plan,
            approve_plan,
            reject_plan,
            start_run,
            cancel_run,
            setup_project,
            get_server_status,
            start_remote_server,
            stop_remote_server,
            regenerate_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
