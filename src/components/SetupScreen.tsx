import { SetupForm } from "./SetupForm";
import type { SetupFormValues } from "../types/harness";

interface SetupScreenProps {
  initialValues: SetupFormValues;
  isSaving: boolean;
  onSubmit: (values: SetupFormValues) => Promise<void>;
}

export function SetupScreen({
  initialValues,
  isSaving,
  onSubmit,
}: SetupScreenProps) {
  return (
    <section className="setup-layout">
      <article className="panel panel-span-full">
        <p className="eyebrow">Setup</p>
        <h2>Project Configuration</h2>
        <p className="muted">
          Configure defaults for the selected repository.
        </p>
        <SetupForm initialValues={initialValues} isSaving={isSaving} onSubmit={onSubmit} />
      </article>
    </section>
  );
}
