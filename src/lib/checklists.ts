import type { FileStatus } from "../types/harness";

export interface ParsedChecklistItem {
  index: number;
  label: string;
}

export interface ParsedChecklist {
  index: number;
  heading: string;
  items: ParsedChecklistItem[];
}

export interface ParsedChecklistDocument {
  kind: "parsed";
  checklists: ParsedChecklist[];
}

export interface RawChecklistDocument {
  kind: "raw";
  reason: "missing" | "empty" | "parse-error";
  message: string;
  rawContent: string;
}

export type ChecklistDocument = ParsedChecklistDocument | RawChecklistDocument;

function normalizeHeading(line: string): string | null {
  const match = line.match(/^##\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function parseCheckboxLine(line: string): string | null {
  const match = line.match(/^\s*-\s+\[(?: |x|X)\]\s+(.+?)\s*$/);
  return match ? match[1].trim() : null;
}

export function parseChecklistsDocument(
  content: string | null | undefined,
  fileStatus?: FileStatus,
): ChecklistDocument {
  if (fileStatus === "missing") {
    return {
      kind: "raw",
      reason: "missing",
      message: "CHECKLISTS.md is missing. No checklists are available yet.",
      rawContent: "",
    };
  }

  const rawContent = content ?? "";
  if (!rawContent.trim()) {
    return {
      kind: "raw",
      reason: "empty",
      message: "CHECKLISTS.md is empty. Add checklist sections to populate this view.",
      rawContent,
    };
  }

  try {
    const lines = rawContent.split(/\r?\n/);
    const checklists: ParsedChecklist[] = [];
    let currentHeading: string | null = null;
    let currentItems: ParsedChecklistItem[] = [];

    function flushChecklist() {
      if (!currentHeading || currentItems.length === 0) {
        currentHeading = null;
        currentItems = [];
        return;
      }

      checklists.push({
        index: checklists.length,
        heading: currentHeading,
        items: currentItems,
      });
      currentHeading = null;
      currentItems = [];
    }

    for (const line of lines) {
      const heading = normalizeHeading(line);
      if (heading) {
        flushChecklist();
        currentHeading = heading;
        continue;
      }

      if (!currentHeading) {
        continue;
      }

      const label = parseCheckboxLine(line);
      if (!label) {
        continue;
      }

      currentItems.push({
        index: currentItems.length,
        label,
      });
    }

    flushChecklist();

    if (checklists.length === 0) {
      return {
        kind: "raw",
        reason: "parse-error",
        message: "CHECKLISTS.md could not be parsed into checklist sections. Showing raw content instead.",
        rawContent,
      };
    }

    return {
      kind: "parsed",
      checklists,
    };
  } catch {
    return {
      kind: "raw",
      reason: "parse-error",
      message: "CHECKLISTS.md could not be parsed into checklist sections. Showing raw content instead.",
      rawContent,
    };
  }
}
