import type { ParsedChecklist } from "../lib/checklists";

interface ChecklistPanelProps {
  checklist: ParsedChecklist;
  checkedItems: Set<number>;
  isPassed: boolean;
  onToggleItem: (checklistIndex: number, itemIndex: number) => void;
  onMarkPassed: (checklistIndex: number) => void;
  onReset: (checklistIndex: number) => void;
}

export function ChecklistPanel({
  checklist,
  checkedItems,
  isPassed,
  onToggleItem,
  onMarkPassed,
  onReset,
}: ChecklistPanelProps) {
  const completedCount = checklist.items.filter((item) => checkedItems.has(item.index)).length;
  const totalCount = checklist.items.length;
  const isReadyToPass = completedCount === totalCount;

  return (
    <section className={isPassed ? "checklist-panel passed" : "checklist-panel"}>
      <div className="checklist-panel-header">
        <div>
          <h3>{checklist.heading}</h3>
          <p className="muted">
            {completedCount} / {totalCount} complete
          </p>
        </div>
        <div className="checklist-summary">
          <span className={isPassed ? "checklist-status passed" : "checklist-status"}>
            {isPassed ? "Passed" : "Incomplete"}
          </span>
          <div className="checklist-progress" aria-hidden="true">
            <div
              className="checklist-progress-fill"
              style={{ width: `${(completedCount / totalCount) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="checklist-items" role="list">
        {checklist.items.map((item) => {
          const checked = checkedItems.has(item.index);

          return (
            <label className="checklist-item" key={item.index}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleItem(checklist.index, item.index)}
              />
              <span>{item.label}</span>
            </label>
          );
        })}
      </div>

      <div className="checklist-actions">
        <button
          className="secondary-button"
          onClick={() => onMarkPassed(checklist.index)}
          disabled={!isReadyToPass || isPassed}
        >
          Mark as Passed
        </button>
        {isPassed ? (
          <button className="secondary-button" onClick={() => onReset(checklist.index)}>
            Reset
          </button>
        ) : null}
      </div>
    </section>
  );
}
