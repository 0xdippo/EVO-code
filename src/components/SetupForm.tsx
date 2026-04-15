import { useEffect, useState, type FormEvent } from "react";
import { agentDisplayName } from "../lib/setup";
import type { AgentConfig, AgentEffort, PermissionMode, ProviderModel, SetupFormValues } from "../types/harness";

interface SetupFormProps {
  initialValues: SetupFormValues;
  isSaving: boolean;
  onSubmit: (values: SetupFormValues) => Promise<void>;
}

interface AgentDraft {
  name: string;
  model: string;
  effort: AgentEffort;
  extendedThinking: boolean;
  permissionMode: PermissionMode;
}

const PROVIDER_MODELS: Record<ProviderModel, string[]> = {
  claude: ["claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  codex: ["gpt-5.3-codex", "gpt-5.4"],
};

function blankDraft(provider: ProviderModel): AgentDraft {
  return {
    name: "",
    model: PROVIDER_MODELS[provider][0] ?? "",
    effort: "medium",
    extendedThinking: false,
    permissionMode: "normal",
  };
}

interface RosterSectionProps {
  provider: ProviderModel;
  label: string;
  agents: AgentConfig[];
  onRemove: (id: string) => void;
  onAdd: (agent: AgentConfig) => void;
}

function RosterSection({ provider, label, agents, onRemove, onAdd }: RosterSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(blankDraft(provider));
  const [draftError, setDraftError] = useState<string | null>(null);

  function openAdd() {
    setDraft(blankDraft(provider));
    setDraftError(null);
    setIsAdding(true);
  }

  function cancelAdd() {
    setIsAdding(false);
    setDraftError(null);
  }

  function commitAdd() {
    if (!draft.model) {
      setDraftError("Model is required.");
      return;
    }
    const newAgent: AgentConfig = {
      id: `${provider}-${Date.now()}`,
      provider,
      model: draft.model,
      effort: draft.effort,
      name: draft.name.trim() || undefined,
      extendedThinking: provider === "claude" ? draft.extendedThinking : undefined,
      permissionMode: draft.permissionMode,
    };
    onAdd(newAgent);
    setIsAdding(false);
    setDraftError(null);
  }

  function update<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="roster-section">
      <div className="roster-section-header">
        <span className="roster-section-title">{label}</span>
        {!isAdding && (
          <button type="button" className="roster-add-btn" onClick={openAdd}>
            + Add
          </button>
        )}
      </div>

      {agents.length > 0 && (
        <ul className="roster-agent-list">
          {agents.map((agent) => (
            <li key={agent.id} className="roster-agent-row">
              <span className="roster-agent-name">{agentDisplayName(agent)}</span>
              <span className="roster-agent-meta">{agent.model}</span>
              {agent.permissionMode === "yolo" && (
                <span className="roster-agent-badge">yolo</span>
              )}
              <button
                type="button"
                className="roster-remove-btn"
                onClick={() => onRemove(agent.id)}
                title="Remove agent"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {isAdding && (
        <div className="roster-add-form">
          <div className="roster-add-row">
            <label className="roster-add-field">
              <span>Model</span>
              <select
                value={draft.model}
                onChange={(e) => update("model", e.target.value)}
                autoFocus
              >
                {PROVIDER_MODELS[provider].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="roster-add-field">
              <span>Effort</span>
              <select
                value={draft.effort}
                onChange={(e) => update("effort", e.target.value as AgentEffort)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="roster-add-field">
              <span>Permission</span>
              <select
                value={draft.permissionMode}
                onChange={(e) => update("permissionMode", e.target.value as PermissionMode)}
              >
                <option value="normal">Normal</option>
                <option value="yolo">Yolo</option>
              </select>
            </label>
          </div>
          <div className="roster-add-row">
            <label className="roster-add-field roster-add-field-grow">
              <span>Name (optional)</span>
              <input
                value={draft.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder={`e.g. Planner, Reviewer`}
              />
            </label>
            {provider === "claude" && (
              <label className="roster-add-field roster-add-field-checkbox">
                <span>Extended thinking</span>
                <input
                  type="checkbox"
                  checked={draft.extendedThinking}
                  onChange={(e) => update("extendedThinking", e.target.checked)}
                />
              </label>
            )}
          </div>
          {draftError && <p className="error-copy roster-draft-error">{draftError}</p>}
          <div className="roster-add-actions">
            <button type="button" className="secondary-button" onClick={cancelAdd}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={commitAdd}>
              Add Agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
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

  function addAgent(agent: AgentConfig) {
    setValues((prev) => ({ ...prev, agents: [...prev.agents, agent] }));
  }

  function removeAgent(id: string) {
    setValues((prev) => ({ ...prev, agents: prev.agents.filter((a) => a.id !== id) }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!values.projectName.trim()) {
      setFormError("Project Name is required.");
      return;
    }

    if (values.agents.length === 0) {
      setFormError("Add at least one agent.");
      return;
    }

    setFormError(null);
    await onSubmit({
      ...values,
      projectName: values.projectName.trim(),
      description: values.description.trim(),
      projectType: values.projectType.trim() || "desktop-app",
      phase: values.phase.trim() || "v1",
      stack: values.stack.trim(),
    });
  }

  const claudeAgents = values.agents.filter((a) => a.provider === "claude");
  const codexAgents = values.agents.filter((a) => a.provider === "codex");

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
          rows={3}
          placeholder="Short project summary"
        />
      </label>

      <div className="field">
        <span>Agent Roster</span>
        <div className="roster-panel">
          <RosterSection
            provider="claude"
            label="Claude"
            agents={claudeAgents}
            onRemove={removeAgent}
            onAdd={addAgent}
          />
          <RosterSection
            provider="codex"
            label="Codex"
            agents={codexAgents}
            onRemove={removeAgent}
            onAdd={addAgent}
          />
        </div>
      </div>

      {formError ? <p className="error-copy">{formError}</p> : null}

      <div className="form-actions">
        <p className="muted">
          Configure one or more agents. Each can have its own model, effort level, and permissions.
        </p>
        <button className="primary-button" type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Setup"}
        </button>
      </div>
    </form>
  );
}
