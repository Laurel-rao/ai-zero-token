import { Check, Loader2, Menu, MessageSquarePlus, Pencil, RefreshCw, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig } from "@/shared/types";
import type { BusyAction } from "@/shared/lib/app-types";
import { errorMessage } from "@/shared/lib/app-utils";
import { formatFullTime } from "@/shared/lib/format";

type ChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "success" | "running" | "failed";
  model?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type ChatConversation = {
  id: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview?: string;
  messages?: ChatMessage[];
};

type ChatSseEvent = {
  event: string;
  data: unknown;
};

function parseSseBuffer(value: string, flush = false): { events: ChatSseEvent[]; rest: string } {
  const blocks = value.split("\n\n");
  const rest = flush ? "" : blocks.pop() ?? "";
  const events: ChatSseEvent[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!dataText) {
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(dataText) });
    } catch {
      // Skip malformed event payloads so the stream can keep rendering.
    }
  }
  return { events, rest };
}

function eventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function conversationTimestamp(item?: ChatConversation | null): string {
  return item?.updatedAt ? formatFullTime(item.updatedAt) : "-";
}

export function ChatPage(props: {
  config: AdminConfig | null;
  busy: BusyAction;
  setBusy: (value: BusyAction) => void;
  setStatus: (value: string) => void;
}) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(props.config?.settings.defaultModel || "");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? null, [activeId, conversations]);
  const textModels = useMemo(() => props.config?.models.filter((item) => item.input.includes("text")) ?? [], [props.config?.models]);
  const canSend = input.trim().length > 0 && !sending && props.busy !== "chat";

  useEffect(() => {
    if (!model && props.config?.settings.defaultModel) {
      setModel(props.config.settings.defaultModel);
    }
  }, [model, props.config?.settings.defaultModel]);

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function focusComposer() {
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        composerRef.current?.focus();
      });
    }, 0);
  }

  async function loadConversations(selectId?: string) {
    setLoading(true);
    try {
      const result = await fetchJson<{ items: ChatConversation[] }>("/_gateway/chats?limit=100");
      setConversations(result.items);
      const nextId = selectId ?? activeId ?? null;
      setActiveId(nextId);
      if (nextId) {
        await loadConversation(nextId);
      } else {
        setMessages([]);
      }
    } catch (error) {
      props.setStatus(`读取聊天历史失败：${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadConversation(id: string) {
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>(`/_gateway/chats/${encodeURIComponent(id)}`);
      setActiveId(id);
      setMessages(result.item.messages);
      setModel(result.item.model || props.config?.settings.defaultModel || model);
      setHistoryOpen(false);
    } catch (error) {
      props.setStatus(`读取对话失败：${errorMessage(error)}`);
    }
  }

  async function createConversation(options?: { clearInput?: boolean; silent?: boolean }): Promise<ChatConversation | null> {
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>("/_gateway/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话", model: model || props.config?.settings.defaultModel }),
      });
      setConversations((items) => [result.item, ...items.filter((item) => item.id !== result.item.id)]);
      setActiveId(result.item.id);
      setMessages([]);
      if (options?.clearInput !== false) {
        setInput("");
      }
      setHistoryOpen(false);
      if (!options?.silent) {
        props.setStatus("已创建新聊天。");
      }
      return result.item;
    } catch (error) {
      props.setStatus(`创建聊天失败：${errorMessage(error)}`);
      return null;
    }
  }

  async function renameConversation(id: string) {
    const title = editingTitle.trim();
    if (!title) {
      return;
    }
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>(`/_gateway/chats/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setConversations((items) => items.map((item) => item.id === id ? { ...item, ...result.item, messages: undefined } : item));
      setEditingId(null);
      props.setStatus("聊天标题已更新。");
    } catch (error) {
      props.setStatus(`重命名失败：${errorMessage(error)}`);
    }
  }

  async function deleteConversation(id: string) {
    if (!window.confirm("确认删除这条聊天记录？")) {
      return;
    }
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
      const next = conversations.filter((item) => item.id !== id);
      setConversations(next);
      if (activeId === id) {
        const nextId = next[0]?.id ?? null;
        setActiveId(nextId);
        if (nextId) {
          await loadConversation(nextId);
        } else {
          setMessages([]);
        }
      }
      props.setStatus("聊天记录已删除。");
    } catch (error) {
      props.setStatus(`删除失败：${errorMessage(error)}`);
    }
  }

  function applyStreamEvent(event: ChatSseEvent, conversationId = activeId) {
    const data = eventRecord(event.data);
    if (event.event === "message_start") {
      const userMessage = data.userMessage as ChatMessage | undefined;
      const assistantMessage = data.assistantMessage as ChatMessage | undefined;
      setMessages((items) => {
        const next = items.map((item) => item.id === assistantMessage?.id ? assistantMessage : item);
        const hasAssistant = Boolean(assistantMessage && items.some((item) => item.id === assistantMessage.id));
        return [
          ...next,
          ...(userMessage ? [userMessage] : []),
          ...(assistantMessage && !hasAssistant ? [assistantMessage] : []),
        ];
      });
      return;
    }
    if (event.event === "message_delta") {
      const id = typeof data.id === "string" ? data.id : "";
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (!id || !delta) {
        return;
      }
      setMessages((items) => items.map((item) => item.id === id ? { ...item, content: `${item.content}${delta}` } : item));
      return;
    }
    if (event.event === "message_done") {
      const message = data.message as ChatMessage | undefined;
      if (message?.id) {
        setMessages((items) => items.map((item) => item.id === message.id ? message : item));
      }
      void loadConversations(conversationId || undefined);
      return;
    }
    if (event.event === "error") {
      const message = typeof data.message === "string" ? data.message : "聊天失败。";
      const assistantMessage = data.assistantMessage as ChatMessage | undefined;
      if (assistantMessage?.id) {
        setMessages((items) => items.map((item) => item.id === assistantMessage.id ? assistantMessage : item));
      }
      props.setStatus(`聊天失败：${message}`);
    }
  }

  async function readChatStream(response: Response, conversationId: string) {
    if (!response.ok || !response.body) {
      throw new Error(await response.text() || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      parsed.events.forEach((event) => applyStreamEvent(event, conversationId));
    }
    const parsed = parseSseBuffer(buffer + decoder.decode(), true);
    parsed.events.forEach((event) => applyStreamEvent(event, conversationId));
  }

  async function sendMessage() {
    const content = input.trim();
    if (!canSend || !content) {
      return;
    }
    setInput((value) => value.trim() === content ? "" : value);
    setSending(true);
    props.setBusy("chat");
    props.setStatus(activeId ? "正在等待回复..." : "正在创建聊天...");
    let targetId = activeId;
    if (!targetId) {
      const created = await createConversation({ clearInput: false, silent: true });
      targetId = created?.id ?? null;
    }
    if (!targetId) {
      setSending(false);
      props.setBusy(null);
      setInput((value) => value || content);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    props.setStatus("正在等待回复...");
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(targetId)}/messages/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, targetId);
      props.setStatus("聊天完成。");
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        props.setStatus(`聊天失败：${errorMessage(error)}`);
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      props.setBusy(null);
      focusComposer();
    }
  }

  async function retryMessage(message: ChatMessage) {
    if (!activeId || message.status !== "failed" || message.role !== "assistant" || sending || props.busy === "chat") {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    props.setBusy("chat");
    props.setStatus("正在重新生成回复...");
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(message.id)}/retry/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, activeId);
      props.setStatus("重试完成。");
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        props.setStatus(`重试失败：${errorMessage(error)}`);
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      props.setBusy(null);
      focusComposer();
    }
  }

  function stopMessage() {
    abortRef.current?.abort();
    props.setStatus("已停止当前回复。");
    focusComposer();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
      if (composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      if (sending || props.busy === "chat") {
        return;
      }
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <section className="chat-page">
      <aside className={`chat-history ${historyOpen ? "is-open" : ""}`}>
        <div className="chat-history-head">
          <strong>聊天</strong>
          <button className="btn-secondary icon-only" type="button" onClick={() => void createConversation()} title="新建聊天">
            <MessageSquarePlus size={17} />
          </button>
        </div>
        <div className="chat-history-list">
          {loading ? <div className="chat-history-empty">正在读取历史...</div> : null}
          {!loading && conversations.length === 0 ? <div className="chat-history-empty">还没有聊天。</div> : null}
          {conversations.map((item) => (
            <article className={`chat-history-item ${item.id === activeId ? "is-active" : ""}`} key={item.id}>
              {editingId === item.id ? (
                <div className="chat-rename-row">
                  <input className="input" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} autoFocus />
                  <button className="chat-icon-btn" type="button" onClick={() => renameConversation(item.id)} title="保存">
                    <Check size={15} />
                  </button>
                  <button className="chat-icon-btn" type="button" onClick={() => setEditingId(null)} title="取消">
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <button className="chat-history-main" type="button" onClick={() => loadConversation(item.id)}>
                    <strong>{item.title}</strong>
                    <span>{item.lastMessagePreview || conversationTimestamp(item)}</span>
                  </button>
                  <div className="chat-history-actions">
                    <button className="chat-icon-btn" type="button" onClick={() => { setEditingId(item.id); setEditingTitle(item.title); }} title="重命名">
                      <Pencil size={14} />
                    </button>
                    <button className="chat-icon-btn" type="button" onClick={() => deleteConversation(item.id)} title="删除">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-topbar">
          <button className="btn-secondary icon-only chat-history-toggle" type="button" onClick={() => setHistoryOpen((value) => !value)} title="聊天历史">
            <Menu size={17} />
          </button>
          <div>
            <strong>{activeConversation?.title || "聊天"}</strong>
            <span>{activeConversation ? `${activeConversation.messageCount} 条消息 · ${conversationTimestamp(activeConversation)}` : "直接输入即可开始新聊天"}</span>
          </div>
          <select className="control chat-model-select" value={model} onChange={(event) => setModel(event.target.value)}>
            {(textModels.length > 0 ? textModels : [{ id: props.config?.settings.defaultModel || "gpt-5.4", name: props.config?.settings.defaultModel || "gpt-5.4", input: ["text" as const], provider: "openai-codex", source: "default" }]).map((item) => (
              <option key={item.id} value={item.id}>{item.id}</option>
            ))}
          </select>
        </div>

        <div className="chat-messages">
          {messages.length === 0 ? (
            <div className="chat-empty">
              <MessageSquarePlus size={34} />
              <strong>开始一场新聊天</strong>
              <span>直接输入问题即可创建聊天。</span>
            </div>
          ) : null}
          {messages.map((message) => (
            <div className={`chat-message is-${message.role}`} key={message.id}>
              <div className="chat-message-avatar">{message.role === "assistant" ? "AI" : "我"}</div>
              <div className="chat-message-body">
                <div className="chat-message-meta">
                  <strong>{message.role === "assistant" ? "AI Zero Token" : "你"}</strong>
                  <span>{formatFullTime(message.createdAt)}</span>
                  {message.status === "running" ? <em>生成中</em> : null}
                  {message.status === "failed" ? <em className="is-error">失败</em> : null}
                  {message.role === "assistant" && message.status === "failed" ? (
                    <button className="chat-retry-btn" type="button" onClick={() => void retryMessage(message)} disabled={sending || props.busy === "chat"} title="重新生成">
                      <RefreshCw size={14} />
                      重发
                    </button>
                  ) : null}
                </div>
                <p>{message.content || (message.status === "running" ? "正在思考..." : "")}</p>
                {message.error ? <span className="chat-message-error">{message.error}</span> : null}
              </div>
            </div>
          ))}
          <div ref={messageEndRef} />
        </div>

        <div className="chat-composer">
          <textarea
            ref={composerRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="发送消息，Enter 发送，Shift+Enter 换行"
          />
          {sending ? (
            <button className="btn-secondary" type="button" onClick={stopMessage}>
              <X size={16} />
              停止
            </button>
          ) : (
            <button className="btn-primary" type="button" onClick={sendMessage} disabled={!canSend}>
              {sending ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              发送
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
