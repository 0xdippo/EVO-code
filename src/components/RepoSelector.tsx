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
    <section className="repo-picker-inline">
      <div className="repo-picker-row">
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
