import type { FileStatus } from "../types/harness";

export interface ParsedTask {
  id: string;
  title: string;
  owner: string;
  status: string;
  lineIndex: number;
}

export interface TaskPhase {
  heading: string;
  tasks: ParsedTask[];
}

export interface TaskStatusDefinition {
  value: string;
  description: string;
}

export interface ParsedTaskDocument {
  kind: "parsed";
  phases: TaskPhase[];
  statusOptions: string[];
  statusDefinitions: TaskStatusDefinition[];
}

export interface RawTaskDocument {
  kind: "raw";
  reason: "missing" | "empty" | "parse-error";
  message: string;
  rawContent: string;
}

export type TaskDocument = ParsedTaskDocument | RawTaskDocument;

function detectLineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function stripMarkdownCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^`(.+)`$/);
  return match ? match[1].trim() : trimmed;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isDividerRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function normalizeHeading(line: string): string | null {
  const match = line.match(/^##\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function isTaskTableHeader(cells: string[]): boolean {
  if (cells.length < 4) {
    return false;
  }

  return cells.map((cell) => cell.toLowerCase()).join("|") === "id|owner|status|title";
}

function readStatusDefinitions(lines: string[]): TaskStatusDefinition[] {
  const definitions: TaskStatusDefinition[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = normalizeHeading(lines[index]);
    if (heading !== "Legend") {
      continue;
    }

    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const nextHeading = normalizeHeading(lines[lineIndex]);
      if (nextHeading) {
        break;
      }

      const headerCells = splitTableRow(lines[lineIndex]);
      const dividerCells = splitTableRow(lines[lineIndex + 1] ?? "");
      if (!headerCells || !dividerCells || !isDividerRow(dividerCells)) {
        continue;
      }

      const firstHeader = headerCells[0]?.toLowerCase();
      if (firstHeader !== "status") {
        continue;
      }

      for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex += 1) {
        const rowCells = splitTableRow(lines[rowIndex]);
        if (!rowCells || rowCells.length < 2) {
          break;
        }

        const value = stripMarkdownCode(rowCells[0]);
        const description = rowCells.slice(1).join("|").trim();
        if (value && !definitions.some((definition) => definition.value === value)) {
          definitions.push({
            value,
            description,
          });
        }
      }
    }
  }

  return definitions;
}

function upsertStatusDefinition(
  definitions: TaskStatusDefinition[],
  value: string,
  description = "",
) {
  if (definitions.some((definition) => definition.value === value)) {
    return;
  }

  definitions.push({ value, description });
}

function isCompletedStatusDefinition(definition: TaskStatusDefinition): boolean {
  const normalizedValue = definition.value.trim().toLowerCase();
  const normalizedDescription = definition.description.trim().toLowerCase();

  if (/\b(done|complete|completed|closed|accepted)\b/.test(normalizedDescription)) {
    return true;
  }

  return /\b(done|complete|completed)\b/.test(normalizedValue);
}

export function isCompletedTaskStatus(
  status: string,
  definitions: TaskStatusDefinition[],
): boolean {
  const normalizedStatus = status.trim().toLowerCase();
  if (!normalizedStatus) {
    return false;
  }

  const matchingDefinition = definitions.find(
    (definition) => definition.value.trim().toLowerCase() === normalizedStatus,
  );

  if (matchingDefinition) {
    return isCompletedStatusDefinition(matchingDefinition);
  }

  return isCompletedStatusDefinition({ value: status, description: "" });
}

export function parseTasksDocument(content: string | null | undefined, fileStatus?: FileStatus): TaskDocument {
  if (fileStatus === "missing") {
    return {
      kind: "raw",
      reason: "missing",
      message: "TASKS.md is missing. No task board is available yet.",
      rawContent: "",
    };
  }

  const rawContent = content ?? "";
  if (!rawContent.trim()) {
    return {
      kind: "raw",
      reason: "empty",
      message: "TASKS.md is empty. Add a phase table to populate the task board.",
      rawContent,
    };
  }

  try {
    const lines = rawContent.split(/\r?\n/);
    const phases: TaskPhase[] = [];
    const statusDefinitions = readStatusDefinitions(lines);
    const statusOptions = statusDefinitions.map((definition) => definition.value);

    let currentHeading: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const heading = normalizeHeading(lines[index]);
      if (heading) {
        currentHeading = heading;
        continue;
      }

      const headerCells = splitTableRow(lines[index]);
      const dividerCells = splitTableRow(lines[index + 1] ?? "");
      if (!currentHeading || !headerCells || !dividerCells) {
        continue;
      }

      if (!isTaskTableHeader(headerCells) || !isDividerRow(dividerCells)) {
        continue;
      }

      const tasks: ParsedTask[] = [];

      for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
        const rowCells = splitTableRow(lines[rowIndex]);
        if (!rowCells || rowCells.length < 4) {
          break;
        }

        const [idCell, ownerCell, statusCell, ...titleCells] = rowCells;
        const id = stripMarkdownCode(idCell);
        const owner = stripMarkdownCode(ownerCell);
        const status = stripMarkdownCode(statusCell);
        const title = titleCells.join("|").trim();

        if (!id || !owner || !status || !title) {
          continue;
        }

        if (!statusOptions.includes(status)) {
          statusOptions.push(status);
          upsertStatusDefinition(statusDefinitions, status);
        }

        tasks.push({
          id,
          owner,
          status,
          title,
          lineIndex: rowIndex,
        });
      }

      if (tasks.length > 0) {
        phases.push({
          heading: currentHeading,
          tasks,
        });
      }

      currentHeading = null;
    }

    if (phases.length === 0) {
      return {
        kind: "raw",
        reason: "parse-error",
        message: "TASKS.md could not be parsed into phase tables. Showing raw content instead.",
        rawContent,
      };
    }

    return {
      kind: "parsed",
      phases,
      statusOptions,
      statusDefinitions,
    };
  } catch {
    return {
      kind: "raw",
      reason: "parse-error",
      message: "TASKS.md could not be parsed into phase tables. Showing raw content instead.",
      rawContent,
    };
  }
}

function getCellRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pipes: number[] = [];

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|") {
      pipes.push(index);
    }
  }

  for (let index = 0; index < pipes.length - 1; index += 1) {
    ranges.push({
      start: pipes[index] + 1,
      end: pipes[index + 1],
    });
  }

  return ranges;
}

function formatStatusCell(previousCell: string, nextStatus: string): string {
  const leadingWhitespace = previousCell.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = previousCell.match(/\s*$/)?.[0] ?? "";
  const trimmed = previousCell.trim();
  const formattedStatus = /^`.*`$/.test(trimmed) ? `\`${nextStatus}\`` : nextStatus;
  return `${leadingWhitespace}${formattedStatus}${trailingWhitespace}`;
}

export function updateTaskStatusInMarkdown(
  content: string,
  taskId: string,
  nextStatus: string,
): string {
  const parsed = parseTasksDocument(content);
  if (parsed.kind !== "parsed") {
    throw new Error("TASKS.md is not in a writable task-board format.");
  }

  const matchingTask = parsed.phases
    .flatMap((phase) => phase.tasks)
    .find((task) => task.id === taskId);

  if (!matchingTask) {
    throw new Error(`Task ${taskId} was not found in TASKS.md.`);
  }

  const lines = content.split(/\r?\n/);
  const lineEnding = detectLineEnding(content);
  const line = lines[matchingTask.lineIndex];
  if (!line) {
    throw new Error(`Task ${taskId} row could not be located for update.`);
  }

  const cellRanges = getCellRanges(line);
  const statusRange = cellRanges[2];
  if (!statusRange) {
    throw new Error(`Task ${taskId} row does not have a writable status column.`);
  }

  const previousCell = line.slice(statusRange.start, statusRange.end);
  const updatedCell = formatStatusCell(previousCell, nextStatus);
  lines[matchingTask.lineIndex] =
    `${line.slice(0, statusRange.start)}${updatedCell}${line.slice(statusRange.end)}`;

  return lines.join(lineEnding);
}
