import { useEffect, useMemo, useState } from "react";
import { parseChecklistsDocument } from "../lib/checklists";
import type { RepoSnapshot } from "../types/harness";
import { ChecklistPanel } from "./ChecklistPanel";

interface ChecklistState {
  checkedItemsByChecklist: Record<number, number[]>;
  passedChecklistIndexes: number[];
}

interface ChecklistViewProps {
  snapshot: RepoSnapshot;
}

export function ChecklistView({ snapshot }: ChecklistViewProps) {
  const checklistFile = snapshot.files.find((file) => file.path === "CHECKLISTS.md") ?? null;
  const checklistContent = checklistFile?.content ?? "";
  const checklistDocument = useMemo(
    () => parseChecklistsDocument(checklistContent, checklistFile?.status),
    [checklistContent, checklistFile?.status],
  );
  const [checklistState, setChecklistState] = useState<ChecklistState>({
    checkedItemsByChecklist: {},
    passedChecklistIndexes: [],
  });

  useEffect(() => {
    setChecklistState({
      checkedItemsByChecklist: {},
      passedChecklistIndexes: [],
    });
  }, [checklistContent, checklistFile?.status]);

  function handleToggleItem(checklistIndex: number, itemIndex: number) {
    setChecklistState((currentState) => {
      const previousCheckedItems = currentState.checkedItemsByChecklist[checklistIndex] ?? [];
      const nextCheckedItems = previousCheckedItems.includes(itemIndex)
        ? previousCheckedItems.filter((index) => index !== itemIndex)
        : [...previousCheckedItems, itemIndex].sort((left, right) => left - right);

      return {
        checkedItemsByChecklist: {
          ...currentState.checkedItemsByChecklist,
          [checklistIndex]: nextCheckedItems,
        },
        passedChecklistIndexes: currentState.passedChecklistIndexes.filter(
          (index) => index !== checklistIndex,
        ),
      };
    });
  }

  function handleMarkPassed(checklistIndex: number) {
    setChecklistState((currentState) => {
      const checklist = checklistDocument.kind === "parsed"
        ? checklistDocument.checklists.find((entry) => entry.index === checklistIndex)
        : null;
      const checkedItems = currentState.checkedItemsByChecklist[checklistIndex] ?? [];

      if (!checklist || checkedItems.length !== checklist.items.length) {
        return currentState;
      }

      if (currentState.passedChecklistIndexes.includes(checklistIndex)) {
        return currentState;
      }

      return {
        ...currentState,
        passedChecklistIndexes: [...currentState.passedChecklistIndexes, checklistIndex],
      };
    });
  }

  function handleReset(checklistIndex: number) {
    setChecklistState((currentState) => ({
      checkedItemsByChecklist: {
        ...currentState.checkedItemsByChecklist,
        [checklistIndex]: [],
      },
      passedChecklistIndexes: currentState.passedChecklistIndexes.filter(
        (index) => index !== checklistIndex,
      ),
    }));
  }

  return (
    <section className="panel-grid">
      <article className="panel panel-span-full">
        <p className="eyebrow">Checklists</p>
        <div className="panel-header">
          <div>
            <h2>Phase Gate Checklists</h2>
            <p className="muted">
              Session-only checklist state from `CHECKLISTS.md`. Nothing here writes back to disk.
            </p>
          </div>
        </div>

        {checklistDocument.kind === "parsed" ? (
          <div className="checklist-board">
            {checklistDocument.checklists.map((checklist) => (
              <ChecklistPanel
                key={checklist.index}
                checklist={checklist}
                checkedItems={new Set(checklistState.checkedItemsByChecklist[checklist.index] ?? [])}
                isPassed={checklistState.passedChecklistIndexes.includes(checklist.index)}
                onToggleItem={handleToggleItem}
                onMarkPassed={handleMarkPassed}
                onReset={handleReset}
              />
            ))}
          </div>
        ) : checklistDocument.reason === "parse-error" ? (
          <div className="task-fallback">
            <section className="status-panel warning">{checklistDocument.message}</section>
            <pre className="tasks-viewer">
              {checklistDocument.rawContent || "CHECKLISTS.md is present but could not be rendered."}
            </pre>
          </div>
        ) : (
          <div className="empty-state compact-empty-state">
            <h3>No checklists yet</h3>
            <p>{checklistDocument.message}</p>
          </div>
        )}
      </article>
    </section>
  );
}
