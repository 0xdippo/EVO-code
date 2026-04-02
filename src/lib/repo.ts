import type { RepoFileRecord, RepoSnapshot, TrackedFilePath } from "../types/harness";

export function getFileRecord(
  snapshot: RepoSnapshot | null,
  path: TrackedFilePath,
): RepoFileRecord | null {
  return snapshot?.files.find((file) => file.path === path) ?? null;
}

export function formatFileLabel(path: string): string {
  return path.startsWith("ops/") ? path.replace("ops/", "ops / ") : path;
}

export function isEditable(file: RepoFileRecord | null): boolean {
  return Boolean(file);
}
