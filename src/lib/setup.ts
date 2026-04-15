import { getFileRecord } from "./repo";
import type { AgentConfig, PermissionMode, ProjectConfig, RepoSnapshot, SetupFormValues } from "../types/harness";

function readStackValue(stack: ProjectConfig["stack"]): string {
  if (typeof stack === "string") {
    return stack;
  }

  if (!stack) {
    return "";
  }

  return Object.values(stack).filter(Boolean).join(" | ");
}

export function agentDisplayName(agent: AgentConfig): string {
  if (agent.name?.trim()) return agent.name.trim();
  const effort = agent.effort.charAt(0).toUpperCase() + agent.effort.slice(1);
  return `${agent.model} · ${effort}`;
}

export function isProjectInitialized(snapshot: RepoSnapshot | null): boolean {
  if (!snapshot?.projectConfig) {
    return false;
  }

  const projectFile = getFileRecord(snapshot, "ops/project.json");
  if (projectFile?.status !== "present") {
    return false;
  }

  const projectName = snapshot.projectConfig.project_name?.trim();
  const phase = snapshot.projectConfig.phase?.trim();
  const hasAgents = (snapshot.projectConfig.agents?.length ?? 0) > 0;
  return Boolean(projectName && phase && hasAgents);
}

export function getSetupFormDefaults(config: ProjectConfig | null): SetupFormValues {
  let agents: AgentConfig[] = config?.agents ?? [];

  // Migrate from old execution config if no agents defined yet
  if (agents.length === 0 && config) {
    const claudeMode = (
      config.execution?.claude_permission_mode
      ?? config.execution?.permission_mode
      ?? "normal"
    ) as PermissionMode;
    const codexMode = (
      config.execution?.codex_permission_mode
      ?? config.execution?.permission_mode
      ?? "normal"
    ) as PermissionMode;

    if (config.execution?.claude_enabled !== false) {
      agents.push({
        id: "claude-migrated",
        provider: "claude",
        model: "claude-opus-4-6",
        effort: "medium",
        permissionMode: claudeMode,
      });
    }
    if (config.execution?.codex_enabled !== false) {
      agents.push({
        id: "codex-migrated",
        provider: "codex",
        model: "gpt-5.3-codex",
        effort: "medium",
        permissionMode: codexMode,
      });
    }
  }

  return {
    projectName: config?.project_name ?? "",
    description: config?.description ?? "",
    projectType: config?.project_type ?? "desktop-app",
    phase: config?.phase ?? "v1",
    stack: readStackValue(config?.stack),
    agents,
  };
}

export function getCurrentPhase(snapshot: RepoSnapshot): string {
  return snapshot.projectState?.current_phase?.trim()
    || snapshot.projectConfig?.phase?.trim()
    || "Unknown";
}
