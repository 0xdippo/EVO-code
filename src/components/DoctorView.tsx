import type { DoctorReport, RepoSnapshot } from "../types/harness";

interface DoctorViewProps {
  snapshot: RepoSnapshot;
  report: DoctorReport | null;
  isRunning: boolean;
  lastCheckedAt: string | null;
  onRunChecks: () => Promise<void>;
}

export function DoctorView({
  snapshot,
  report,
  isRunning,
  lastCheckedAt,
  onRunChecks,
}: DoctorViewProps) {
  const findings = report?.findings ?? [];

  return (
    <section className="panel doctor-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Phase 9</p>
          <h2>Doctor</h2>
          <p className="muted">
            Read-only validation for common HARNESS broken-state conditions.
          </p>
        </div>
        <button className="primary-button" onClick={() => void onRunChecks()} disabled={isRunning}>
          {isRunning ? "Running Checks..." : "Run Checks"}
        </button>
      </div>

      <div className="doctor-context-grid">
        <div className="doctor-context-card">
          <h3>Loaded Root</h3>
          <p className="path-chip">{snapshot.rootPath}</p>
        </div>
        <div className="doctor-context-card">
          <h3>Detected Repo Root</h3>
          <p className="path-chip">{report?.repoRoot ?? "Not available"}</p>
        </div>
        <div className="doctor-context-card">
          <h3>Last Checked</h3>
          <p className="path-chip">{lastCheckedAt ?? "Not checked in this session"}</p>
        </div>
      </div>

      {!report ? (
        <div className="empty-state compact-empty-state">
          <h3>No checks run yet</h3>
          <p>Run checks to inspect repo structure and current HARNESS state files.</p>
        </div>
      ) : findings.length === 0 ? (
        <section className="status-panel ok">
          <h3>All checks passed</h3>
          <p>No failing Doctor checks were found for the current repository snapshot.</p>
        </section>
      ) : (
        <section className="doctor-findings">
          {findings.map((finding) => (
            <article
              key={finding.id}
              className={`doctor-finding doctor-finding-${finding.severity}`}
            >
              <div className="doctor-finding-header">
                <strong>{finding.title}</strong>
                <span className="doctor-severity">{finding.severity}</span>
              </div>
              <p className="muted">{finding.detail}</p>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
