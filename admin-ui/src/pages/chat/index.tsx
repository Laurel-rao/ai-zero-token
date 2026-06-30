import { Check, ChevronDown, ChevronUp, Copy, Download, ExternalLink, FileText, Image as ImageIcon, Loader2, Maximize2, Menu, MessageSquarePlus, Minimize2, Paperclip, Pencil, Play, RefreshCw, Send, Trash2, X } from "lucide-react";
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
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
const CHAT_BOTTOM_THRESHOLD = 96;
const COMPOSER_MAX_HEIGHT = 150;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_MESSAGE_PAGE_SIZE = 80;
const CHAT_DETAIL_CACHE_LIMIT = 8;
const HTML_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src data: blob:; child-src data: blob:; form-action 'none'; base-uri 'none'";
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
  hasMoreMessages?: boolean;
  nextBeforeMessageId?: string;
  loadedMessageCount?: number;
};

type ChatSseEvent = {
  event: string;
  data: unknown;
};

type ClipboardLike = {
  items?: DataTransferItemList;
  files?: FileList;
};

type MarkdownCodeProps = {
  className?: string;
  children?: ReactNode;
};

type MarkdownPreProps = {
  children?: ReactNode;
  onPreviewHtml?: (html: string, title?: string) => void;
};

type HtmlPreview = {
  html: string;
  title: string;
  openedAt: number;
};

type HtmlPreviewPosition = {
  left: number;
  top: number;
};

type HtmlPreviewDragState = HtmlPreviewPosition & {
  pointerId: number;
  startX: number;
  startY: number;
};

type EditingMessage = {
  id: string;
  content: string;
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

function filesFromClipboardData(clipboardData: ClipboardLike): File[] {
  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean) as File[];
  const files = Array.from(clipboardData.files ?? []);
  return itemFiles.length > 0 ? itemFiles : files;
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

function isHtmlCode(code: string, language: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (normalizedLanguage === "html" || normalizedLanguage === "htm") {
    return true;
  }
  const normalizedCode = code.trim();
  return /^<!doctype html/i.test(normalizedCode) ||
    /<\/?(html|head|body|main|section|article|div|style|script|canvas|iframe)(\s|>|\/)/i.test(normalizedCode);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function withHtmlPreviewCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(HTML_PREVIEW_CSP)}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${meta}`);
  }
  if (/<!doctype html/i.test(html) || /<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function htmlPreviewBlobUrl(html: string): string {
  return URL.createObjectURL(new Blob([withHtmlPreviewCsp(html)], { type: "text/html;charset=utf-8" }));
}

function MarkdownPre({ children, onPreviewHtml }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const codeElement = codeElementFromPre(children);
  const className = codeElement?.props.className;
  const code = markdownText(codeElement?.props.children ?? children).replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(className || "")?.[1] ?? "";
  const canPreviewHtml = Boolean(onPreviewHtml && code && isHtmlCode(code, language));

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
        <div className="chat-code-actions">
          {canPreviewHtml ? (
            <button className="chat-code-copy" type="button" onClick={() => onPreviewHtml?.(code, "HTML 预览")} aria-label="预览 HTML">
              <Play size={14} />
              预览
            </button>
          ) : null}
          <button className="chat-code-copy" type="button" onClick={handleCopy} aria-label="复制代码块">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function ChatMessageContent(props: {
  id: string;
  content: string;
  status: ChatMessage["status"];
  onPreviewHtml: (html: string, title?: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const displayContent = props.content || (props.status === "running" ? "正在思考..." : "");
  const collapsed = canCollapse && !expanded && props.status !== "running";
  const markdownComponents = useMemo<Components>(() => ({
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
    pre(preProps) {
      return <MarkdownPre {...preProps} onPreviewHtml={props.onPreviewHtml} />;
    },
  }), [props.onPreviewHtml]);

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
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreview | null>(null);
  const [htmlPreviewPosition, setHtmlPreviewPosition] = useState<HtmlPreviewPosition | null>(null);
  const [htmlPreviewMaximized, setHtmlPreviewMaximized] = useState(false);
  const [copiedHtmlPreview, setCopiedHtmlPreview] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const copyMessageTimerRef = useRef<number | null>(null);
  const copyHtmlTimerRef = useRef<number | null>(null);
  const conversationCacheRef = useRef<Map<string, ChatConversation & { messages: ChatMessage[] }>>(new Map());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ChatConversation[]>([]);
  const lastScrollTopRef = useRef(0);
  const dragDepthRef = useRef(0);
  const previewDragRef = useRef<HtmlPreviewDragState | null>(null);

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? null, [activeId, conversations]);
  const activeCachedConversation = activeId ? conversationCacheRef.current.get(activeId) ?? null : null;
  const canLoadOlderMessages = Boolean((activeCachedConversation ?? activeConversation)?.hasMoreMessages && messages.length > 0);
  const textModels = useMemo(() => props.config?.models.filter((item) => item.input.includes("text")) ?? [], [props.config?.models]);
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !sending && props.busy !== "chat";
  const isLoadingActiveConversation = Boolean(activeId && loadingConversationId === activeId);

  useEffect(() => {
    if (!model && props.config?.settings.defaultModel) {
      setModel(props.config.settings.defaultModel);
    }
  }, [model, props.config?.settings.defaultModel]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    return () => {
      if (copyMessageTimerRef.current) {
        window.clearTimeout(copyMessageTimerRef.current);
      }
      if (copyHtmlTimerRef.current) {
        window.clearTimeout(copyHtmlTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    scrollMessagesToBottom();
  }, [messages]);

  useEffect(() => {
    adjustComposerHeight();
  }, [input, attachments.length]);

  useEffect(() => {
    const node = messagesScrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollMessagesToBottom();
      }
      updateStickToBottom();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function hasDraggedFiles(event: DragEvent): boolean {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function handleWindowDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      setDraggingFiles(true);
    }

    function handleWindowDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    }

    function handleWindowDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDraggingFiles(false);
      }
    }

    function handleWindowDrop(event: DragEvent) {
      if (!hasDraggedFiles(event)) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".chat-message-edit")) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDraggingFiles(false);
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setDraggingFiles(false);
      const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
      if (droppedFiles.length > 0) {
        void addFiles(droppedFiles);
      }
    }

    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [attachments.length]);

  useEffect(() => {
    function handleWindowPaste(event: ClipboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".chat-message-edit")) {
        return;
      }
      if (!event.clipboardData) {
        return;
      }
      const pastedFiles = filesFromClipboardData(event.clipboardData);
      if (pastedFiles.length === 0) {
        return;
      }
      event.preventDefault();
      void addFiles(pastedFiles);
    }

    window.addEventListener("paste", handleWindowPaste);
    return () => {
      window.removeEventListener("paste", handleWindowPaste);
    };
  }, [attachments.length]);

  function focusComposer() {
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        composerRef.current?.focus();
      });
    }, 0);
  }

  function adjustComposerHeight() {
    const node = composerRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    const nextHeight = Math.max(48, Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT));
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = node.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "auto") {
    const node = messagesScrollRef.current;
    if (!node) {
      return;
    }
    shouldStickToBottomRef.current = true;
    setIsNearBottom(true);
    requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior });
      lastScrollTopRef.current = node.scrollTop;
    });
  }

  function cacheConversation(item: ChatConversation & { messages: ChatMessage[] }) {
    const cache = conversationCacheRef.current;
    cache.delete(item.id);
    cache.set(item.id, item);
    while (cache.size > CHAT_DETAIL_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      cache.delete(oldest);
    }
  }

  function cacheCurrentConversationSnapshot() {
    const currentId = activeIdRef.current;
    if (!currentId || messages.length === 0) {
      return;
    }
    const cached = conversationCacheRef.current.get(currentId);
    const summary = conversationsRef.current.find((item) => item.id === currentId);
    if (!cached && !summary) {
      return;
    }
    cacheConversation({
      ...(cached ?? summary as ChatConversation),
      id: currentId,
      messages,
      hasMoreMessages: cached?.hasMoreMessages ?? summary?.hasMoreMessages,
      nextBeforeMessageId: cached?.nextBeforeMessageId ?? summary?.nextBeforeMessageId,
      loadedMessageCount: messages.length,
    });
  }

  function forgetConversationCache(id: string) {
    conversationCacheRef.current.delete(id);
  }

  function mergeConversationSummary(item: ChatConversation) {
    setConversations((items) => items.map((entry) => entry.id === item.id ? { ...entry, ...item, messages: undefined } : entry));
  }

  function updateCachedConversationMessages(conversationId: string | null | undefined, updater: (items: ChatMessage[]) => ChatMessage[]) {
    if (!conversationId) {
      return;
    }
    const cached = conversationCacheRef.current.get(conversationId);
    const summary = conversationsRef.current.find((item) => item.id === conversationId);
    if (!cached && !summary) {
      return;
    }
    const nextMessages = updater(cached?.messages ?? []);
    cacheConversation({
      ...(cached ?? summary as ChatConversation),
      id: conversationId,
      messages: nextMessages,
      loadedMessageCount: nextMessages.length,
    });
  }

  function updateVisibleConversationMessages(conversationId: string | null | undefined, updater: (items: ChatMessage[]) => ChatMessage[]) {
    if (!conversationId || activeIdRef.current === conversationId) {
      setMessages(updater);
    }
  }

  function applyMessageStart(
    items: ChatMessage[],
    userMessage: ChatMessage | undefined,
    assistantMessage: ChatMessage | undefined,
    replacedAfterMessageId: string,
  ): ChatMessage[] {
    const replacedIndex = replacedAfterMessageId ? items.findIndex((item) => item.id === replacedAfterMessageId) : -1;
    const baseItems = replacedIndex >= 0 ? items.slice(0, replacedIndex + 1) : items;
    const next = baseItems.map((item) => {
      if (item.id === userMessage?.id) {
        return userMessage;
      }
      if (item.id === assistantMessage?.id) {
        return assistantMessage;
      }
      return item;
    });
    const hasAssistant = Boolean(assistantMessage && next.some((item) => item.id === assistantMessage.id));
    const hasUser = Boolean(userMessage && next.some((item) => item.id === userMessage.id));
    return [
      ...next,
      ...(userMessage && !hasUser ? [userMessage] : []),
      ...(assistantMessage && !hasAssistant ? [assistantMessage] : []),
    ];
  }

  function replaceOrAppendMessage(items: ChatMessage[], message: ChatMessage): ChatMessage[] {
    return items.some((item) => item.id === message.id)
      ? items.map((item) => item.id === message.id ? message : item)
      : [...items, message];
  }

  function conversationDetailUrl(id: string, params?: { beforeMessageId?: string }) {
    const search = new URLSearchParams({ messageLimit: String(CHAT_MESSAGE_PAGE_SIZE) });
    if (params?.beforeMessageId) {
      search.set("beforeMessageId", params.beforeMessageId);
    }
    return `/_gateway/chats/${encodeURIComponent(id)}?${search.toString()}`;
  }

  async function loadConversations(selectId?: string, options?: { loadActive?: boolean }) {
    setLoading(true);
    try {
      const result = await fetchJson<{ items: ChatConversation[] }>(`/_gateway/chats?limit=${CHAT_HISTORY_LIMIT}`);
      setConversations(result.items);
      const nextId = options?.loadActive === false ? activeIdRef.current : selectId ?? activeIdRef.current ?? null;
      if (options?.loadActive !== false) {
        setActiveId(nextId);
      }
      if (nextId && options?.loadActive !== false) {
        await loadConversation(nextId);
      } else {
        if (!nextId) {
          setMessages([]);
        }
      }
    } catch (error) {
      props.setStatus(`读取聊天历史失败：${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadConversation(id: string) {
    if (id === activeId && loadingConversationId === id) {
      return;
    }
    if (id !== activeIdRef.current) {
      cacheCurrentConversationSnapshot();
    }
    conversationLoadAbortRef.current?.abort();
    const controller = new AbortController();
    conversationLoadAbortRef.current = controller;
    const cached = conversationCacheRef.current.get(id);
    if (cached) {
      shouldStickToBottomRef.current = true;
      setIsNearBottom(true);
      setEditingMessage(null);
      setActiveId(id);
      setMessages(cached.messages);
      setModel(cached.model || props.config?.settings.defaultModel || model);
      setHistoryOpen(false);
    } else {
      setActiveId(id);
      setMessages([]);
      setEditingMessage(null);
    }
    setLoadingConversationId(id);
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>(conversationDetailUrl(id), {
        signal: controller.signal,
      });
      if (conversationLoadAbortRef.current !== controller) {
        return;
      }
      shouldStickToBottomRef.current = true;
      setIsNearBottom(true);
      setEditingMessage(null);
      setActiveId(id);
      setMessages(result.item.messages);
      cacheConversation(result.item);
      mergeConversationSummary(result.item);
      setModel(result.item.model || props.config?.settings.defaultModel || model);
      setHistoryOpen(false);
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        props.setStatus(`读取对话失败：${errorMessage(error)}`);
      }
    } finally {
      if (conversationLoadAbortRef.current === controller) {
        conversationLoadAbortRef.current = null;
        setLoadingConversationId(null);
      }
    }
  }

  async function loadOlderMessages() {
    if (!activeId || loadingOlderMessages) {
      return;
    }
    const cached = conversationCacheRef.current.get(activeId);
    const beforeMessageId = cached?.nextBeforeMessageId ?? messages[0]?.id;
    if (!beforeMessageId) {
      return;
    }
    const scrollNode = messagesScrollRef.current;
    const previousScrollHeight = scrollNode?.scrollHeight ?? 0;
    const previousScrollTop = scrollNode?.scrollTop ?? 0;
    setLoadingOlderMessages(true);
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>(conversationDetailUrl(activeId, { beforeMessageId }));
      if (activeIdRef.current !== result.item.id) {
        return;
      }
      const existingIds = new Set(messages.map((message) => message.id));
      const olderMessages = result.item.messages.filter((message) => !existingIds.has(message.id));
      const nextMessages = [...olderMessages, ...messages];
      setMessages(nextMessages);
      const merged: ChatConversation & { messages: ChatMessage[] } = {
        ...result.item,
        messages: nextMessages,
        hasMoreMessages: result.item.hasMoreMessages,
        nextBeforeMessageId: result.item.nextBeforeMessageId,
        loadedMessageCount: nextMessages.length,
      };
      cacheConversation(merged);
      mergeConversationSummary(result.item);
      requestAnimationFrame(() => {
        if (!scrollNode) {
          return;
        }
        scrollNode.scrollTop = scrollNode.scrollHeight - previousScrollHeight + previousScrollTop;
      });
    } catch (error) {
      props.setStatus(`加载更早消息失败：${errorMessage(error)}`);
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  async function createConversation(options?: { clearInput?: boolean; silent?: boolean }): Promise<ChatConversation | null> {
    try {
      const result = await fetchJson<{ item: ChatConversation & { messages: ChatMessage[] } }>("/_gateway/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话", model: model || props.config?.settings.defaultModel }),
      });
      shouldStickToBottomRef.current = true;
      setConversations((items) => [result.item, ...items.filter((item) => item.id !== result.item.id)]);
      setActiveId(result.item.id);
      setMessages([]);
      setEditingMessage(null);
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
    const pastedFiles = filesFromClipboardData(event.clipboardData);
    if (pastedFiles.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
    dragDepthRef.current = Math.max(1, dragDepthRef.current);
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
    dragDepthRef.current = 0;
    setDraggingFiles(false);
  }

  function handleFileDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasEventFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    const droppedFiles = Array.from(event.dataTransfer.files);
    void addFiles(droppedFiles);
  }

  function applyStreamEvent(event: ChatSseEvent, conversationId = activeId) {
    const data = eventRecord(event.data);
    if (event.event === "message_start") {
      const userMessage = data.userMessage as ChatMessage | undefined;
      const assistantMessage = data.assistantMessage as ChatMessage | undefined;
      const replacedAfterMessageId = typeof data.replacedAfterMessageId === "string" ? data.replacedAfterMessageId : "";
      updateCachedConversationMessages(conversationId, (items) => applyMessageStart(items, userMessage, assistantMessage, replacedAfterMessageId));
      updateVisibleConversationMessages(conversationId, (items) => applyMessageStart(items, userMessage, assistantMessage, replacedAfterMessageId));
      return;
    }
    if (event.event === "message_delta") {
      const id = typeof data.id === "string" ? data.id : "";
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (!id || !delta) {
        return;
      }
      const appendDelta = (items: ChatMessage[]) => items.map((item) => item.id === id ? { ...item, content: `${item.content}${delta}` } : item);
      updateCachedConversationMessages(conversationId, appendDelta);
      updateVisibleConversationMessages(conversationId, appendDelta);
      return;
    }
    if (event.event === "message_done") {
      const message = data.message as ChatMessage | undefined;
      if (message?.id) {
        const replaceDone = (items: ChatMessage[]) => replaceOrAppendMessage(items, message);
        updateCachedConversationMessages(conversationId, replaceDone);
        updateVisibleConversationMessages(conversationId, replaceDone);
      }
      void loadConversations(conversationId || undefined, { loadActive: false });
      return;
    }
    if (event.event === "error") {
      const message = typeof data.message === "string" ? data.message : "聊天失败。";
      const assistantMessage = data.assistantMessage as ChatMessage | undefined;
      if (assistantMessage?.id) {
        const replaceFailed = (items: ChatMessage[]) => replaceOrAppendMessage(items, assistantMessage);
        updateCachedConversationMessages(conversationId, replaceFailed);
        updateVisibleConversationMessages(conversationId, replaceFailed);
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
    shouldStickToBottomRef.current = true;
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
      if (activeIdRef.current === targetId) {
        focusComposer();
      }
    }
  }

  async function retryMessage(message: ChatMessage) {
    if (!activeId || message.status !== "failed" || message.role !== "assistant" || sending || props.busy === "chat") {
      return;
    }
    shouldStickToBottomRef.current = true;
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

  async function rewriteFromMessage(message: ChatMessage) {
    const content = editingMessage?.id === message.id ? editingMessage.content.trim() : "";
    if (!activeId || !content || message.role !== "user" || sending || props.busy === "chat") {
      return;
    }
    shouldStickToBottomRef.current = true;
    setIsNearBottom(true);
    setSending(true);
    setEditingMessage(null);
    props.setBusy("chat");
    props.setStatus("正在根据编辑后的消息重新生成...");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(message.id)}/rewrite/stream`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, activeId);
      props.setStatus("已从编辑位置重新生成。");
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        setEditingMessage({ id: message.id, content });
        props.setStatus(`重新生成失败：${errorMessage(error)}`);
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

  function updateStickToBottom() {
    const node = messagesScrollRef.current;
    if (!node) {
      shouldStickToBottomRef.current = true;
      setIsNearBottom(true);
      return;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nearBottom = distance < CHAT_BOTTOM_THRESHOLD;
    const scrollingUp = node.scrollTop < lastScrollTopRef.current - 2;
    shouldStickToBottomRef.current = nearBottom && !scrollingUp;
    setIsNearBottom(nearBottom);
    lastScrollTopRef.current = node.scrollTop;
  }

  function openHtmlPreview(html: string, title = "HTML 预览") {
    setHtmlPreview({
      html,
      title,
      openedAt: Date.now(),
    });
    setHtmlPreviewMaximized(false);
    setHtmlPreviewPosition(null);
    setCopiedHtmlPreview(false);
  }

  async function copyHtmlPreview() {
    if (!htmlPreview) {
      return;
    }
    const ok = await copyText(htmlPreview.html);
    if (!ok) {
      props.setStatus("复制 HTML 失败。");
      return;
    }
    setCopiedHtmlPreview(true);
    props.setStatus("HTML 已复制。");
    if (copyHtmlTimerRef.current) {
      window.clearTimeout(copyHtmlTimerRef.current);
    }
    copyHtmlTimerRef.current = window.setTimeout(() => {
      setCopiedHtmlPreview(false);
      copyHtmlTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  function openHtmlPreviewInWindow() {
    if (!htmlPreview) {
      return;
    }
    const url = htmlPreviewBlobUrl(htmlPreview.html);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function downloadHtmlPreview() {
    if (!htmlPreview) {
      return;
    }
    const url = htmlPreviewBlobUrl(htmlPreview.html);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${htmlPreview.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "preview"}.html`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function startHtmlPreviewDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (htmlPreviewMaximized || event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button")) {
      return;
    }
    const frame = event.currentTarget.closest(".chat-html-preview-window") as HTMLDivElement | null;
    if (!frame) {
      return;
    }
    const rect = frame.getBoundingClientRect();
    const left = htmlPreviewPosition?.left ?? rect.left;
    const top = htmlPreviewPosition?.top ?? rect.top;
    previewDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left,
      top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveHtmlPreview(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const frame = event.currentTarget.closest(".chat-html-preview-window") as HTMLDivElement | null;
    const width = frame?.offsetWidth ?? Math.min(760, window.innerWidth - 44);
    const height = frame?.offsetHeight ?? Math.min(620, window.innerHeight - 44);
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    const maxTop = Math.max(12, window.innerHeight - height - 12);
    setHtmlPreviewPosition({
      left: Math.min(maxLeft, Math.max(12, drag.left + event.clientX - drag.startX)),
      top: Math.min(maxTop, Math.max(12, drag.top + event.clientY - drag.startY)),
    });
  }

  function endHtmlPreviewDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (previewDragRef.current?.pointerId === event.pointerId) {
      previewDragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
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

        <div className="chat-messages-wrap">
          <div className="chat-messages" ref={messagesScrollRef} onScroll={updateStickToBottom}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                <MessageSquarePlus size={34} />
                <strong>{isLoadingActiveConversation ? "正在读取聊天..." : "欢迎，今天想聊点什么？"}</strong>
                <span>{isLoadingActiveConversation ? "历史较多时会先加载最近消息。" : "新会话已准备好。"}</span>
              </div>
            ) : null}
            {canLoadOlderMessages ? (
              <button className="chat-load-older" type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages}>
                {loadingOlderMessages ? <Loader2 className="spin" size={14} /> : <ChevronUp size={14} />}
                {loadingOlderMessages ? "正在加载..." : "加载更早消息"}
              </button>
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
                    {message.role === "user" && message.status === "success" ? (
                      <button
                        className="chat-retry-btn"
                        type="button"
                        onClick={() => setEditingMessage({ id: message.id, content: message.content })}
                        disabled={sending || props.busy === "chat"}
                        title="编辑并从此处重新生成"
                      >
                        <Pencil size={14} />
                        编辑
                      </button>
                    ) : null}
                  </div>
                  {editingMessage?.id === message.id ? (
                    <div className="chat-message-edit">
                      <textarea
                        value={editingMessage.content}
                        onChange={(event) => setEditingMessage({ id: message.id, content: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setEditingMessage(null);
                          }
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void rewriteFromMessage(message);
                          }
                        }}
                        autoFocus
                      />
                      <div className="chat-message-edit-actions">
                        <button className="btn-secondary" type="button" onClick={() => setEditingMessage(null)}>
                          取消
                        </button>
                        <button className="btn-primary" type="button" onClick={() => void rewriteFromMessage(message)} disabled={!editingMessage.content.trim() || sending || props.busy === "chat"}>
                          <RefreshCw size={15} />
                          重新生成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <ChatMessageContent id={message.id} content={message.content} status={message.status} onPreviewHtml={openHtmlPreview} />
                  )}
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
          {!isNearBottom && messages.length > 0 ? (
            <button className="chat-scroll-bottom" type="button" onClick={() => scrollMessagesToBottom("smooth")} aria-label="回到底部">
              <ChevronDown size={16} />
              回到底部
            </button>
          ) : null}
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
      {htmlPreview ? (
        <div
          className={`chat-html-preview-window ${htmlPreviewMaximized ? "is-maximized" : ""}`}
          role="dialog"
          aria-modal="false"
          aria-label={htmlPreview.title}
          style={htmlPreviewPosition && !htmlPreviewMaximized ? { left: htmlPreviewPosition.left, top: htmlPreviewPosition.top, right: "auto", bottom: "auto" } : undefined}
        >
          <div
            className="chat-html-preview-head"
            onPointerDown={startHtmlPreviewDrag}
            onPointerMove={moveHtmlPreview}
            onPointerUp={endHtmlPreviewDrag}
            onPointerCancel={endHtmlPreviewDrag}
          >
            <strong>{htmlPreview.title}</strong>
            <div className="chat-html-preview-actions">
              <button className="chat-html-preview-action" type="button" onClick={() => void copyHtmlPreview()} title="复制 HTML" aria-label="复制 HTML">
                {copiedHtmlPreview ? <Check size={15} /> : <Copy size={15} />}
              </button>
              <button className="chat-html-preview-action" type="button" onClick={downloadHtmlPreview} title="下载 HTML" aria-label="下载 HTML">
                <Download size={15} />
              </button>
              <button className="chat-html-preview-action" type="button" onClick={openHtmlPreviewInWindow} title="新窗口打开" aria-label="新窗口打开 HTML 预览">
                <ExternalLink size={15} />
              </button>
              <button className="chat-html-preview-action" type="button" onClick={() => setHtmlPreviewMaximized((value) => !value)} title={htmlPreviewMaximized ? "还原" : "最大化"} aria-label={htmlPreviewMaximized ? "还原 HTML 预览" : "最大化 HTML 预览"}>
                {htmlPreviewMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
              <button className="chat-html-preview-action" type="button" onClick={() => setHtmlPreview(null)} title="关闭" aria-label="关闭 HTML 预览">
                <X size={16} />
              </button>
            </div>
          </div>
          <iframe
            key={htmlPreview.openedAt}
            title={htmlPreview.title}
            referrerPolicy="no-referrer"
            sandbox="allow-modals allow-scripts"
            srcDoc={withHtmlPreviewCsp(htmlPreview.html)}
          />
        </div>
      ) : null}
    </section>
  );
}
