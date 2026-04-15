import type { RepoWarning } from "../types/harness";

interface WarningListProps {
  warnings: RepoWarning[];
}

export function WarningList({ warnings }: WarningListProps) {
  if (warnings.length === 0) {
    return (
      <section className="warning-summary ok">
        <strong>Repository status is healthy.</strong>
      </section>
    );
  }

  return (
    <details className="warning-summary warning">
      <summary>{warnings.length} warning{warnings.length === 1 ? "" : "s"} (expand)</summary>
      <ul className="warning-list">
        {warnings.map((warning) => (
          <li key={`${warning.kind}-${warning.path}`}>
            <strong>{warning.path}</strong>
            <span>{warning.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
