import { SetupForm } from "./SetupForm";
import type { RepoSnapshot, SetupFormValues } from "../types/harness";

interface SetupScreenProps {
  snapshot: RepoSnapshot;
  initialValues: SetupFormValues;
  isSaving: boolean;
  onSubmit: (values: SetupFormValues) => Promise<void>;
}

export function SetupScreen({
  snapshot,
  initialValues,
  isSaving,
  onSubmit,
}: SetupScreenProps) {
  return (
    <section className="setup-layout">
      <article className="panel">
        <p className="eyebrow">Phase 2</p>
        <h2>Project setup</h2>
        <p className="muted">
          This repository is missing a complete HARNESS project setup. Finish the required fields
          below to write `ops/project.json` and initialize repo-local state.
        </p>
        <SetupForm initialValues={initialValues} isSaving={isSaving} onSubmit={onSubmit} />
      </article>

      <article className="panel">
        <p className="eyebrow">Repository</p>
        <h2>Bootstrap status</h2>
        <dl className="key-value-list">
          <div>
            <dt>Repository root</dt>
            <dd>{snapshot.rootPath}</dd>
          </div>
          <div>
            <dt>`ops/` directory</dt>
            <dd>{snapshot.hasOpsDirectory ? "Present" : "Missing"}</dd>
          </div>
          <div>
            <dt>`ops/runs/` directory</dt>
            <dd>{snapshot.hasRunsDirectory ? "Present" : "Missing"}</dd>
          </div>
          <div>
            <dt>`ops/project.json`</dt>
            <dd>{snapshot.files.find((file) => file.path === "ops/project.json")?.status ?? "missing"}</dd>
          </div>
          <div>
            <dt>`ops/state.json`</dt>
            <dd>{snapshot.files.find((file) => file.path === "ops/state.json")?.status ?? "missing"}</dd>
          </div>
        </dl>
      </article>
    </section>
  );
}
