import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { agentDisplayName } from "../lib/setup";
import { cancelChatMessage, listenForChatStream, listenForChatTool, loadChatThread, sendChatMessage } from "../lib/tauri";
import type { AgentConfig, ChatMessage, ChatThread, ToolBlock } from "../types/harness";

interface ThreadViewProps {
  rootPath: string;
  availableAgents: AgentConfig[];
}

function toolSummary(block: ToolBlock): string {
  const { toolName, input } = block;
  const fp = input.file_path as string | undefined;
  const cmd = input.command as string | undefined;
  const pat = input.pattern as string | undefined;
  const desc = input.description as string | undefined;
  if (fp) return `${toolName}: ${fp}`;
  if (cmd) return `${toolName}: ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`;
  if (pat) return `${toolName}: ${pat}`;
  if (desc) return `${toolName}: ${desc.length > 60 ? `${desc.slice(0, 60)}…` : desc}`;
  return toolName;
}

function ToolUseRow({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(block);
  const statusClass = block.isError ? "error" : block.result !== null ? "done" : "pending";
  return (
    <div className={`tool-block ${statusClass}`}>
      <button
        type="button"
        className="tool-block-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="tool-block-icon">⚙</span>
        <span className="tool-block-summary">{summary}</span>
        {block.result === null && <span className="tool-block-running">•••</span>}
        {block.result !== null && !block.isError && <span className="tool-block-check">✓</span>}
        {block.isError && <span className="tool-block-err">✗</span>}
        <span className="tool-block-chevron">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="tool-block-body">
          <div className="tool-block-section">
            <p className="tool-block-label">Input</p>
            <pre className="tool-block-code">{JSON.stringify(block.input, null, 2).slice(0, 3000)}</pre>
          </div>
          {block.result !== null && (
            <div className="tool-block-section">
              <p className="tool-block-label">Result</p>
              <pre className="tool-block-code">{block.result.slice(0, 1500)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString();
}

function messageLabel(message: ChatMessage): string {
  return message.role === "user" ? "You" : message.provider;
}

export function ThreadView({ rootPath, availableAgents }: ThreadViewProps) {
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const contextPopoverRef = useRef<HTMLDivElement | null>(null);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(availableAgents[0] ?? null);
  const [draft, setDraft] = useState("");
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<{
    messageId: string;
    provider: string;
    content: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showContextPopover, setShowContextPopover] = useState(false);
  const [toolBlocksMap, setToolBlocksMap] = useState<Record<string, ToolBlock[]>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        setError(null);
        const nextThread = await loadChatThread(rootPath);
        if (!cancelled) {
          setThread(nextThread);
        }
      } catch (nextError) {
        if (!cancelled) {
          setThread(null);
          setError(nextError instanceof Error ? nextError.message : "Failed to load thread.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  useEffect(() => {
    if (!selectedAgent || !availableAgents.find((a) => a.id === selectedAgent.id)) {
      setSelectedAgent(availableAgents[0] ?? null);
    }
  }, [availableAgents, selectedAgent]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listenForChatStream((event) => {
      if (cancelled || event.rootPath !== rootPath) return;
      if (event.done || event.stream !== "stdout") return;

      setStreamingResponse((current) => {
        if (!current || current.messageId !== event.messageId) {
          return { messageId: event.messageId, provider: event.provider, content: event.chunk };
        }
        return { ...current, content: `${current.content}${event.chunk}` };
      });
    }).then((stopListening) => {
      if (cancelled) { stopListening(); return; }
      unlisten = stopListening;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listenForChatTool((event) => {
      if (cancelled || event.rootPath !== rootPath) return;
      setToolBlocksMap((prev) => {
        const existing = prev[event.messageId] ?? [];
        const idx = existing.findIndex((b) => b.toolId === event.toolId);
        const block: ToolBlock = {
          toolId: event.toolId,
          toolName: event.toolName,
          input: event.input,
          result: event.result,
          isError: event.isError,
        };
        const next =
          idx >= 0 ? existing.map((b, i) => (i === idx ? block : b)) : [...existing, block];
        return { ...prev, [event.messageId]: next };
      });
    }).then((stopListening) => {
      if (cancelled) {
        stopListening();
        return;
      }
      unlisten = stopListening;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [rootPath]);

  const canSend = useMemo(
    () => draft.trim().length > 0 && !isSending && !isLoading && selectedAgent !== null,
    [draft, isSending, isLoading, selectedAgent],
  );

  const visibleMessages = useMemo(() => {
    const persisted = thread?.messages ?? [];
    if (!pendingUserMessage) return persisted;
    return [...persisted, pendingUserMessage];
  }, [thread?.messages, pendingUserMessage]);

  const includedMessages = useMemo(() => {
    return (thread?.messages ?? []).filter((m) => includedIds.has(m.id));
  }, [thread?.messages, includedIds]);

  useEffect(() => {
    if (!chatLogRef.current) return;
    chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [visibleMessages.length, streamingResponse?.content, isSending]);

  useEffect(() => {
    if (!showContextPopover) return;
    function handleClickOutside(event: MouseEvent) {
      if (contextPopoverRef.current && !contextPopoverRef.current.contains(event.target as Node)) {
        setShowContextPopover(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showContextPopover]);

  function toggleInclude(id: string) {
    setIncludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    textareaRef.current?.focus();
  }

  function removeIncluded(id: string) {
    setIncludedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !selectedAgent) return;

    const contextParts = includedMessages
      .map((m) => `[${messageLabel(m)}]: ${m.content}`)
      .join("\n\n");
    const fullContent = contextParts ? `${content}\n\n---\n${contextParts}` : content;

    try {
      setIsSending(true);
      setError(null);
      setStreamingResponse(null);
      setDraft("");
      setIncludedIds(new Set());
      setPendingUserMessage({
        id: `pending-user-${Date.now()}`,
        role: "user",
        provider: agentDisplayName(selectedAgent),
        content: fullContent,
        createdAt: new Date().toISOString(),
      });
      const nextThread = await sendChatMessage(rootPath, selectedAgent, fullContent);
      setThread(nextThread);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send message.");
      setDraft(content);
    } finally {
      setPendingUserMessage(null);
      setStreamingResponse(null);
      setIsSending(false);
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel panel-span-full thread-panel">
        <p className="eyebrow">Thread</p>

        {error ? <p className="error-copy">{error}</p> : null}

        {isLoading ? (
          <div className="empty-state compact-empty-state">
            <h3>Loading thread</h3>
            <p>Reading persisted message history.</p>
          </div>
        ) : null}

        {!isLoading && thread && thread.messages.length === 0 ? (
          <div className="empty-state compact-empty-state">
            <h3>No messages yet</h3>
            <p>Send your first prompt to start the thread.</p>
          </div>
        ) : null}

        <div className="thread-main">
          {!isLoading && (visibleMessages.length > 0 || isSending) ? (
            <div className="chat-log" aria-label="Thread messages" ref={chatLogRef}>
              {visibleMessages.map((message) => {
                const isIncluded = includedIds.has(message.id);
                const isPending = message.id.startsWith("pending-");
                return (
                  <article
                    key={message.id}
                    data-message-id={message.id}
                    className={[
                      "chat-message",
                      message.role === "user" ? "user" : "assistant",
                      isIncluded ? "included" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <header className="chat-message-meta">
                      <strong>{messageLabel(message)}</strong>
                      <div className="chat-message-meta-right">
                        <span>{formatTime(message.createdAt)}</span>
                        {!isPending && (
                          <button
                            type="button"
                            className={isIncluded ? "include-toggle active" : "include-toggle"}
                            onClick={() => toggleInclude(message.id)}
                            title={isIncluded ? "Remove from prompt" : "Include in prompt"}
                          >
                            {isIncluded ? "✓" : "+"}
                          </button>
                        )}
                      </div>
                    </header>
                    {(toolBlocksMap[message.id] ?? []).length > 0 && (
                      <div className="tool-blocks">
                        {(toolBlocksMap[message.id] ?? []).map((block) => (
                          <ToolUseRow key={block.toolId} block={block} />
                        ))}
                      </div>
                    )}
                    <p>{message.content}</p>
                  </article>
                );
              })}
              {isSending ? (
                <article className="chat-message assistant typing">
                  <header className="chat-message-meta">
                    <strong>{streamingResponse?.provider ?? (selectedAgent ? agentDisplayName(selectedAgent) : "Agent")}</strong>
                    <span>typing</span>
                  </header>
                  {streamingResponse && (toolBlocksMap[streamingResponse.messageId] ?? []).length > 0 && (
                    <div className="tool-blocks">
                      {(toolBlocksMap[streamingResponse.messageId] ?? []).map((block) => (
                        <ToolUseRow key={block.toolId} block={block} />
                      ))}
                    </div>
                  )}
                  {streamingResponse?.content ? (
                    <p>{streamingResponse.content}</p>
                  ) : (
                    <p className="typing-dots" aria-label="Model is replying">
                      <span>.</span>
                      <span>.</span>
                      <span>.</span>
                    </p>
                  )}
                </article>
              ) : null}
            </div>
          ) : null}

          <form className="chat-composer" onSubmit={(event) => void handleSubmit(event)}>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              placeholder="Message… (Enter to send, Shift+Enter for new line)"
              disabled={isSending || isLoading}
            />

            {includedMessages.length > 0 && (
              <div className="context-summary-wrap" ref={contextPopoverRef}>
                <div
                  className={showContextPopover ? "context-summary open" : "context-summary"}
                  onClick={() => setShowContextPopover((prev) => !prev)}
                >
                  <span className="context-summary-text">
                    context from {includedMessages.length} msg{includedMessages.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {showContextPopover && (
                  <div className="context-popover">
                    {includedMessages.map((m) => (
                      <div
                        key={m.id}
                        className="context-popover-item"
                        onClick={() => {
                          setShowContextPopover(false);
                          const el = chatLogRef.current?.querySelector(`[data-message-id="${m.id}"]`);
                          el?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        <div className="context-popover-header">
                          <span className="context-popover-author">{messageLabel(m)}</span>
                          <button
                            type="button"
                            className="context-popover-remove"
                            onClick={(e) => { e.stopPropagation(); removeIncluded(m.id); if (includedMessages.length === 1) setShowContextPopover(false); }}
                          >
                            ×
                          </button>
                        </div>
                        <p className="context-popover-preview">{m.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="chat-composer-actions">
              <select
                className="chat-model-select"
                value={selectedAgent?.id ?? ""}
                onChange={(event) => {
                  const agent = availableAgents.find((a) => a.id === event.target.value);
                  if (agent) setSelectedAgent(agent);
                }}
              >
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agentDisplayName(agent)}
                  </option>
                ))}
              </select>
              {isSending ? (
                <button
                  type="button"
                  className="stop-button"
                  onClick={() => void cancelChatMessage()}
                >
                  Stop
                </button>
              ) : (
                <button className="primary-button" type="submit" disabled={!canSend}>
                  Send
                </button>
              )}
            </div>
          </form>
        </div>
      </article>
    </section>
  );
}
