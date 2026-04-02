import { useEffect, useState, type FormEvent } from "react";
import type { SetupFormValues } from "../types/harness";

interface SetupFormProps {
  initialValues: SetupFormValues;
  isSaving: boolean;
  onSubmit: (values: SetupFormValues) => Promise<void>;
}

export function SetupForm({ initialValues, isSaving, onSubmit }: SetupFormProps) {
  const [values, setValues] = useState<SetupFormValues>(initialValues);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues]);

  function updateValue<Key extends keyof SetupFormValues>(key: Key, value: SetupFormValues[Key]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!values.projectName.trim()) {
      setFormError("Project Name is required.");
      return;
    }

    if (!values.phase.trim()) {
      setFormError("Phase is required.");
      return;
    }

    setFormError(null);
    await onSubmit({
      ...values,
      projectName: values.projectName.trim(),
      description: values.description.trim(),
      projectType: values.projectType.trim(),
      phase: values.phase.trim(),
      stack: values.stack.trim(),
    });
  }

  return (
    <form className="setup-form" onSubmit={(event) => void handleSubmit(event)}>
      <label className="field">
        <span>Project Name</span>
        <input
          value={values.projectName}
          onChange={(event) => updateValue("projectName", event.target.value)}
          placeholder="HARNESS"
          required
        />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          value={values.description}
          onChange={(event) => updateValue("description", event.target.value)}
          rows={4}
          placeholder="Short project summary"
        />
      </label>

      <div className="field-grid">
        <label className="field">
          <span>Project Type</span>
          <input
            value={values.projectType}
            onChange={(event) => updateValue("projectType", event.target.value)}
            placeholder="desktop-app"
          />
        </label>

        <label className="field">
          <span>Phase</span>
          <input
            value={values.phase}
            onChange={(event) => updateValue("phase", event.target.value)}
            placeholder="setup"
            required
          />
        </label>
      </div>

      <label className="field">
        <span>Stack</span>
        <input
          value={values.stack}
          onChange={(event) => updateValue("stack", event.target.value)}
          placeholder="Tauri + React + Vite + TypeScript"
        />
      </label>

      <div className="field-grid">
        <label className="field">
          <span>Planning Model</span>
          <select
            value={values.planningModel}
            onChange={(event) => updateValue("planningModel", event.target.value as SetupFormValues["planningModel"])}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </label>

        <label className="field">
          <span>Implementation Model</span>
          <select
            value={values.implementationModel}
            onChange={(event) =>
              updateValue("implementationModel", event.target.value as SetupFormValues["implementationModel"])
            }
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </label>
      </div>

      {formError ? <p className="error-copy">{formError}</p> : null}

      <div className="form-actions">
        <p className="muted">
          This form only edits the practical setup fields. Existing nested config remains intact.
        </p>
        <button className="primary-button" type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Setup"}
        </button>
      </div>
    </form>
  );
}
