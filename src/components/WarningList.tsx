import type { RepoWarning } from "../types/harness";

interface WarningListProps {
  warnings: RepoWarning[];
}

export function WarningList({ warnings }: WarningListProps) {
  if (warnings.length === 0) {
    return (
      <section className="status-panel ok">
        <h2>Repository status</h2>
        <p>Tracked HARNESS files are readable and the repo bootstrap structure is present.</p>
      </section>
    );
  }

  return (
    <section className="status-panel warning">
      <h2>Warnings</h2>
      <ul className="warning-list">
        {warnings.map((warning) => (
          <li key={`${warning.kind}-${warning.path}`}>
            <strong>{warning.path}</strong>
            <span>{warning.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
