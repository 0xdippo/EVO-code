import { open } from "@tauri-apps/plugin-dialog";

interface RepoSelectorProps {
  isLoading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => Promise<void>;
}

export function RepoSelector({
  isLoading,
  selectedPath,
  onSelect,
}: RepoSelectorProps) {
  async function handlePick() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a HARNESS repository",
    });

    if (typeof selected === "string") {
      await onSelect(selected);
    }
  }

  return (
    <section className="hero-panel">
      <div>
        <p className="eyebrow">Phase 2</p>
        <h1>HARNESS intake and bootstrap</h1>
        <p className="hero-copy">
          Open a local repository, detect whether HARNESS setup is complete, and
          either finish bootstrap or land directly on a file-backed project home.
        </p>
      </div>
      <div className="hero-actions">
        <button className="primary-button" onClick={handlePick} disabled={isLoading}>
          {isLoading ? "Loading..." : "Open Repository"}
        </button>
        <div className="path-chip">
          {selectedPath ? selectedPath : "No repository selected"}
        </div>
      </div>
    </section>
  );
}
