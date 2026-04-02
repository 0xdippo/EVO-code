import { getFileRecord } from "./repo";
import type { ProjectConfig, RepoSnapshot, SetupFormValues } from "../types/harness";

function readStackValue(stack: ProjectConfig["stack"]): string {
  if (typeof stack === "string") {
    return stack;
  }

  if (!stack) {
    return "";
  }

  return Object.values(stack).filter(Boolean).join(" | ");
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
  return Boolean(projectName && phase);
}

export function getSetupFormDefaults(config: ProjectConfig | null): SetupFormValues {
  return {
    projectName: config?.project_name ?? "",
    description: config?.description ?? "",
    projectType: config?.project_type ?? "",
    phase: config?.phase ?? "",
    stack: readStackValue(config?.stack),
    planningModel: config?.models?.planning ?? "claude",
    implementationModel: config?.models?.implementation ?? "codex",
  };
}

export function getCurrentPhase(snapshot: RepoSnapshot): string {
  return snapshot.projectState?.current_phase?.trim()
    || snapshot.projectConfig?.phase?.trim()
    || "Unknown";
}
