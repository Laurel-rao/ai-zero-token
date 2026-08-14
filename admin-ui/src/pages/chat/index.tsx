import { Check, ChevronDown, ChevronUp, Clock3, Copy, Download, ExternalLink, FileText, Image as ImageIcon, Info, LayoutDashboard, Loader2, LogOut, Maximize2, Menu, MessageSquarePlus, Minimize2, MoreHorizontal, Paperclip, Pencil, Play, RefreshCw, Send, Trash2, TriangleAlert, X } from "lucide-react";
import { Children, isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import katex from "katex";
import rehypeKatex from "rehype-katex";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { fetchJson } from "@/shared/api";
import type { AdminConfig } from "@/shared/types";
import type { BusyAction, ModalImage, ModalImageItem, PreviewImage } from "@/shared/lib/app-types";
import { copyText, errorMessage } from "@/shared/lib/app-utils";
import { formatFileSize, formatFullTime } from "@/shared/lib/format";
import { Modal } from "@/shared/components/Modal";

const MAX_ATTACHMENTS = 20;
const MAX_IMAGE_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_SPREADSHEET_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_FILE_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BINARY_ATTACHMENT_BYTES = 80 * 1024 * 1024;
const COLLAPSED_MESSAGE_HEIGHT = 420;
const MOBILE_COLLAPSED_MESSAGE_SCREENS = 2;
const MOBILE_CHAT_BREAKPOINT = 900;
const COPY_FEEDBACK_MS = 1400;
const CHAT_BOTTOM_THRESHOLD = 160;
const COMPOSER_MAX_HEIGHT = 150;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_MESSAGE_PAGE_SIZE = 80;
const CHAT_DETAIL_CACHE_LIMIT = 8;
const CHAT_IMAGE_CLASSIFIER_MODEL = "gpt-5.4";
const CHAT_IMAGE_GENERATION_MODEL = "gpt-image-2";
const CHAT_IMAGE_GENERATION_SIZE = "1024x576";
const CHAT_IMAGE_GENERATION_QUALITY = "high";
const CHAT_IMAGE_POLL_INTERVAL_MS = 2000;
const CHAT_IMAGE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_IMAGE_PROMPT_MAX_LENGTH = 8000;
const HTML_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src data: blob:; child-src data: blob:; form-action 'none'; base-uri 'none'";

function collapsedMessageHeight(): number {
  if (typeof window === "undefined" || !window.matchMedia(`(max-width: ${MOBILE_CHAT_BREAKPOINT}px)`).matches) {
    return COLLAPSED_MESSAGE_HEIGHT;
  }

  const viewportHeight = Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    window.visualViewport?.height ?? 0,
  );
  return Math.max(COLLAPSED_MESSAGE_HEIGHT, Math.round(viewportHeight * MOBILE_COLLAPSED_MESSAGE_SCREENS));
}

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
const SPREADSHEET_ATTACHMENT_EXTENSIONS = new Set([
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
]);
const NATIVE_FILE_ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const IMAGE_ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
const SUPPORTED_ATTACHMENT_HINT = "支持图片、PDF、文本、代码、DOCX、PPTX、XLSX 等小文件，可选择、粘贴或拖入";

type ChatAttachment = {
  id: string;
  kind: "image" | "text" | "file";
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  previewUrl?: string;
  previewSize?: number;
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
  metadata?: Record<string, unknown>;
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

type PendingChatStart = {
  userMessageId: string;
  assistantMessageId: string;
};

type QueuedChatSubmission = {
  id: string;
  conversationId: string;
  content: string;
  attachments: ChatAttachment[];
  model: string;
  queuedAt: number;
};

type ChatImageActionState = {
  status: "checking" | "ready" | "generating" | "success" | "failed";
  historyId?: string;
  prompt?: string;
  reason?: string;
  images?: PreviewImage[];
  error?: string;
};

type ChatImageDecision = {
  shouldGenerate: boolean;
  prompt: string;
  reason?: string;
};

type ChatImageGenerationMetadata = {
  historyId: string;
  prompt: string;
};

type ChatImagePromptCandidate = ChatImageDecision & {
  score: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type ChatImageJobResponse = {
  id: string;
  status: "queued";
  history_url?: string;
};

type ChatGenerationHistoryItem = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "interrupted";
  error?: string;
  images: Array<{
    filename: string;
    url: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    previewUrl?: string;
    previewMimeType?: string;
    previewSize?: number;
  }>;
};

type ChatGenerationHistoryResponse = {
  item: ChatGenerationHistoryItem;
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
  onPreviewImage?: (image: ModalImage) => void;
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

type PendingAttachmentFile = {
  id: string;
  name: string;
  size: number;
  label: string;
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

function formatHourMinute(timestamp?: number): string {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatRelativeConversationTime(timestamp: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (elapsedSeconds < 5) {
    return "刚刚";
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} 秒前`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} 分钟前`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays} 天前`;
  }
  return formatFullTime(timestamp);
}

function RelativeConversationTime(props: { timestamp: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const current = Date.now();
      setNow(current);
      const elapsed = Math.max(0, current - props.timestamp);
      const delay = elapsed < 60_000 ? 1_000 : elapsed < 3_600_000 ? 30_000 : 60_000;
      timer = window.setTimeout(update, delay);
    };
    const elapsed = Math.max(0, Date.now() - props.timestamp);
    timer = window.setTimeout(update, elapsed < 60_000 ? 1_000 : elapsed < 3_600_000 ? 30_000 : 60_000);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [props.timestamp]);

  return <>{formatRelativeConversationTime(props.timestamp, now)}</>;
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

function isSpreadsheetAttachment(file: File): boolean {
  return SPREADSHEET_ATTACHMENT_EXTENSIONS.has(fileExtension(file.name));
}

function isSpreadsheetAttachmentName(name: string): boolean {
  return SPREADSHEET_ATTACHMENT_EXTENSIONS.has(fileExtension(name));
}

function nativeFileMimeTypeForFile(file: File): string | null {
  return NATIVE_FILE_ATTACHMENT_MIME_BY_EXTENSION[fileExtension(file.name)] ?? null;
}

function fileAttachmentLabel(name: string): string {
  const extension = fileExtension(name);
  if (extension === "pdf") {
    return "PDF";
  }
  if (extension === "docx") {
    return "Word";
  }
  if (extension === "pptx") {
    return "PowerPoint";
  }
  if (extension === "xlsx") {
    return "Excel";
  }
  return "文件";
}

function attachmentKindLabel(name: string, kind?: ChatAttachment["kind"]): string {
  if (kind === "image") {
    return "图片";
  }
  if (kind === "file") {
    return fileAttachmentLabel(name);
  }
  if (isSpreadsheetAttachmentName(name)) {
    return "Excel";
  }
  return "文本";
}

function pendingAttachmentLabel(file: File): string {
  const imageMimeType = imageMimeTypeForFile(file);
  if (imageMimeType) {
    return "正在读取图片";
  }
  if (nativeFileMimeTypeForFile(file)) {
    return `正在读取 ${fileAttachmentLabel(file.name)}`;
  }
  if (isSpreadsheetAttachment(file)) {
    return "正在解析 Excel";
  }
  if (isTextAttachment(file)) {
    return "正在读取文本";
  }
  return "正在检查文件";
}

function attachmentNoticeTone(message: string, loading: boolean): "loading" | "success" | "warning" {
  if (loading) {
    return "loading";
  }
  return /失败|未添加|超过|不支持|没有选择/.test(message) ? "warning" : "success";
}

function imageMimeTypeForFile(file: File): string | null {
  if (file.type.startsWith("image/")) {
    return file.type;
  }
  return IMAGE_ATTACHMENT_MIME_BY_EXTENSION[fileExtension(file.name)] ?? null;
}

function normalizeDataUrlMimeType(dataUrl: string, mimeType: string): string {
  return dataUrl.replace(/^data:[^,]*;base64,/i, `data:${mimeType};base64,`);
}

function attachmentImageSrc(attachment: ChatAttachment): string {
  return attachment.previewUrl || attachment.url || attachment.dataUrl || "";
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8Text(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  const suffix = "\n\n[内容过长，已截断到聊天附件上限。]";
  const suffixBytes = utf8ByteLength(suffix);
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, mid)) <= targetBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${suffix}`;
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

async function readSpreadsheetAsText(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sections: string[] = [
    `Excel 附件: ${file.name || "workbook.xlsx"}`,
    `原始文件大小: ${formatFileSize(file.size)}`,
  ];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      continue;
    }
    const csv = XLSX.utils.sheet_to_csv(worksheet, { FS: ",", RS: "\n", blankrows: false }).trim();
    sections.push(`\n## Sheet: ${sheetName}\n${csv || "[空表]"}`);
  }

  return truncateUtf8Text(sections.join("\n"), MAX_TEXT_ATTACHMENT_BYTES);
}

function parseChatHttpError(text: string, fallback: string): string {
  if (!text.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : typeof parsed.message === "string" ? parsed.message : "";
    return message || text;
  } catch {
    return text;
  }
}

function extractJsonObjectText(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const source = fenced || trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  return start >= 0 && end > start ? source.slice(start, end + 1) : source;
}

function parseChatImageDecision(value: string): ChatImageDecision {
  const parsed = JSON.parse(extractJsonObjectText(value)) as {
    shouldGenerate?: unknown;
    should_generate?: unknown;
    prompt?: unknown;
    imagePrompt?: unknown;
    image_prompt?: unknown;
    reason?: unknown;
  };
  const shouldGenerate = parsed.shouldGenerate === true || parsed.should_generate === true;
  const prompt = [parsed.prompt, parsed.imagePrompt, parsed.image_prompt]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
    ?.trim() ?? "";
  return {
    shouldGenerate: shouldGenerate && prompt.length > 0,
    prompt,
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
  };
}

function extractMarkdownSections(value: string): Array<{ heading: string; body: string }> {
  const headings = Array.from(value.matchAll(/^#{1,6}\s+(.+?)\s*$/gm));
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? value.length;
    return {
      heading: heading[1].replace(/\s*#+\s*$/, "").trim(),
      body: value.slice(start, end).trim(),
    };
  });
}

function firstPromptFence(value: string): string | null {
  for (const match of value.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) {
    const body = match[1].trim();
    if (body && !isNegativePromptText(body)) {
      return body;
    }
  }
  return null;
}

function isNegativePromptText(value: string): boolean {
  const normalized = value.toLowerCase();
  return /负面提示词|negative prompt|photorealistic|deformed hands|watermark|bad fingers/.test(normalized) &&
    !/第一人称|画面|构图|style|animation|screenshot|pov|kitchen|burger|海底|动画/.test(normalized);
}

function cleanChatImagePrompt(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^\s*(中文完整提示词|中文提示词|english prompt|英文提示词|推荐最终组合|更短但更准的版本)\s*[:：]?\s*/gim, "")
    .trim()
    .slice(0, CHAT_IMAGE_PROMPT_MAX_LENGTH)
    .trim();
}

function isUsableChatImagePrompt(value: string): boolean {
  if (value.length < 40 || isNegativePromptText(value)) {
    return false;
  }
  const visualMatches = value.match(/生图|提示词|prompt|画面|风格|镜头|构图|海报|插画|摄影|动画|截图|角色|场景|背景|色彩|第一人称|高清|餐厅|厨房|汉堡|海底|screenshot|style|pov|composition|cartoon|animation|cinematic/gi);
  return (visualMatches?.length ?? 0) >= 3;
}

function sectionPromptPriority(heading: string): number {
  const normalized = heading.toLowerCase();
  if (/负面|negative/.test(normalized)) {
    return 0;
  }
  if (/推荐最终组合|final\s+prompt|最终组合/.test(normalized)) {
    return 120;
  }
  if (/中文完整提示词|完整提示词|中文提示词/.test(normalized)) {
    return 110;
  }
  if (/english\s+prompt|英文提示词/.test(normalized)) {
    return 100;
  }
  if (/更短但更准|短版提示词|精简提示词/.test(normalized)) {
    return 90;
  }
  if (/midjourney|sdxl|关键词|prompt|提示词/.test(normalized)) {
    return 55;
  }
  return 0;
}

function addChatImagePromptCandidate(candidates: ChatImagePromptCandidate[], value: string, score: number, reason: string) {
  const prompt = cleanChatImagePrompt(value);
  if (!isUsableChatImagePrompt(prompt)) {
    return;
  }
  candidates.push({
    shouldGenerate: true,
    prompt,
    reason,
    score,
  });
}

function extractChatImagePromptCandidate(content: string): ChatImageDecision | null {
  const source = content.trim();
  if (!source) {
    return null;
  }
  const candidates: ChatImagePromptCandidate[] = [];
  for (const section of extractMarkdownSections(source)) {
    const priority = sectionPromptPriority(section.heading);
    if (priority <= 0) {
      continue;
    }
    addChatImagePromptCandidate(
      candidates,
      firstPromptFence(section.body) || section.body,
      priority,
      `检测到「${section.heading}」提示词段落。`,
    );
  }

  for (const match of source.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) {
    const body = match[1].trim();
    const before = source.slice(Math.max(0, (match.index ?? 0) - 180), match.index ?? 0);
    if (/负面|negative/i.test(before)) {
      continue;
    }
    if (/推荐最终组合|final\s+prompt|生图|提示词|prompt|midjourney|sdxl/i.test(before)) {
      addChatImagePromptCandidate(candidates, body, 85, "检测到可直接使用的生图提示词代码块。");
    }
  }

  if (candidates.length === 0 && /生图|图片生成|提示词|prompt/i.test(source)) {
    const withoutNegative = source.split(/\n#{1,6}\s*(?:负面提示词|negative prompt)\b/i)[0]?.trim() || source;
    addChatImagePromptCandidate(candidates, withoutNegative, 45, "检测到回复包含完整的生图提示词描述。");
  }

  const best = candidates.sort((left, right) => right.score - left.score || right.prompt.length - left.prompt.length)[0];
  if (!best) {
    return null;
  }
  return {
    shouldGenerate: true,
    prompt: best.prompt,
    reason: best.reason,
  };
}

function chatGeneratedPreviewItems(images: PreviewImage[]): ModalImageItem[] {
  return images.map((image) => ({
    src: image.fullSrc || image.src,
    placeholderSrc: image.fullSrc && image.fullSrc !== image.src ? image.src : undefined,
    meta: image.fullMeta || image.meta,
    filename: image.filename,
    ratio: image.width && image.height ? `${image.width}:${image.height}` : undefined,
  }));
}

function previewImagesFromChatHistory(item: ChatGenerationHistoryItem): PreviewImage[] {
  return item.images.map((image) => {
    const dimension = image.width && image.height ? `${image.width}×${image.height}` : "";
    const previewSize = image.previewSize ?? 0;
    return {
      src: image.previewUrl || image.url,
      fullSrc: image.url,
      filename: image.filename,
      meta: image.previewUrl && previewSize > 0
        ? `${dimension ? `${dimension} · ` : ""}预览 ${Math.round(previewSize / 1024)} KB · 原图 ${Math.round(image.size / 1024)} KB`
        : `${image.mimeType}${dimension ? ` · ${dimension}` : ""} · ${(image.size / 1024).toFixed(1)} KB`,
      fullMeta: `${image.mimeType}${dimension ? ` · ${dimension}` : ""} · ${(image.size / 1024).toFixed(1)} KB`,
      width: image.width,
      height: image.height,
    };
  });
}

function chatImageGenerationFromMetadata(metadata: Record<string, unknown> | undefined): ChatImageGenerationMetadata | null {
  const raw = metadata?.imageGeneration;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const historyId = typeof value.historyId === "string" ? value.historyId.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  return historyId && prompt ? { historyId, prompt } : null;
}

function filesFromClipboardData(clipboardData: ClipboardLike): File[] {
  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean) as File[];
  const files = Array.from(clipboardData.files ?? []);
  // Some browsers expose only the first copied file through `items`, while
  // `files` still contains the complete multi-file clipboard payload.
  return files.length >= itemFiles.length ? files : itemFiles;
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

function normalizeMarkdownMathDelimiters(value: string): string {
  return value
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) => {
      if (part.startsWith("```") || part.startsWith("~~~")) {
        return part;
      }
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `$$\n${formula.trim()}\n$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`);
    })
    .join("");
}

function normalizeLatexFence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function isLatexLanguage(language: string): boolean {
  return ["latex", "tex", "math", "katex"].includes(language.trim().toLowerCase());
}

function MarkdownLatexBlock(props: { code: string }) {
  const [copied, setCopied] = useState(false);
  const formula = normalizeLatexFence(props.code);
  const rendered = useMemo(() => {
    try {
      return {
        html: katex.renderToString(formula, {
          displayMode: true,
          throwOnError: true,
          strict: "ignore",
          trust: false,
        }),
        error: "",
      };
    } catch (error) {
      return {
        html: "",
        error: errorMessage(error),
      };
    }
  }, [formula]);

  async function handleCopy() {
    if (await copyText(props.code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }
  }

  return (
    <div className="chat-code-block chat-render-block">
      <div className="chat-code-head">
        <span>LaTeX</span>
        <button className="chat-code-copy" type="button" onClick={() => void handleCopy()} aria-label="复制 LaTeX 源码">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制源码"}
        </button>
      </div>
      {rendered.html ? (
        <div className="chat-render-surface chat-latex-surface" aria-label="LaTeX 公式" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        <>
          <div className="chat-render-error">公式渲染失败：{rendered.error}</div>
          <pre className="chat-render-fallback"><code>{props.code}</code></pre>
        </>
      )}
    </div>
  );
}

function normalizeMermaidSvg(svg: string): string {
  return /<svg\b[^>]*\bxmlns=/.test(svg)
    ? svg
    : svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function mermaidSvgSize(svg: string): { width: number; height: number } {
  try {
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: viewBox[2], height: viewBox[3] };
    }
    const width = Number.parseFloat(root.getAttribute("width") || "");
    const height = Number.parseFloat(root.getAttribute("height") || "");
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  } catch {
    // The rendered Mermaid SVG is still previewable even if dimensions cannot be read.
  }
  return { width: 1600, height: 900 };
}

function mermaidSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalizeMermaidSvg(svg))}`;
}

function canvasPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片编码失败"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

async function mermaidSvgToPng(svg: string): Promise<{ src: string; width: number; height: number }> {
  const source = mermaidSvgDataUrl(svg);
  const sourceSize = mermaidSvgSize(svg);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Mermaid 图表无法转换为图片"));
    image.src = source;
  });

  const baseWidth = Math.max(1, sourceSize.width || image.naturalWidth);
  const baseHeight = Math.max(1, sourceSize.height || image.naturalHeight);
  const maxDimension = 8192;
  const maxPixels = 32_000_000;
  const scale = Math.min(
    2,
    maxDimension / baseWidth,
    maxDimension / baseHeight,
    Math.sqrt(maxPixels / (baseWidth * baseHeight)),
  );
  const width = Math.max(1, Math.round(baseWidth * scale));
  const height = Math.max(1, Math.round(baseHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器无法创建图片画布");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return { src: await canvasPngDataUrl(canvas), width, height };
}

function mermaidFilename(extension: "svg" | "png"): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `mermaid-diagram-${timestamp}.${extension}`;
}

function MarkdownMermaidBlock(props: { code: string; onPreviewImage?: (image: ModalImage) => void }) {
  const [copied, setCopied] = useState(false);
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState("");
  const [state, setState] = useState<{ loading: boolean; svg: string; error: string }>({ loading: true, svg: "", error: "" });

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setState({ loading: true, svg: "", error: "" });
        try {
          const mermaid = (await import("mermaid")).default;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          });
          const renderId = `chat-mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const result = await mermaid.render(renderId, props.code.trim());
          if (!cancelled) {
            setState({ loading: false, svg: result.svg, error: "" });
          }
        } catch (error) {
          if (!cancelled) {
            setState({ loading: false, svg: "", error: errorMessage(error) });
          }
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.code]);

  async function handleCopy() {
    if (await copyText(props.code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }
  }

  function handleEnlarge() {
    if (!state.svg || !props.onPreviewImage) {
      return;
    }
    const size = mermaidSvgSize(state.svg);
    props.onPreviewImage({
      src: mermaidSvgDataUrl(state.svg),
      meta: `Mermaid 矢量图 · ${Math.round(size.width)}×${Math.round(size.height)} · 可继续缩放`,
      filename: mermaidFilename("svg"),
      ratio: `${size.width}:${size.height}`,
    });
  }

  async function handleConvertToImage() {
    if (!state.svg || !props.onPreviewImage || converting) {
      return;
    }
    setConverting(true);
    setConversionError("");
    try {
      const image = await mermaidSvgToPng(state.svg);
      props.onPreviewImage({
        src: image.src,
        meta: `Mermaid 高清 PNG · ${image.width}×${image.height} · 可复制或下载`,
        filename: mermaidFilename("png"),
        ratio: `${image.width}:${image.height}`,
      });
    } catch (error) {
      setConversionError(errorMessage(error));
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="chat-code-block chat-render-block chat-mermaid-block">
      <div className="chat-code-head">
        <span>Mermaid</span>
        <div className="chat-code-actions chat-mermaid-actions">
          <button className="chat-code-copy" type="button" onClick={handleEnlarge} disabled={!state.svg} aria-label="放大查看 Mermaid 图表">
            <Maximize2 size={14} />
            放大查看
          </button>
          <button className="chat-code-copy" type="button" onClick={() => void handleConvertToImage()} disabled={!state.svg || converting} aria-label={converting ? "正在将 Mermaid 转为图片" : "将 Mermaid 转为图片"}>
            {converting ? <Loader2 className="spin" size={14} /> : <ImageIcon size={14} />}
            {converting ? "转换中" : "转为图片"}
          </button>
          <button className="chat-code-copy" type="button" onClick={() => void handleCopy()} aria-label="复制 Mermaid 源码">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制" : "复制源码"}
          </button>
        </div>
      </div>
      {state.loading ? (
        <div className="chat-render-loading"><Loader2 className="spin" size={16} />正在渲染图表...</div>
      ) : state.svg ? (
        <>
          <div className="chat-render-surface chat-mermaid-surface" role="img" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: state.svg }} />
          {conversionError ? <div className="chat-render-error" role="alert">图片转换失败：{conversionError}</div> : null}
        </>
      ) : (
        <>
          <div className="chat-render-error">图表渲染失败：{state.error}</div>
          <pre className="chat-render-fallback"><code>{props.code}</code></pre>
        </>
      )}
    </div>
  );
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

function MarkdownPre({ children, onPreviewHtml, onPreviewImage }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const codeElement = codeElementFromPre(children);
  const className = codeElement?.props.className;
  const code = markdownText(codeElement?.props.children ?? children).replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(className || "")?.[1] ?? "";
  const canPreviewHtml = Boolean(onPreviewHtml && code && isHtmlCode(code, language));

  if (isLatexLanguage(language)) {
    return <MarkdownLatexBlock code={code} />;
  }
  if (language.trim().toLowerCase() === "mermaid") {
    return <MarkdownMermaidBlock code={code} onPreviewImage={onPreviewImage} />;
  }

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

const ChatMessageContent = memo(function ChatMessageContent(props: {
  id: string;
  content: string;
  status: ChatMessage["status"];
  onPreviewHtml: (html: string, title?: string) => void;
  onPreviewImage: (image: ModalImage) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wasRunningRef = useRef(props.status === "running");
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const [collapseHeight] = useState(collapsedMessageHeight);
  const displayContent = props.content || (props.status === "running" ? "正在思考..." : "");
  const normalizedDisplayContent = useMemo(() => normalizeMarkdownMathDelimiters(displayContent), [displayContent]);
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
      return <MarkdownPre {...preProps} onPreviewHtml={props.onPreviewHtml} onPreviewImage={props.onPreviewImage} />;
    },
  }), [props.onPreviewHtml, props.onPreviewImage]);

  useEffect(() => {
    setExpanded(false);
    wasRunningRef.current = props.status === "running";
  }, [props.id]);

  useEffect(() => {
    if (props.status === "running") {
      wasRunningRef.current = true;
      setCanCollapse(false);
      return;
    }

    if (wasRunningRef.current) {
      // Keep the response expanded when streaming finishes so the content height
      // does not suddenly shrink while the user is following the latest output.
      wasRunningRef.current = false;
      setExpanded(true);
    }

    const node = contentRef.current;
    if (!node) {
      return;
    }

    const measure = () => {
      setCanCollapse(node.scrollHeight > collapseHeight + 24);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(node);
    return () => resizeObserver?.disconnect();
  }, [collapseHeight, displayContent, props.status]);

  if (!displayContent) {
    return null;
  }

  return (
    <div className={`chat-markdown-shell ${collapsed ? "is-collapsed" : ""}`}>
      <div
        ref={contentRef}
        className="chat-markdown"
        style={collapsed ? { maxHeight: collapseHeight } : undefined}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={markdownComponents} skipHtml>
          {normalizedDisplayContent}
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
});

export function ChatPage(props: {
  config: AdminConfig | null;
  busy: BusyAction;
  setBusy: (value: BusyAction) => void;
  setStatus: (value: string) => void;
  setPreviewImage: (value: ModalImage | null) => void;
  onExitChat: () => void;
  onLogout: () => void | Promise<void>;
}) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [model, setModel] = useState(props.config?.settings.defaultModel || "");
  const [loading, setLoading] = useState(false);
  const [sendingConversationIds, setSendingConversationIds] = useState<Set<string>>(() => new Set());
  const [creatingConversationStream, setCreatingConversationStream] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<PendingAttachmentFile[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [detailConversationId, setDetailConversationId] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [imageActions, setImageActions] = useState<Record<string, ChatImageActionState>>({});
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreview | null>(null);
  const [htmlPreviewPosition, setHtmlPreviewPosition] = useState<HtmlPreviewPosition | null>(null);
  const [htmlPreviewMaximized, setHtmlPreviewMaximized] = useState(false);
  const [copiedHtmlPreview, setCopiedHtmlPreview] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [queuedSubmissions, setQueuedSubmissions] = useState<Record<string, QueuedChatSubmission[]>>({});
  const streamControllersRef = useRef<Map<string, AbortController>>(new Map());
  const queuedSubmissionsRef = useRef<Map<string, QueuedChatSubmission[]>>(new Map());
  const chatPageRef = useRef<HTMLElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const copyMessageTimerRef = useRef<number | null>(null);
  const copyHtmlTimerRef = useRef<number | null>(null);
  const conversationCacheRef = useRef<Map<string, ChatConversation & { messages: ChatMessage[] }>>(new Map());
  const pendingChatStartRef = useRef<Map<string, PendingChatStart>>(new Map());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const bottomScrollInProgressRef = useRef(false);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const bottomScrollTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ChatConversation[]>([]);
  const imageActionDetectionRef = useRef<Set<string>>(new Set());
  const imageGenerationPollingRef = useRef<Map<string, string>>(new Map());
  const lastScrollTopRef = useRef(0);
  const dragDepthRef = useRef(0);
  const previewDragRef = useRef<HtmlPreviewDragState | null>(null);

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? null, [activeId, conversations]);
  const detailConversation = useMemo(() => conversations.find((item) => item.id === detailConversationId) ?? null, [conversations, detailConversationId]);
  const activeCachedConversation = activeId ? conversationCacheRef.current.get(activeId) ?? null : null;
  const canLoadOlderMessages = Boolean((activeCachedConversation ?? activeConversation)?.hasMoreMessages && messages.length > 0);
  const textModels = useMemo(() => props.config?.models.filter((item) => item.input.includes("text")) ?? [], [props.config?.models]);
  const selectableTextModels = textModels.length > 0
    ? textModels
    : [{ id: props.config?.settings.defaultModel || "gpt-5.4", name: props.config?.settings.defaultModel || "gpt-5.4", input: ["text" as const], provider: "openai-codex", source: "default" }];
  const activeConversationSending = activeId ? sendingConversationIds.has(activeId) : creatingConversationStream;
  const activeQueuedSubmissions = activeId ? queuedSubmissions[activeId] ?? [] : [];
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !uploadingAttachments && (!creatingConversationStream || Boolean(activeId));
  const isLoadingActiveConversation = Boolean(activeId && loadingConversationId === activeId);
  const attachmentNoticeStatus = attachmentNoticeTone(attachmentNotice, uploadingAttachments);

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
      if (bottomScrollTimerRef.current) {
        window.clearTimeout(bottomScrollTimerRef.current);
      }
      if (bottomScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = chatPageRef.current;
    if (!root) {
      return;
    }
    const viewport = window.visualViewport;
    let frame = 0;
    let restingViewportHeight = Math.round(viewport?.height ?? window.innerHeight);
    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
        const viewportOffsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
        const layoutHeight = Math.round(document.documentElement.clientHeight || window.innerHeight);
        const composerFocused = document.activeElement === composerRef.current;
        const keyboardOpen = Boolean(viewport && (
          layoutHeight - viewportHeight - viewportOffsetTop > 120
          || composerFocused && restingViewportHeight - viewportHeight > 120
        ));
        if (!composerFocused) {
          restingViewportHeight = viewportHeight;
        }
        root.style.setProperty("--chat-viewport-height", `${viewportHeight}px`);
        root.style.setProperty("--chat-viewport-offset-top", `${viewportOffsetTop}px`);
        root.dataset.keyboardOpen = keyboardOpen ? "true" : "false";
        if (shouldStickToBottomRef.current) {
          scrollMessagesToBottom();
        } else {
          updateStickToBottom();
        }
      });
    };

    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      root.style.removeProperty("--chat-viewport-height");
      root.style.removeProperty("--chat-viewport-offset-top");
      delete root.dataset.keyboardOpen;
    };
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) {
      return;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!mobileMenuRef.current?.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    scrollMessagesToBottom();
  }, [messages]);

  useEffect(() => {
    setImageActions((current) => {
      const messageIds = new Set(messages.map((message) => message.id));
      for (const id of Array.from(imageActionDetectionRef.current)) {
        if (!messageIds.has(id)) {
          imageActionDetectionRef.current.delete(id);
        }
      }
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => messageIds.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [messages]);

  useEffect(() => {
    const persisted = messages.filter((message) => chatImageGenerationFromMetadata(message.metadata));
    const candidates = messages
      .filter((message) => message.role === "assistant" && message.status === "success" && message.content.trim().length >= 12)
      .slice(-3);
    const pending = new Map([...persisted, ...candidates].map((message) => [message.id, message]));
    for (const message of pending.values()) {
      if (!imageActions[message.id] && !imageActionDetectionRef.current.has(message.id)) {
        void detectImageAction(message);
      }
    }
  }, [messages, imageActions]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(adjustComposerHeight);
    return () => window.cancelAnimationFrame(frame);
  }, [input, attachments.length]);

  useEffect(() => {
    const contentNode = messagesContentRef.current;
    if (!contentNode || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollMessagesToBottom();
      } else {
        updateStickToBottom();
      }
    });
    observer.observe(contentNode);
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
    bottomScrollInProgressRef.current = true;
    setIsNearBottom(true);
    if (bottomScrollTimerRef.current) {
      window.clearTimeout(bottomScrollTimerRef.current);
      bottomScrollTimerRef.current = null;
    }

    // Streaming chunks and rendered markdown can trigger several resize/message
    // updates before the browser paints. Keep the already queued automatic
    // bottom scroll instead of repeatedly cancelling it, otherwise a busy
    // stream can starve the animation frame and never reach the moving bottom.
    if (bottomScrollFrameRef.current !== null && behavior === "auto") {
      return;
    }
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
    }
    bottomScrollFrameRef.current = requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      node.scrollTo({ top: node.scrollHeight - node.clientHeight, behavior });
      lastScrollTopRef.current = node.scrollTop;
      bottomScrollTimerRef.current = window.setTimeout(() => {
        node.scrollTop = node.scrollHeight - node.clientHeight;
        lastScrollTopRef.current = node.scrollTop;
        bottomScrollInProgressRef.current = false;
        shouldStickToBottomRef.current = true;
        setIsNearBottom(true);
        bottomScrollTimerRef.current = null;
      }, behavior === "smooth" ? 500 : 0);
    });
  }

  function cancelBottomScroll() {
    shouldStickToBottomRef.current = false;
    bottomScrollInProgressRef.current = false;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    if (bottomScrollTimerRef.current) {
      window.clearTimeout(bottomScrollTimerRef.current);
      bottomScrollTimerRef.current = null;
    }
    if (messagesScrollRef.current) {
      lastScrollTopRef.current = messagesScrollRef.current.scrollTop;
    }
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

  function setActiveConversationId(id: string | null) {
    activeIdRef.current = id;
    setActiveId(id);
  }

  function registerConversationStream(conversationId: string, controller: AbortController) {
    streamControllersRef.current.set(conversationId, controller);
    setSendingConversationIds(new Set(streamControllersRef.current.keys()));
  }

  function unregisterConversationStream(conversationId: string, controller: AbortController) {
    if (streamControllersRef.current.get(conversationId) !== controller) {
      return;
    }
    streamControllersRef.current.delete(conversationId);
    setSendingConversationIds(new Set(streamControllersRef.current.keys()));
  }

  function replaceConversationQueue(conversationId: string, submissions: QueuedChatSubmission[]) {
    if (submissions.length > 0) {
      queuedSubmissionsRef.current.set(conversationId, submissions);
    } else {
      queuedSubmissionsRef.current.delete(conversationId);
    }
    setQueuedSubmissions((current) => {
      const next = { ...current };
      if (submissions.length > 0) {
        next[conversationId] = submissions;
      } else {
        delete next[conversationId];
      }
      return next;
    });
  }

  function enqueueSubmission(submission: QueuedChatSubmission) {
    const current = queuedSubmissionsRef.current.get(submission.conversationId) ?? [];
    replaceConversationQueue(submission.conversationId, [...current, submission]);
  }

  function takeNextQueuedSubmission(conversationId: string): QueuedChatSubmission | null {
    const current = queuedSubmissionsRef.current.get(conversationId) ?? [];
    const [next, ...remaining] = current;
    if (!next) {
      return null;
    }
    replaceConversationQueue(conversationId, remaining);
    return next;
  }

  function removeQueuedSubmission(conversationId: string, submissionId: string) {
    const current = queuedSubmissionsRef.current.get(conversationId) ?? [];
    replaceConversationQueue(conversationId, current.filter((item) => item.id !== submissionId));
    setConversationStatus(conversationId, "已移除待发送消息。");
  }

  function setConversationStatus(conversationId: string, status: string) {
    if (activeIdRef.current === conversationId) {
      props.setStatus(status);
    }
  }

  function applyMessageStart(
    items: ChatMessage[],
    userMessage: ChatMessage | undefined,
    assistantMessage: ChatMessage | undefined,
    replacedAfterMessageId: string,
    pendingStart?: PendingChatStart,
  ): ChatMessage[] {
    const replacedIndex = replacedAfterMessageId ? items.findIndex((item) => item.id === replacedAfterMessageId) : -1;
    const baseItems = replacedIndex >= 0 ? items.slice(0, replacedIndex + 1) : items;
    const filteredItems = pendingStart
      ? baseItems.filter((item) => item.id !== pendingStart.userMessageId && item.id !== pendingStart.assistantMessageId)
      : baseItems;
    const next = filteredItems.map((item) => {
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

  function markRunningAssistantFailed(conversationId: string | null | undefined, message: string) {
    if (!conversationId) {
      return;
    }
    pendingChatStartRef.current.delete(conversationId);
    const failedAt = Date.now();
    const markFailed = (items: ChatMessage[]) => items.map((item) => (
      item.role === "assistant" && item.status === "running"
        ? { ...item, status: "failed" as const, error: message, updatedAt: failedAt }
        : item
    ));
    updateCachedConversationMessages(conversationId, markFailed);
    updateVisibleConversationMessages(conversationId, markFailed);
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
        setActiveConversationId(nextId);
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
      setActiveConversationId(id);
      setMessages(cached.messages);
      setModel(cached.model || props.config?.settings.defaultModel || model);
      setHistoryOpen(false);
    } else {
      setActiveConversationId(id);
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
      setActiveConversationId(id);
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
      setActiveConversationId(result.item.id);
      setMessages([]);
      setEditingMessage(null);
      if (options?.clearInput !== false) {
        setInput("");
        setAttachments([]);
        setPendingAttachmentFiles([]);
        setUploadingAttachments(false);
        setAttachmentNotice("");
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

  async function renameConversation(id: string, requestedTitle = editingTitle) {
    const title = requestedTitle.trim();
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

  function renameActiveConversation() {
    if (!activeConversation) {
      return;
    }
    const title = window.prompt("重命名会话", activeConversation.title)?.trim();
    if (!title || title === activeConversation.title) {
      return;
    }
    setMobileMenuOpen(false);
    void renameConversation(activeConversation.id, title);
  }

  async function deleteConversation(id: string) {
    const target = conversations.find((item) => item.id === id);
    if (streamControllersRef.current.has(id) || (queuedSubmissionsRef.current.get(id)?.length ?? 0) > 0) {
      props.setStatus("请先停止回复并清空该会话的待发送队列，再删除会话。");
      return;
    }
    if (!window.confirm(`确认删除会话“${target?.title || "未命名会话"}”？删除后无法恢复。`)) {
      return;
    }
    setDeletingConversationId(id);
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
      const next = conversations.filter((item) => item.id !== id);
      setConversations(next);
      setDetailConversationId(null);
      if (activeId === id) {
        const nextId = next[0]?.id ?? null;
        setActiveConversationId(nextId);
        if (nextId) {
          await loadConversation(nextId);
        } else {
          setMessages([]);
        }
      }
      props.setStatus("聊天记录已删除。");
    } catch (error) {
      props.setStatus(`删除失败：${errorMessage(error)}`);
    } finally {
      setDeletingConversationId(null);
    }
  }

  async function filesToAttachments(files: File[]): Promise<ChatAttachment[]> {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      const message = `一次消息最多携带 ${MAX_ATTACHMENTS} 个附件。`;
      setAttachmentNotice(message);
      props.setStatus(message);
      return [];
    }

    const selected = files.slice(0, room);
    let limitMessage = "";
    if (files.length > room) {
      limitMessage = `已达到上限，仅添加前 ${room} 个附件。`;
    }

    const next: ChatAttachment[] = [];
    const skipped: string[] = [];
    let binaryAttachmentBytes = attachments.reduce((total, attachment) => (
      attachment.kind === "image" || attachment.kind === "file" ? total + attachment.size : total
    ), 0);
    for (const file of selected) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const imageMimeType = imageMimeTypeForFile(file);
      if (imageMimeType) {
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 超过 ${formatFileSize(MAX_IMAGE_ATTACHMENT_BYTES)}`);
          continue;
        }
        if (binaryAttachmentBytes + file.size > MAX_TOTAL_BINARY_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 加入后二进制附件合计超过 ${formatFileSize(MAX_TOTAL_BINARY_ATTACHMENT_BYTES)}`);
          continue;
        }
        binaryAttachmentBytes += file.size;
        next.push({
          id,
          kind: "image",
          name: file.name || "clipboard-image.png",
          mimeType: imageMimeType,
          size: file.size,
          dataUrl: normalizeDataUrlMimeType(await readFileAsDataUrl(file), imageMimeType),
        });
        continue;
      }

      const fileMimeType = nativeFileMimeTypeForFile(file);
      if (fileMimeType) {
        if (file.size > MAX_FILE_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 超过 ${formatFileSize(MAX_FILE_ATTACHMENT_BYTES)}`);
          continue;
        }
        if (binaryAttachmentBytes + file.size > MAX_TOTAL_BINARY_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 加入后二进制附件合计超过 ${formatFileSize(MAX_TOTAL_BINARY_ATTACHMENT_BYTES)}`);
          continue;
        }
        binaryAttachmentBytes += file.size;
        next.push({
          id,
          kind: "file",
          name: file.name,
          mimeType: fileMimeType,
          size: file.size,
          dataUrl: normalizeDataUrlMimeType(await readFileAsDataUrl(file), fileMimeType),
        });
        continue;
      }

      if (isSpreadsheetAttachment(file)) {
        if (file.size > MAX_SPREADSHEET_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} 超过 ${formatFileSize(MAX_SPREADSHEET_ATTACHMENT_BYTES)}`);
          continue;
        }
        const spreadsheetText = await readSpreadsheetAsText(file);
        next.push({
          id,
          kind: "text",
          name: file.name || "workbook.xlsx",
          mimeType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: utf8ByteLength(spreadsheetText),
          text: spreadsheetText,
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

      skipped.push(`${file.name || "未命名文件"} 不是当前支持的附件类型`);
    }

    if (skipped.length > 0) {
      const prefix = next.length > 0 ? "部分附件未添加" : "附件未添加";
      const message = `${prefix}：${skipped.slice(0, 3).join("；")}${skipped.length > 3 ? "..." : ""}。${SUPPORTED_ATTACHMENT_HINT}。`;
      setAttachmentNotice(message);
      props.setStatus(message);
    } else if (next.length > 0) {
      const message = limitMessage || `已添加 ${next.length} 个附件。`;
      setAttachmentNotice(message);
      props.setStatus(message);
    }
    return next;
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) {
      setAttachmentNotice("没有选择文件。");
      return;
    }
    const pendingFiles = files.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: file.name || "未命名文件",
      size: file.size,
      label: pendingAttachmentLabel(file),
    }));
    setPendingAttachmentFiles(pendingFiles);
    setUploadingAttachments(true);
    setAttachmentNotice(`正在处理 ${files.length} 个附件...`);
    props.setStatus(`正在处理 ${files.length} 个附件...`);
    try {
      const next = await filesToAttachments(files);
      if (next.length > 0) {
        setAttachments((items) => [...items, ...next]);
      }
    } catch (error) {
      const message = `读取附件失败：${errorMessage(error)}`;
      setAttachmentNotice(message);
      props.setStatus(message);
    } finally {
      setUploadingAttachments(false);
      setPendingAttachmentFiles([]);
      focusComposer();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((items) => items.filter((item) => item.id !== id));
    setPendingAttachmentFiles([]);
    setUploadingAttachments(false);
    setAttachmentNotice("");
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
      const pendingStart = conversationId ? pendingChatStartRef.current.get(conversationId) : undefined;
      if (conversationId) {
        pendingChatStartRef.current.delete(conversationId);
      }
      updateCachedConversationMessages(conversationId, (items) => applyMessageStart(items, userMessage, assistantMessage, replacedAfterMessageId, pendingStart));
      updateVisibleConversationMessages(conversationId, (items) => applyMessageStart(items, userMessage, assistantMessage, replacedAfterMessageId, pendingStart));
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
        if (message.role === "assistant" && message.status === "success" && message.content.trim()) {
          void detectImageAction(message);
        }
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
      if (conversationId) {
        setConversationStatus(conversationId, `聊天失败：${message}`);
      }
    }
  }

  async function detectImageAction(message: ChatMessage) {
    if (imageActions[message.id] || imageActionDetectionRef.current.has(message.id)) {
      return;
    }
    const persisted = chatImageGenerationFromMetadata(message.metadata);
    if (persisted) {
      imageActionDetectionRef.current.add(message.id);
      setImageActions((current) => ({
        ...current,
        [message.id]: {
          status: "generating",
          historyId: persisted.historyId,
          prompt: persisted.prompt,
        },
      }));
      await pollChatImageGeneration(message, persisted.historyId, persisted.prompt);
      return;
    }

    const content = message.content.trim();
    if (!content || content.length < 12) {
      return;
    }
    imageActionDetectionRef.current.add(message.id);
    const localDecision = extractChatImagePromptCandidate(content);
    if (localDecision?.shouldGenerate) {
      setImageActions((current) => ({
        ...current,
        [message.id]: {
          status: "ready",
          prompt: localDecision.prompt,
          reason: localDecision.reason,
        },
      }));
      return;
    }
    setImageActions((current) => ({
      ...current,
      [message.id]: { status: "checking" },
    }));
    try {
      const result = await fetchJson<ChatCompletionResponse>("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CHAT_IMAGE_CLASSIFIER_MODEL,
          messages: [
            {
              role: "system",
              content: [
                "你是聊天内容到生图动作的判定器。",
                "判断 assistant 回复是否已经给出了可以直接用于图片生成的画面描述、提示词、分镜画面、海报/商品图/插画/摄影等视觉生成需求。",
                "只有当回复内容适合立即调用图片生成时才返回 shouldGenerate=true。",
                "如果只是普通问答、代码、表格、解释、拒绝、无明确画面主体或需要继续追问，返回 false。",
                "返回严格 JSON，不要 Markdown：{\"shouldGenerate\":boolean,\"prompt\":\"中文生图提示词\",\"reason\":\"简短原因\"}",
              ].join("\n"),
            },
            {
              role: "user",
              content: `assistant 回复：\n${content.slice(0, 6000)}`,
            },
          ],
          temperature: 0,
          max_tokens: 900,
        }),
      });
      const text = result.choices?.[0]?.message?.content?.trim() || "";
      const decision = parseChatImageDecision(text);
      setImageActions((current) => {
        if (!current[message.id]) {
          return current;
        }
        if (!decision.shouldGenerate) {
          const { [message.id]: _removed, ...rest } = current;
          return rest;
        }
        return {
          ...current,
          [message.id]: {
            status: "ready",
            prompt: decision.prompt,
            reason: decision.reason,
          },
        };
      });
    } catch {
      setImageActions((current) => {
        const { [message.id]: _removed, ...rest } = current;
        return rest;
      });
    }
  }

  async function generateFromChatMessage(message: ChatMessage) {
    const current = imageActions[message.id];
    const prompt = current?.prompt?.trim() || message.content.trim();
    if (!prompt || current?.status === "generating") {
      return;
    }
    setImageActions((items) => ({
      ...items,
      [message.id]: {
        ...current,
        status: "generating",
        prompt,
        error: undefined,
      },
    }));
    props.setStatus("正在根据聊天回复生图...");
    try {
      const job = await fetchJson<ChatImageJobResponse>("/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CHAT_IMAGE_GENERATION_MODEL,
          prompt,
          n: 1,
          size: CHAT_IMAGE_GENERATION_SIZE,
          quality: CHAT_IMAGE_GENERATION_QUALITY,
          output_format: "png",
          response_format: "b64_json",
          _gateway_background: true,
        }),
      });
      const result = await fetchJson<{ item: ChatMessage }>(
        `/_gateway/chats/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}/image-generation`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ historyId: job.id, prompt }),
        },
      );
      const replaceUpdated = (items: ChatMessage[]) => replaceOrAppendMessage(items, result.item);
      updateCachedConversationMessages(message.conversationId, replaceUpdated);
      updateVisibleConversationMessages(message.conversationId, replaceUpdated);
      await pollChatImageGeneration(result.item, job.id, prompt);
    } catch (error) {
      setImageActions((items) => ({
        ...items,
        [message.id]: {
          ...items[message.id],
          status: "failed",
          prompt,
          error: errorMessage(error),
        },
      }));
      props.setStatus(`聊天生图失败：${errorMessage(error)}`);
    }
  }

  async function pollChatImageGeneration(message: ChatMessage, historyId: string, prompt: string) {
    const polling = imageGenerationPollingRef.current;
    if (polling.has(message.id)) {
      return;
    }
    polling.set(message.id, historyId);
    setImageActions((items) => ({
      ...items,
      [message.id]: {
        ...items[message.id],
        status: "generating",
        historyId,
        prompt,
        error: undefined,
      },
    }));

    const startedAt = Date.now();
    let lastItem: ChatGenerationHistoryItem | null = null;
    try {
      while (Date.now() - startedAt < CHAT_IMAGE_POLL_TIMEOUT_MS) {
        const history = await fetchJson<ChatGenerationHistoryResponse>(`/_gateway/generations/history/${encodeURIComponent(historyId)}`);
        lastItem = history.item;
        if (lastItem.status === "success") {
          const images = previewImagesFromChatHistory(lastItem);
          if (images.length === 0) {
            throw new Error("生图完成，但历史记录里没有可预览图片。");
          }
          setImageActions((items) => ({
            ...items,
            [message.id]: {
              ...items[message.id],
              status: "success",
              historyId,
              prompt,
              images,
            },
          }));
          props.setStatus("聊天生图完成。");
          window.setTimeout(() => scrollMessagesToBottom("smooth"), 60);
          return;
        }
        if (lastItem.status === "failed" || lastItem.status === "interrupted") {
          throw new Error(lastItem.error || (lastItem.status === "interrupted" ? "生图任务已中断。" : "生图任务失败。"));
        }
        await new Promise((resolve) => window.setTimeout(resolve, CHAT_IMAGE_POLL_INTERVAL_MS));
      }
      throw new Error(lastItem?.status ? `生图任务仍在 ${lastItem.status}，请稍后到生图历史查看。` : "生图任务等待超时。");
    } catch (error) {
      setImageActions((items) => ({
        ...items,
        [message.id]: {
          ...items[message.id],
          status: "failed",
          historyId,
          prompt,
          error: errorMessage(error),
        },
      }));
      props.setStatus(`聊天生图失败：${errorMessage(error)}`);
    } finally {
      if (polling.get(message.id) === historyId) {
        polling.delete(message.id);
      }
    }
  }

  async function readChatStream(response: Response, conversationId: string) {
    if (!response.ok || !response.body) {
      throw new Error(parseChatHttpError(await response.text(), `HTTP ${response.status}`));
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

  function createChatSubmission(conversationId: string, content: string, sendingAttachments: ChatAttachment[]): QueuedChatSubmission {
    const queuedAt = Date.now();
    return {
      id: `${queuedAt}-${Math.random().toString(36).slice(2, 9)}`,
      conversationId,
      content,
      attachments: sendingAttachments,
      model: model || props.config?.settings.defaultModel || "",
      queuedAt,
    };
  }

  function clearSubmittedComposer(content: string) {
    setInput((value) => value.trim() === content ? "" : value);
    setAttachments([]);
    setPendingAttachmentFiles([]);
    setUploadingAttachments(false);
    setAttachmentNotice("");
  }

  function continueConversationQueue(conversationId: string) {
    const next = takeNextQueuedSubmission(conversationId);
    if (next) {
      setConversationStatus(conversationId, "正在发送下一条队列消息...");
      void runChatSubmission(next);
    } else if (activeIdRef.current === conversationId) {
      focusComposer();
    }
  }

  async function runChatSubmission(submission: QueuedChatSubmission) {
    const { conversationId: targetId, content, attachments: sendingAttachments } = submission;
    shouldStickToBottomRef.current = true;
    const now = Date.now();
    const pendingStart: PendingChatStart = {
      userMessageId: `local-user-${submission.id}`,
      assistantMessageId: `local-assistant-${submission.id}`,
    };
    const optimisticMessages: ChatMessage[] = [
      {
        id: pendingStart.userMessageId,
        conversationId: targetId,
        role: "user",
        content,
        attachments: sendingAttachments,
        status: "success",
        model: submission.model,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: pendingStart.assistantMessageId,
        conversationId: targetId,
        role: "assistant",
        content: "",
        attachments: [],
        status: "running",
        model: submission.model,
        createdAt: now + 1,
        updatedAt: now + 1,
      },
    ];
    pendingChatStartRef.current.set(targetId, pendingStart);
    updateCachedConversationMessages(targetId, (items) => [...items, ...optimisticMessages]);
    updateVisibleConversationMessages(targetId, (items) => [...items, ...optimisticMessages]);
    setIsNearBottom(true);
    const controller = new AbortController();
    registerConversationStream(targetId, controller);
    setCreatingConversationStream(false);
    setConversationStatus(targetId, "正在等待回复...");
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(targetId)}/messages/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, attachments: sendingAttachments, model: submission.model }),
        signal: controller.signal,
      });
      await readChatStream(response, targetId);
      setConversationStatus(targetId, "聊天完成。");
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        markRunningAssistantFailed(targetId, "已停止当前回复。");
        setConversationStatus(targetId, "已停止当前回复。");
      } else {
        const message = `发送失败：${errorMessage(error)}`;
        markRunningAssistantFailed(targetId, message);
        if (activeIdRef.current === targetId) {
          setAttachmentNotice(message);
          props.setStatus(message);
          if ((queuedSubmissionsRef.current.get(targetId)?.length ?? 0) === 0) {
            setInput((value) => value || content);
            setAttachments((items) => items.length > 0 ? items : sendingAttachments);
          }
        }
      }
    } finally {
      unregisterConversationStream(targetId, controller);
      continueConversationQueue(targetId);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    const sendingAttachments = attachments;
    if ((!content && sendingAttachments.length === 0) || uploadingAttachments || creatingConversationStream && !activeIdRef.current) {
      return;
    }
    const initialConversationId = activeIdRef.current;
    if (initialConversationId && streamControllersRef.current.has(initialConversationId)) {
      const submission = createChatSubmission(initialConversationId, content, sendingAttachments);
      clearSubmittedComposer(content);
      enqueueSubmission(submission);
      const queueLength = queuedSubmissionsRef.current.get(initialConversationId)?.length ?? 0;
      setConversationStatus(initialConversationId, `已加入发送队列（第 ${queueLength} 条）。`);
      focusComposer();
      return;
    }
    clearSubmittedComposer(content);
    if (!initialConversationId) {
      setCreatingConversationStream(true);
    }
    props.setStatus(initialConversationId ? "正在等待回复..." : "正在创建聊天...");
    let targetId = initialConversationId;
    if (!targetId) {
      const created = await createConversation({ clearInput: false, silent: true });
      targetId = created?.id ?? null;
    }
    if (!targetId) {
      const message = "发送失败：未能创建聊天，请稍后重试。";
      setAttachmentNotice(message);
      props.setStatus(message);
      setCreatingConversationStream(false);
      setInput((value) => value || content);
      setAttachments((items) => items.length > 0 ? items : sendingAttachments);
      return;
    }
    await runChatSubmission(createChatSubmission(targetId, content, sendingAttachments));
  }

  async function retryMessage(message: ChatMessage) {
    const targetId = activeId;
    if (!targetId || message.status !== "failed" || message.role !== "assistant" || streamControllersRef.current.has(targetId)) {
      return;
    }
    shouldStickToBottomRef.current = true;
    const controller = new AbortController();
    registerConversationStream(targetId, controller);
    props.setStatus("正在重新生成回复...");
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(targetId)}/messages/${encodeURIComponent(message.id)}/retry/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, targetId);
      setConversationStatus(targetId, "重试完成。");
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        markRunningAssistantFailed(targetId, "已停止当前回复。");
        setConversationStatus(targetId, "已停止当前回复。");
      } else {
        setConversationStatus(targetId, `重试失败：${errorMessage(error)}`);
      }
    } finally {
      unregisterConversationStream(targetId, controller);
      continueConversationQueue(targetId);
    }
  }

  async function rewriteFromMessage(message: ChatMessage) {
    const content = editingMessage?.id === message.id ? editingMessage.content.trim() : "";
    const targetId = activeId;
    if (!targetId || !content || message.role !== "user" || streamControllersRef.current.has(targetId)) {
      return;
    }
    shouldStickToBottomRef.current = true;
    setIsNearBottom(true);
    setEditingMessage(null);
    props.setStatus("正在根据编辑后的消息重新生成...");
    const controller = new AbortController();
    registerConversationStream(targetId, controller);
    try {
      const response = await fetch(`/_gateway/chats/${encodeURIComponent(targetId)}/messages/${encodeURIComponent(message.id)}/rewrite/stream`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, model: model || props.config?.settings.defaultModel }),
        signal: controller.signal,
      });
      await readChatStream(response, targetId);
      setConversationStatus(targetId, "已从编辑位置重新生成。");
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        markRunningAssistantFailed(targetId, "已停止当前回复。");
        setConversationStatus(targetId, "已停止当前回复。");
      } else if (activeIdRef.current === targetId) {
        setEditingMessage({ id: message.id, content });
        props.setStatus(`重新生成失败：${errorMessage(error)}`);
      }
    } finally {
      unregisterConversationStream(targetId, controller);
      continueConversationQueue(targetId);
    }
  }

  function stopMessage() {
    if (!activeId) {
      return;
    }
    streamControllersRef.current.get(activeId)?.abort();
    props.setStatus("已停止当前回复。");
    focusComposer();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
      if (composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
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
    if (bottomScrollInProgressRef.current) {
      shouldStickToBottomRef.current = true;
      setIsNearBottom(nearBottom);
      lastScrollTopRef.current = node.scrollTop;
      return;
    }
    const scrollingUp = node.scrollTop < lastScrollTopRef.current - 2;
    const scrollingDown = node.scrollTop > lastScrollTopRef.current + 2;
    // While streaming, an explicit downward scroll means the user wants to
    // catch up with the moving bottom even if newly appended content has
    // already pushed it beyond the normal near-bottom threshold.
    const followingStreamingOutput = activeConversationSending && scrollingDown;
    shouldStickToBottomRef.current = !scrollingUp && (nearBottom || followingStreamingOutput);
    setIsNearBottom(nearBottom);
    lastScrollTopRef.current = node.scrollTop;
  }

  const openHtmlPreview = useCallback((html: string, title = "HTML 预览") => {
    setHtmlPreview({
      html,
      title,
      openedAt: Date.now(),
    });
    setHtmlPreviewMaximized(false);
    setHtmlPreviewPosition(null);
    setCopiedHtmlPreview(false);
  }, []);

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

  function openChatImagePreview(images: PreviewImage[], index: number) {
    const gallery = chatGeneratedPreviewItems(images);
    const active = gallery[index];
    if (!active) {
      return;
    }
    props.setPreviewImage({ ...active, gallery, index });
  }

  function openChatAttachmentPreview(messageAttachments: ChatAttachment[], attachmentId: string) {
    const gallery = messageAttachments
      .filter((attachment) => attachment.kind === "image" && Boolean(attachmentImageSrc(attachment)))
      .map<ModalImageItem>((attachment) => {
        const previewSrc = attachment.previewUrl || "";
        const fullSrc = attachment.url || attachment.dataUrl || previewSrc;
        return {
          src: fullSrc,
          placeholderSrc: previewSrc && previewSrc !== fullSrc ? previewSrc : undefined,
          filename: attachment.name,
          meta: `${attachmentKindLabel(attachment.name, attachment.kind)} · ${formatFileSize(attachment.size)}`,
        };
      });
    const index = messageAttachments
      .filter((attachment) => attachment.kind === "image" && Boolean(attachmentImageSrc(attachment)))
      .findIndex((attachment) => attachment.id === attachmentId);
    const active = gallery[index];
    if (!active) {
      return;
    }
    props.setPreviewImage({ ...active, gallery, index });
  }

  function renderChatImageResult(message: ChatMessage) {
    const action = imageActions[message.id];
    if (!action || (action.status !== "generating" && action.status !== "success" && action.status !== "failed")) {
      return null;
    }

    if (action.status === "generating") {
      return (
        <div className="chat-image-result is-loading">
          <Loader2 className="spin" size={16} />
          <span>正在根据这条回复生成图片...</span>
        </div>
      );
    }

    if (action.status === "failed") {
      return (
        <div className="chat-image-result is-failed">
          <TriangleAlert size={16} />
          <span>{action.error || "生图失败。"}</span>
          <button className="chat-image-inline-btn" type="button" onClick={() => void generateFromChatMessage(message)}>
            <RefreshCw size={14} />
            重试
          </button>
        </div>
      );
    }

    const images = action.images ?? [];
    if (images.length === 0) {
      return null;
    }

    return (
      <div className="chat-image-result is-success" aria-label="聊天生图结果">
        <div className="chat-image-result-head">
          <strong>生成图片</strong>
          <span>{images.length} 张</span>
        </div>
        <div className="chat-image-grid">
          {images.map((image, index) => (
            <figure className="chat-image-card" key={`${message.id}-${image.filename}-${index}`}>
              <button type="button" onClick={() => openChatImagePreview(images, index)} aria-label={`预览第 ${index + 1} 张图片`}>
                <img src={image.src} alt={image.meta} loading="lazy" decoding="async" />
              </button>
              <figcaption>{image.meta}</figcaption>
              <a href={image.fullSrc || image.src} download={image.filename}>
                <Download size={14} />
                下载
              </a>
            </figure>
          ))}
        </div>
      </div>
    );
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
    <section className="chat-page" ref={chatPageRef}>
      <aside className={`chat-history ${historyOpen ? "is-open" : ""}`} aria-label="会话列表">
        <div className="chat-history-head">
          <strong>会话</strong>
          <div className="chat-history-head-actions">
            <button className="btn-secondary icon-only" type="button" onClick={() => void createConversation()} title="新建聊天" aria-label="新建聊天">
              <MessageSquarePlus size={17} />
            </button>
            <button className="btn-secondary icon-only chat-history-close" type="button" onClick={() => setHistoryOpen(false)} title="关闭会话列表" aria-label="关闭会话列表">
              <X size={17} />
            </button>
          </div>
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
                    <time className="chat-history-activity" dateTime={new Date(item.updatedAt).toISOString()} title={`最后活跃：${conversationTimestamp(item)}`}>
                      <Clock3 size={12} />
                      <RelativeConversationTime timestamp={item.updatedAt} />
                    </time>
                  </button>
                  <div className="chat-history-actions">
                    <button className="chat-icon-btn" type="button" onClick={() => { setEditingId(item.id); setEditingTitle(item.title); }} title="重命名" aria-label={`重命名会话：${item.title}`}>
                      <Pencil size={14} />
                    </button>
                    <button className="chat-icon-btn" type="button" onClick={() => setDetailConversationId(item.id)} title="会话详细信息" aria-label={`查看会话详细信息：${item.title}`}>
                      <Info size={15} />
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      </aside>
      {historyOpen ? <button className="chat-history-backdrop" type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭会话列表" /> : null}

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
            <span>{SUPPORTED_ATTACHMENT_HINT}</span>
          </div>
        ) : null}
        <header className="chat-topbar chat-header">
          <button className="btn-secondary icon-only chat-history-toggle" type="button" onClick={() => { setMobileMenuOpen(false); setHistoryOpen((value) => !value); }} title="会话列表" aria-label="打开会话列表">
            <Menu size={17} />
          </button>
          <div className="chat-header-copy">
            <strong>{activeConversation?.title || "聊天"}</strong>
            <span>{activeConversation ? `${activeConversation.messageCount} 条消息 · ${conversationTimestamp(activeConversation)}` : "直接输入即可开始新聊天"}</span>
          </div>
          <select className="control chat-model-select" value={model} onChange={(event) => setModel(event.target.value)} aria-label="选择聊天模型">
            {selectableTextModels.map((item) => (
              <option key={item.id} value={item.id}>{item.id}</option>
            ))}
          </select>
          <div className="chat-mobile-menu" ref={mobileMenuRef}>
            <button
              className="btn-secondary icon-only chat-mobile-more"
              type="button"
              onClick={() => setMobileMenuOpen((value) => !value)}
              aria-label="更多聊天操作"
              aria-haspopup="dialog"
              aria-expanded={mobileMenuOpen}
            >
              <MoreHorizontal size={19} />
            </button>
            {mobileMenuOpen ? (
              <div className="chat-mobile-menu-popover" role="dialog" aria-label="聊天设置和操作">
                <div className="chat-mobile-model-setting">
                  <label htmlFor="chat-mobile-model-select">聊天模型</label>
                  <select
                    id="chat-mobile-model-select"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    aria-label="选择聊天模型"
                  >
                    {selectableTextModels.map((item) => (
                      <option key={item.id} value={item.id}>{item.id}</option>
                    ))}
                  </select>
                </div>
                <span className="chat-mobile-menu-separator" />
                <button type="button" onClick={() => { setMobileMenuOpen(false); void createConversation(); }}>
                  <MessageSquarePlus size={17} />
                  新建会话
                </button>
                <button type="button" onClick={() => { if (activeId) { setDetailConversationId(activeId); } setMobileMenuOpen(false); }} disabled={!activeId}>
                  <Info size={17} />
                  会话详情
                </button>
                <button type="button" onClick={renameActiveConversation} disabled={!activeId}>
                  <Pencil size={17} />
                  重命名会话
                </button>
                <span className="chat-mobile-menu-separator" />
                <button type="button" onClick={() => { setMobileMenuOpen(false); props.onExitChat(); }}>
                  <LayoutDashboard size={17} />
                  返回管理台
                </button>
                <button type="button" onClick={() => { setMobileMenuOpen(false); void props.onLogout(); }} disabled={props.busy === "logout"}>
                  <LogOut size={17} />
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="chat-messages-wrap">
          <div
            className="chat-messages message-list"
            ref={messagesScrollRef}
            onScroll={updateStickToBottom}
            onWheel={cancelBottomScroll}
            onTouchStart={cancelBottomScroll}
            onPointerDown={cancelBottomScroll}
          >
            <div className="chat-messages-content" ref={messagesContentRef}>
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
                    <time className="chat-message-time is-full" dateTime={new Date(message.createdAt).toISOString()}>{formatFullTime(message.createdAt)}</time>
                    <time className="chat-message-time is-compact" dateTime={new Date(message.createdAt).toISOString()} title={formatFullTime(message.createdAt)}>{formatHourMinute(message.createdAt)}</time>
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
                      <span className="chat-action-label">{copiedMessageId === message.id ? "已复制" : "复制"}</span>
                    </button>
                    {message.role === "assistant" && message.status === "failed" ? (
                      <button className="chat-retry-btn" type="button" onClick={() => void retryMessage(message)} disabled={activeConversationSending} title="重新生成" aria-label="重新生成">
                        <RefreshCw size={14} />
                        <span className="chat-action-label">重发</span>
                      </button>
                    ) : null}
                    {message.role === "assistant" && message.status === "success" && imageActions[message.id]?.status === "checking" ? (
                      <em>识别生图</em>
                    ) : null}
                    {message.role === "assistant" && message.status === "success" && imageActions[message.id]?.status === "ready" ? (
                      <button className="chat-retry-btn chat-image-generate-btn" type="button" onClick={() => void generateFromChatMessage(message)} disabled={activeConversationSending} title="根据这条回复生图" aria-label="根据这条回复生图">
                        <ImageIcon size={14} />
                        <span className="chat-action-label">生图</span>
                      </button>
                    ) : null}
                    {message.role === "user" && message.status === "success" ? (
                      <button
                        className="chat-retry-btn"
                        type="button"
                        onClick={() => setEditingMessage({ id: message.id, content: message.content })}
                        disabled={activeConversationSending}
                        title="编辑并从此处重新生成"
                        aria-label="编辑并从此处重新生成"
                      >
                        <Pencil size={14} />
                        <span className="chat-action-label">编辑</span>
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
                        <button className="btn-primary" type="button" onClick={() => void rewriteFromMessage(message)} disabled={!editingMessage.content.trim() || activeConversationSending}>
                          <RefreshCw size={15} />
                          重新生成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <ChatMessageContent id={message.id} content={message.content} status={message.status} onPreviewHtml={openHtmlPreview} onPreviewImage={props.setPreviewImage} />
                  )}
                  {renderChatImageResult(message)}
                  {(message.attachments ?? []).length > 0 ? (
                    <div className="chat-message-attachments" aria-label="消息附件">
                      {(message.attachments ?? []).map((attachment) => (
                        attachment.kind === "image" && attachmentImageSrc(attachment) ? (
                          <button
                            className="chat-message-attachment is-image"
                            type="button"
                            key={attachment.id}
                            onClick={() => openChatAttachmentPreview(message.attachments ?? [], attachment.id)}
                            title={`查看图片 ${attachment.name}`}
                            aria-label={`使用图片查看器查看 ${attachment.name}`}
                          >
                            <img src={attachmentImageSrc(attachment)} alt={attachment.name} />
                            <span>{attachment.name}</span>
                            <em>{attachmentKindLabel(attachment.name, attachment.kind)} · {formatFileSize(attachment.size)}</em>
                          </button>
                        ) : (
                          <div className={`chat-message-attachment is-${attachment.kind}`} key={attachment.id}>
                            <FileText size={16} />
                            <span>{attachment.name}</span>
                            <em>{attachmentKindLabel(attachment.name, attachment.kind)} · {formatFileSize(attachment.size)}</em>
                            {attachment.kind === "file" && attachment.url ? (
                              <a className="chat-message-attachment-download" href={attachment.url} download={attachment.name} title={`下载 ${attachment.name}`} aria-label={`下载 ${attachment.name}`}>
                                <Download size={14} />
                              </a>
                            ) : null}
                          </div>
                        )
                      ))}
                    </div>
                  ) : null}
                  {message.error ? <span className="chat-message-error">{message.error}</span> : null}
                </div>
              </div>
            ))}
            <div ref={messageEndRef} />
            </div>
          </div>
          {!isNearBottom && messages.length > 0 ? (
            <button className="chat-scroll-bottom" type="button" onClick={() => scrollMessagesToBottom("smooth")} aria-label="回到底部">
              <ChevronDown size={16} />
              回到底部
            </button>
          ) : null}
        </div>

        <div className="chat-composer">
          <div className="chat-composer-input">
            {activeQueuedSubmissions.length > 0 ? (
              <div className="chat-send-queue" aria-label={`待发送消息 ${activeQueuedSubmissions.length} 条`} aria-live="polite">
                <div className="chat-send-queue-head">
                  <strong>待发送</strong>
                  <span>{activeQueuedSubmissions.length} 条，将按顺序自动发送</span>
                </div>
                <div className="chat-send-queue-list">
                  {activeQueuedSubmissions.map((submission, index) => (
                    <div className="chat-send-queue-item" key={submission.id}>
                      <span className="chat-send-queue-index">{index + 1}</span>
                      <div>
                        <strong>{submission.content || `[${submission.attachments.length} 个附件]`}</strong>
                        <span>{submission.attachments.length > 0 ? `含 ${submission.attachments.length} 个附件 · ` : ""}{formatFullTime(submission.queuedAt)}</span>
                      </div>
                      <button type="button" onClick={() => removeQueuedSubmission(submission.conversationId, submission.id)} title="移除待发送消息" aria-label={`移除第 ${index + 1} 条待发送消息`}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {attachments.length > 0 || pendingAttachmentFiles.length > 0 ? (
              <div className="chat-attachment-tray" aria-label="待发送附件">
                {pendingAttachmentFiles.map((file) => (
                  <div className="chat-attachment-chip is-pending" key={file.id}>
                    <div className="chat-attachment-thumb">
                      <Loader2 className="spin" size={16} />
                    </div>
                    <div>
                      <strong>{file.name}</strong>
                      <span>{file.label} · {formatFileSize(file.size)}</span>
                    </div>
                    <span className="chat-attachment-state">处理中</span>
                  </div>
                ))}
                {attachments.map((attachment) => (
                  <div className={`chat-attachment-chip is-${attachment.kind}`} key={attachment.id}>
                    <div className="chat-attachment-thumb">
                      {attachment.kind === "image" && attachmentImageSrc(attachment) ? (
                        <img src={attachmentImageSrc(attachment)} alt={attachment.name} />
                      ) : attachment.kind === "image" ? (
                        <ImageIcon size={16} />
                      ) : (
                        <FileText size={16} />
                      )}
                    </div>
                    <div>
                      <strong>{attachment.name}</strong>
                      <span>{attachmentKindLabel(attachment.name, attachment.kind)} · {formatFileSize(attachment.size)}</span>
                    </div>
                    <span className="chat-attachment-state is-ready">已添加</span>
                    <button className="chat-remove-attachment" type="button" onClick={() => removeAttachment(attachment.id)} title="移除附件" aria-label={`移除 ${attachment.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {attachmentNotice ? (
              <div className={`chat-attachment-notice is-${attachmentNoticeStatus}`} aria-live="polite">
                {attachmentNoticeStatus === "loading" ? <Loader2 className="spin" size={14} /> : attachmentNoticeStatus === "warning" ? <TriangleAlert size={14} /> : <Check size={14} />}
                <span>{attachmentNotice}</span>
              </div>
            ) : null}
            <div className="chat-composer-row">
              <label className="chat-visually-hidden" htmlFor="chat-message-input">消息内容</label>
              <label className="chat-attach-button" title="添加附件，支持 PDF、DOCX、PPTX、XLSX" aria-label="添加附件，支持 PDF、DOCX、PPTX、XLSX">
                <Paperclip size={18} />
                <input
                  ref={fileInputRef}
                  className="chat-file-input"
                  type="file"
                  multiple
                  onChange={(event) => {
                    void addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </label>
              <textarea
                id="chat-message-input"
                ref={composerRef}
                rows={1}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  if (attachmentNotice) {
                    setAttachmentNotice("");
                  }
                }}
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
                placeholder="消息…"
              />
              <div className="chat-composer-actions">
                <button className={`btn-primary chat-send-button ${activeConversationSending ? "is-queue" : ""}`} type="button" onClick={sendMessage} disabled={!canSend} title={activeConversationSending ? "加入发送队列" : "发送消息"} aria-label={activeConversationSending ? "加入发送队列" : "发送消息"}>
                  <Send size={17} />
                  <span>{activeConversationSending ? "排队" : "发送"}</span>
                </button>
                {activeId && activeConversationSending ? (
                  <button className="btn-secondary chat-send-button is-stop" type="button" onClick={stopMessage} title="停止生成" aria-label="停止生成">
                    <X size={17} />
                    <span>停止</span>
                  </button>
                ) : null}
              </div>
            </div>
            <span className="chat-composer-hint">Enter 发送{activeConversationSending ? "并加入队列" : ""} · Shift+Enter 换行 · 支持粘贴或拖入附件</span>
          </div>
        </div>
      </div>
      {detailConversation ? (
        <Modal title="会话详细信息" onClose={() => setDetailConversationId(null)} className="chat-conversation-detail-modal">
          <div className="chat-conversation-detail">
            <div className="chat-conversation-detail-summary">
              <span className="chat-conversation-detail-icon"><Info size={18} /></span>
              <div>
                <strong>{detailConversation.title}</strong>
                <span>{detailConversation.lastMessagePreview || "暂无消息摘要"}</span>
              </div>
            </div>
            <dl className="chat-conversation-detail-grid">
              <div>
                <dt>消息数量</dt>
                <dd>{detailConversation.messageCount} 条</dd>
              </div>
              <div>
                <dt>使用模型</dt>
                <dd>{detailConversation.model || props.config?.settings.defaultModel || "-"}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{formatFullTime(detailConversation.createdAt)}</dd>
              </div>
              <div>
                <dt>最后活跃</dt>
                <dd><RelativeConversationTime timestamp={detailConversation.updatedAt} /> · {formatFullTime(detailConversation.updatedAt)}</dd>
              </div>
              <div className="is-wide">
                <dt>会话 ID</dt>
                <dd className="chat-conversation-id">{detailConversation.id}</dd>
              </div>
            </dl>
            <div className="chat-conversation-danger-zone">
              <div>
                <strong>删除会话</strong>
                <span>会话及其中的全部消息将永久删除，此操作无法撤销。</span>
              </div>
              <button className="btn-danger" type="button" onClick={() => void deleteConversation(detailConversation.id)} disabled={deletingConversationId === detailConversation.id || sendingConversationIds.has(detailConversation.id) || (queuedSubmissions[detailConversation.id]?.length ?? 0) > 0}>
                {deletingConversationId === detailConversation.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                {deletingConversationId === detailConversation.id ? "正在删除" : sendingConversationIds.has(detailConversation.id) ? "回复生成中" : (queuedSubmissions[detailConversation.id]?.length ?? 0) > 0 ? "存在待发送消息" : "删除会话"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
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
