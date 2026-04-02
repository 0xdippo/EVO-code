use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
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

#[derive(Default, Deserialize, Serialize)]
struct ProjectConfig {
    project_name: Option<String>,
    description: Option<String>,
    project_type: Option<String>,
    phase: Option<String>,
    stack: Option<Value>,
    models: Option<ProjectModels>,
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
    planning_model: ProviderModel,
    implementation_model: ProviderModel,
    last_updated: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProviderModel {
    Claude,
    Codex,
}

impl ProviderModel {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
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

    let models_entry = project
        .entry("models".into())
        .or_insert_with(|| Value::Object(Map::new()));

    if !models_entry.is_object() {
        *models_entry = Value::Object(Map::new());
    }

    if let Value::Object(models) = models_entry {
        models.insert(
            "planning".into(),
            Value::String(input.planning_model.as_str().into()),
        );
        models.insert(
            "implementation".into(),
            Value::String(input.implementation_model.as_str().into()),
        );
    }

    project
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
) -> Result<Command, String> {
    let mut command = match provider {
        "claude" => {
            let mut command = Command::new("claude");
            command
                .arg("--print")
                .arg("--permission-mode")
                .arg("bypassPermissions")
                .arg(prompt);
            command
        }
        "codex" => {
            let mut command = Command::new("codex");
            command
                .arg("exec")
                .arg("--cd")
                .arg(root)
                .arg("--skip-git-repo-check")
                .arg("--dangerously-bypass-approvals-and-sandbox")
                .arg(prompt);
            command
        }
        unsupported => {
            return Err(format!("Unsupported implementation provider: {unsupported}"));
        }
    };

    // TODO: keep evolving exact CLI flags here as provider CLIs stabilize; callers should stay unchanged.
    command.current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(command)
}

fn emit_run_status(app: &AppHandle, root_path: &str, run_id: &str, status: &str) {
    let _ = app.emit(
        "run-status",
        RunStatusEvent {
            root_path: root_path.into(),
            run_id: run_id.into(),
            status: status.into(),
        },
    );
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

            let _ = app.emit(
                "run-output",
                RunOutputEvent {
                    root_path: root_path.clone(),
                    run_id: run_id.clone(),
                    stream: stream.into(),
                    chunk: line,
                },
            );
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
fn open_repository(root_path: String) -> Result<RepoSnapshot, String> {
    build_snapshot(&root_path)
}

#[tauri::command]
fn run_doctor_checks(root_path: String) -> Result<DoctorReport, String> {
    run_doctor_report(&root_path)
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

    let mut command = spawn_provider(&provider, &root, &prompt)?;
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

pub fn run() {
    tauri::Builder::default()
        .manage(RunManager {
            runs: Mutex::new(Vec::new()),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repository,
            run_doctor_checks,
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
            setup_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
