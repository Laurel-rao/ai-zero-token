import { Check, ChevronDown, ChevronUp, Copy, FileText, Image as ImageIcon, Loader2, Menu, MessageSquarePlus, Paperclip, Pencil, RefreshCw, Send, Trash2, X } from "lucide-react";
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchJson } from "@/shared/api";
import type { AdminConfig } from "@/shared/types";
import type { BusyAction } from "@/shared/lib/app-types";
import { copyText, errorMessage } from "@/shared/lib/app-utils";
import { formatFileSize, formatFullTime } from "@/shared/lib/format";

const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const COLLAPSED_MESSAGE_HEIGHT = 420;
const COPY_FEEDBACK_MS = 1400;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "log",
  "xml",
  "yaml",
  "yml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "scss",
  "html",
  "vue",
  "svelte",
  "py",
  "java",
  "go",
  "rs",
  "php",
  "rb",
  "sh",
  "sql",
]);

type ChatAttachment = {
  id: string;
  kind: "image" | "text";
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  text?: string;
};

type ChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
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

type MarkdownCodeProps = {
  className?: string;
  children?: ReactNode;
};

type MarkdownPreProps = {
  children?: ReactNode;
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

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function isTextAttachment(file: File): boolean {
  return file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/x-yaml" ||
    file.type === "application/yaml" ||
    file.type === "application/javascript" ||
    TEXT_ATTACHMENT_EXTENSIONS.has(fileExtension(file.name));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("文件读取结果不是字符串。"));
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("文件读取失败。"));
    reader.readAsText(file);
  });
}

function markdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(markdownText).join("");
  }
  return "";
}

function codeElementFromPre(children: ReactNode): ReactElement<MarkdownCodeProps> | null {
  const child = Children.toArray(children).find((item) => isValidElement<MarkdownCodeProps>(item));
  return child && isValidElement<MarkdownCodeProps>(child) && child.type === "code" ? child : null;
}

function MarkdownPre({ children }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const codeElement = codeElementFromPre(children);
  const className = codeElement?.props.className;
  const code = markdownText(codeElement?.props.children ?? children).replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(className || "")?.[1] ?? "";

  async function handleCopy() {
    const ok = await copyText(code);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }

  return (
    <div className="chat-code-block">
      <div className="chat-code-head">
        <span>{language || "code"}</span>
        <button className="chat-code-copy" type="button" onClick={handleCopy} aria-label="复制代码块">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="chat-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  pre(props) {
    return <MarkdownPre {...props} />;
  },
};

function ChatMessageContent(props: {
  id: string;
  content: string;
  status: ChatMessage["status"];
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const displayContent = props.content || (props.status === "running" ? "正在思考..." : "");
  const collapsed = canCollapse && !expanded && props.status !== "running";

  useEffect(() => {
    setExpanded(false);
  }, [props.id]);

  useEffect(() => {
    if (props.status === "running") {
      setCanCollapse(false);
      return;
    }

    const node = contentRef.current;
    if (!node) {
      return;
    }

    const measure = () => {
      setCanCollapse(node.scrollHeight > COLLAPSED_MESSAGE_HEIGHT + 24);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(node);
    return () => resizeObserver?.disconnect();
  }, [displayContent, props.status]);

  if (!displayContent) {
    return null;
  }

  return (
    <div className={`chat-markdown-shell ${collapsed ? "is-collapsed" : ""}`}>
      <div
        ref={contentRef}
        className="chat-markdown"
        style={collapsed ? { maxHeight: COLLAPSED_MESSAGE_HEIGHT } : undefined}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
          {displayContent}
        </ReactMarkdown>
      </div>
      {canCollapse && props.status !== "running" ? (
        <button
          className="chat-expand-btn"
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {expanded ? "收起" : "展开全文"}
        </button>
      ) : null}
    </div>
  );
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [model, setModel] = useState(props.config?.settings.defaultModel || "");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const copyMessageTimerRef = useRef<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? null, [activeId, conversations]);
  const textModels = useMemo(() => props.config?.models.filter((item) => item.input.includes("text")) ?? [], [props.config?.models]);
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !sending && props.busy !== "chat";

  useEffect(() => {
    if (!model && props.config?.settings.defaultModel) {
      setModel(props.config.settings.defaultModel);
    }
  }, [model, props.config?.settings.defaultModel]);

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    return () => {
      if (copyMessageTimerRef.current) {
        window.clearTimeout(copyMessageTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    function hasDraggedFiles(event: DragEvent): boolean {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function preventFileNavigation(event: DragEvent) {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    }

    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

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
        setAttachments([]);
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

  async function filesToAttachments(files: File[]): Promise<ChatAttachment[]> {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      props.setStatus(`一次消息最多携带 ${MAX_ATTACHMENTS} 个附件。`);
      return [];
    }

    const selected = files.slice(0, room);
    if (files.length > room) {
      props.setStatus(`已达到上限，仅添加前 ${room} 个附件。`);
    }

    const next: ChatAttachment[] = [];
    const skipped: string[] = [];
    for (const file of selected) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 超过 ${formatFileSize(MAX_IMAGE_ATTACHMENT_BYTES)}`);
          continue;
        }
        next.push({
          id,
          kind: "image",
          name: file.name || "clipboard-image.png",
          mimeType: file.type || "image/png",
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
        });
        continue;
      }

      if (isTextAttachment(file)) {
        if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 超过 ${formatFileSize(MAX_TEXT_ATTACHMENT_BYTES)}`);
          continue;
        }
        next.push({
          id,
          kind: "text",
          name: file.name || "clipboard-text.txt",
          mimeType: file.type || "text/plain",
          size: file.size,
          text: await readFileAsText(file),
        });
        continue;
      }

      skipped.push(`${file.name || "未命名文件"} 暂不支持`);
    }

    if (skipped.length > 0) {
      props.setStatus(`部分附件未添加：${skipped.slice(0, 3).join("；")}${skipped.length > 3 ? "..." : ""}`);
    } else if (next.length > 0) {
      props.setStatus(`已添加 ${next.length} 个附件。`);
    }
    return next;
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    try {
      const next = await filesToAttachments(files);
      if (next.length > 0) {
        setAttachments((items) => [...items, ...next]);
      }
    } catch (error) {
      props.setStatus(`读取附件失败：${errorMessage(error)}`);
    } finally {
      focusComposer();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((items) => items.filter((item) => item.id !== id));
  }

  async function copyMessage(message: ChatMessage) {
    const ok = await copyText(message.content);
    if (!ok) {
      props.setStatus("复制失败。");
      return;
    }
    setCopiedMessageId(message.id);
    props.setStatus("消息已复制。");
    if (copyMessageTimerRef.current) {
      window.clearTimeout(copyMessageTimerRef.current);
    }
    copyMessageTimerRef.current = window.setTimeout(() => {
      setCopiedMessageId(null);
      copyMessageTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  function handleInputPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[];
    const files = Array.from(event.clipboardData.files);
    const pastedFiles = itemFiles.length > 0 ? itemFiles : files;
    if (pastedFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void addFiles(pastedFiles);
  }

  function hasEventFiles(event: ReactDragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!hasEventFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!hasEventFiles(event)) {
      return;
    }
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setDraggingFiles(false);
  }

  function handleFileDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasEventFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDraggingFiles(false);
    const droppedFiles = Array.from(event.dataTransfer.files);
    void addFiles(droppedFiles);
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
    const sendingAttachments = attachments;
    if (!canSend || (!content && sendingAttachments.length === 0)) {
      return;
    }
    setInput((value) => value.trim() === content ? "" : value);
    setAttachments([]);
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
      setAttachments((items) => items.length > 0 ? items : sendingAttachments);
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
        body: JSON.stringify({ content, attachments: sendingAttachments, model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, targetId);
      props.setStatus("聊天完成。");
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        props.setStatus(`聊天失败：${errorMessage(error)}`);
        setInput((value) => value || content);
        setAttachments((items) => items.length > 0 ? items : sendingAttachments);
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

      <div
        className={`chat-main ${draggingFiles ? "is-dragging-files" : ""}`}
        onDragOver={handleFileDragOver}
        onDragEnter={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
      >
        {draggingFiles ? (
          <div className="chat-drop-overlay" aria-live="polite">
            <Paperclip size={22} />
            <strong>松开添加附件</strong>
            <span>支持图片、文本、代码、JSON 和 CSV 文件</span>
          </div>
        ) : null}
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
                  <button
                    className="chat-message-copy"
                    type="button"
                    onClick={() => void copyMessage(message)}
                    disabled={!message.content}
                    title="复制整条消息"
                    aria-label="复制整条消息"
                  >
                    {copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}
                    {copiedMessageId === message.id ? "已复制" : "复制"}
                  </button>
                  {message.role === "assistant" && message.status === "failed" ? (
                    <button className="chat-retry-btn" type="button" onClick={() => void retryMessage(message)} disabled={sending || props.busy === "chat"} title="重新生成">
                      <RefreshCw size={14} />
                      重发
                    </button>
                  ) : null}
                </div>
                <ChatMessageContent id={message.id} content={message.content} status={message.status} />
                {(message.attachments ?? []).length > 0 ? (
                  <div className="chat-message-attachments" aria-label="消息附件">
                    {(message.attachments ?? []).map((attachment) => (
                      <div className={`chat-message-attachment is-${attachment.kind}`} key={attachment.id}>
                        {attachment.kind === "image" && attachment.dataUrl ? (
                          <img src={attachment.dataUrl} alt={attachment.name} />
                        ) : (
                          <FileText size={16} />
                        )}
                        <span>{attachment.name}</span>
                        <em>{formatFileSize(attachment.size)}</em>
                      </div>
                    ))}
                  </div>
                ) : null}
                {message.error ? <span className="chat-message-error">{message.error}</span> : null}
              </div>
            </div>
          ))}
          <div ref={messageEndRef} />
        </div>

        <div className="chat-composer">
          <input
            ref={fileInputRef}
            className="chat-file-input"
            type="file"
            multiple
            accept="image/*,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.css,.scss,.html,.vue,.svelte,.py,.java,.go,.rs,.php,.rb,.sh,.sql"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <div className="chat-composer-input">
            {attachments.length > 0 ? (
              <div className="chat-attachment-tray" aria-label="待发送附件">
                {attachments.map((attachment) => (
                  <div className={`chat-attachment-chip is-${attachment.kind}`} key={attachment.id}>
                    <div className="chat-attachment-thumb">
                      {attachment.kind === "image" && attachment.dataUrl ? (
                        <img src={attachment.dataUrl} alt={attachment.name} />
                      ) : attachment.kind === "image" ? (
                        <ImageIcon size={16} />
                      ) : (
                        <FileText size={16} />
                      )}
                    </div>
                    <div>
                      <strong>{attachment.name}</strong>
                      <span>{attachment.kind === "image" ? "图片" : "文本"} · {formatFileSize(attachment.size)}</span>
                    </div>
                    <button className="chat-remove-attachment" type="button" onClick={() => removeAttachment(attachment.id)} title="移除附件" aria-label={`移除 ${attachment.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="chat-composer-row">
              <button className="chat-attach-button" type="button" onClick={() => fileInputRef.current?.click()} title="添加附件" aria-label="添加附件">
                <Paperclip size={18} />
              </button>
              <textarea
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handleInputPaste}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onDragOver={handleFileDragOver}
                onDragEnter={handleFileDragOver}
                onDragLeave={handleFileDragLeave}
                onDrop={handleFileDrop}
                onKeyDown={handleInputKeyDown}
                placeholder="发送消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入附件"
              />
            </div>
          </div>
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
