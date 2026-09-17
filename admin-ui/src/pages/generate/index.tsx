import { Activity, BarChart3, Check, CheckCircle2, ChevronDown, ClipboardPaste, Copy, Download, Images, ImagePlus, LayoutGrid, List, Loader2, Pencil, RotateCcw, Search, Sparkles, Upload, Users, X } from "lucide-react";
import { zipSync } from "fflate";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, RequestLog } from "@/shared/types";
import type { BusyAction, ModalImage, ModalImageItem, PreviewImage } from "@/shared/lib/app-types";
import { copyText, createClientId, errorMessage, readFileAsDataUrl } from "@/shared/lib/app-utils";
import { formatDuration, formatFullTime, formatJson } from "@/shared/lib/format";
import { profileLabel } from "@/shared/lib/profiles";
import { userDisplayName } from "@/shared/lib/users";
import type { UserRole } from "@/routes/routes";
import { DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "@/shared/lib/prompt-optimizer";
import { Modal } from "@/shared/components/Modal";
import { HistoryPreviewThumb, HistoryTable, type HistoryMenuActionKey } from "./HistoryTable";
import { HistoryDetailDrawer } from "./HistoryDetailDrawer";
import { runHistoryAction } from "./history-actions";
import {
  EMPTY_HISTORY_FILTERS,
  HISTORY_STATUS_FILTER_LABELS,
  failureSummary,
  generateStatusMeta,
  historyFilterCount,
  parseHistoryTimeRange,
  ratioClassName,
  type GenerationHistoryFilterState,
} from "./history-helpers";
import type {
  GenerateHistoryItem,
  GenerateHistoryResponse,
  GenerationOwnerUsageResponse,
  HistoryOwnerOption,
  HistoryStatusFilter,
  HistoryViewMode,
  ImageQuality,
  OutputFormat,
} from "./history-types";

type GenerateTab = "create" | "history" | "report";
type ImageRatio = "1:1" | "16:9" | "9:16" | "4:3";
type ResolutionPreset = "1k" | "2k" | "4k" | "custom";
type ReferenceImageState = { id: string; src: string; previewSrc: string; name: string; size: number };
type ResolutionOption = { preset: ResolutionPreset; label: string; disabled?: boolean; reason?: string };
type PromptSuggestion = {
  title: string;
  prompt: string;
  source: "upstream-policy" | "parse-failure";
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type PendingGenerationJob = {
  id: string;
  submittedAt: number;
  status: "queued" | "running";
  endpoint: string;
  prompt: string;
  ratio: string;
  size: string;
  count: number;
  waitDurationMs?: number;
  durationMs?: number;
  pollError?: string;
};

type BackgroundGenerationResponse = {
  id?: string;
  status?: "queued";
  history_url?: string;
};

const GENERATE_HISTORY_PAGE_SIZE = 10;
const HISTORY_REFERENCE_PAGE_SIZE = 12;

function referencePreviewItems(images: ReferenceImageState[]): ModalImageItem[] {
  return images.map((image) => ({
    src: image.src,
    meta: `${image.name} · ${(image.size / 1024).toFixed(1)} KB`,
    filename: image.name,
  }));
}

function generatedPreviewItems(images: PreviewImage[], fallbackRatio: string): ModalImageItem[] {
  return images.map((image) => ({
    src: image.fullSrc || image.src,
    placeholderSrc: image.fullSrc && image.fullSrc !== image.src ? image.src : undefined,
    meta: image.fullMeta || image.meta,
    filename: image.filename,
    ratio: image.width && image.height ? `${image.width}:${image.height}` : fallbackRatio,
  }));
}

function historyPreviewItems(item: GenerateHistoryItem): ModalImageItem[] {
  return item.images.map((image) => ({
    src: image.url,
    placeholderSrc: image.previewUrl && image.previewUrl !== image.url ? image.previewUrl : undefined,
    meta: `${image.mimeType}${image.width && image.height ? ` · ${image.width}×${image.height}` : ""} · ${(image.size / 1024).toFixed(1)} KB`,
    filename: image.filename,
    ratio: image.width && image.height ? `${image.width}:${image.height}` : item.ratio || item.size,
  }));
}

function previewImagesFromHistory(item: GenerateHistoryItem): PreviewImage[] {
  return item.images.flatMap((image, index) => {
    const src = image.previewUrl || image.url;
    const fullSrc = image.url || image.previewUrl;
    if (!src || !fullSrc) return [];
    const dimension = image.width && image.height ? `${image.width}×${image.height} · ` : "";
    return [{
      src,
      fullSrc,
      filename: image.filename || `generated-${index + 1}.${item.outputFormat || "png"}`,
      meta: image.previewSize
        ? `${dimension}预览 ${(image.previewSize / 1024).toFixed(1)} KB`
        : `${dimension}${image.mimeType || "image"}`,
      fullMeta: image.size ? `${image.mimeType || "image"}${dimension ? ` · ${dimension.trimEnd().replace(/ ·$/, "")}` : ""} · ${(image.size / 1024).toFixed(1)} KB` : undefined,
      width: image.width,
      height: image.height,
    }];
  });
}

type GenerateReportResponse = {
  startTime?: number;
  endTime?: number;
  bucketMs: number;
  summary: {
    requestCount: number;
    imageCount: number;
    activeUserCount: number;
    successCount: number;
    failedCount: number;
    successRate: number;
    averageDurationMs: number;
    averageRequestsPerUser: number;
  };
  buckets: Array<{
    startTime: number;
    requestCount: number;
    imageCount: number;
    activeUserCount: number;
    successCount: number;
    failedCount: number;
    averageDurationMs: number;
  }>;
  users: Array<{
    owner: string;
    requestCount: number;
    imageCount: number;
    successCount: number;
    failedCount: number;
    successRate: number;
  }>;
};

const EMPTY_GENERATE_REPORT: GenerateReportResponse = {
  bucketMs: 24 * 60 * 60 * 1000,
  summary: {
    requestCount: 0,
    imageCount: 0,
    activeUserCount: 0,
    successCount: 0,
    failedCount: 0,
    successRate: 0,
    averageDurationMs: 0,
    averageRequestsPerUser: 0,
  },
  buckets: [],
  users: [],
};

const DEFAULT_IMAGE_RATIO: ImageRatio = "16:9";
const DEFAULT_RESOLUTION_PRESET: ResolutionPreset = "1k";
const DEFAULT_IMAGE_QUALITY: ImageQuality = "high";

const ratioOptions: Array<{ ratio: ImageRatio; label: string }> = [
  { ratio: "1:1", label: "1:1" },
  { ratio: "16:9", label: "16:9" },
  { ratio: "9:16", label: "9:16" },
  { ratio: "4:3", label: "4:3" },
];
const CODEX_NATIVE_RESOLUTION_NOTICE = "当前 Codex 生图通道仅支持 1K 原生输出，2K/4K 暂不可用。";
const resolutionOptions: ResolutionOption[] = [
  { preset: "1k", label: "1K" },
  { preset: "2k", label: "2K", disabled: true, reason: "暂不支持" },
  { preset: "4k", label: "4K", disabled: true, reason: "暂不支持" },
  { preset: "custom", label: "自定义" },
];
const resolutionSizes: Record<Exclude<ResolutionPreset, "custom">, Record<ImageRatio, string>> = {
  "1k": {
    "1:1": "1024x1024",
    "16:9": "1024x576",
    "9:16": "576x1024",
    "4:3": "1024x768",
  },
  "2k": {
    "1:1": "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "4:3": "2048x1536",
  },
  "4k": {
    "1:1": "4096x4096",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "4:3": "3840x2880",
  },
};
const MIN_GENERATION_COUNT = 1;
const MAX_GENERATION_COUNT = 10;
const MAX_REFERENCE_IMAGES = 16;
const HISTORY_VIEW_STORAGE_KEY = "azt:generate-history-view";

function archivePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

function archiveTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function recoverHistoryReferenceUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^data:image\//i.test(normalized)) return normalized;

  const localImagePrefix = "/_gateway/generations/images/";
  try {
    const parsed = new URL(normalized, window.location.origin);
    if (parsed.pathname.startsWith(localImagePrefix)) {
      return new URL(`${parsed.pathname}${parsed.search}`, window.location.origin).toString();
    }
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const promptExamples: Array<{ key: string; label: string; ratio: ImageRatio; prompt: string }> = [
  {
    key: "beauty",
    label: "美女",
    ratio: "9:16",
    prompt:
      "生成一张9:16写实电影生活剧照感人像照片，主体是一位20-26岁年轻成年东方女性，气质自然清爽，柔光CCD风，校园林荫道背景，白色短袖衬衫搭配格纹百褶裙，真实生活抓拍感，肤色自然，五官柔和，微笑，浅景深，画面干净，高级但不夸张。",
  },
  {
    key: "landscape",
    label: "风景",
    ratio: "16:9",
    prompt:
      "生成一张16:9自然风景摄影，清晨山谷与湖面，远处雪山被金色日出照亮，湖面有轻雾和倒影，前景有野花与岩石，真实摄影质感，空气通透，色彩自然，高动态范围，构图开阔。",
  },
  {
    key: "animal",
    label: "漫画动物",
    ratio: "1:1",
    prompt:
      "生成一只1:1可爱漫画风小动物，圆滚滚的小柴犬坐在柔软草地上，戴小红围巾，大眼睛，表情开心，暖色阳光，干净背景，柔和线条，儿童绘本质感，高细节，可爱治愈。",
  },
  {
    key: "ppt",
    label: "PPT",
    ratio: "16:9",
    prompt:
      "生成一张16:9商务PPT封面视觉图，主题是人工智能驱动的企业增长，深色科技背景，中心有抽象数据网络与发光节点，留出左侧标题区域，整体高级简洁，适合演示文稿首页，清晰、专业、现代。",
  },
];

function formatGenerateElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function normalizeGenerationCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return MIN_GENERATION_COUNT;
  }
  return Math.min(MAX_GENERATION_COUNT, Math.max(MIN_GENERATION_COUNT, parsed));
}

function sizeForPreset(ratio: ImageRatio, preset: ResolutionPreset): string | null {
  return preset === "custom" ? null : resolutionSizes[preset][ratio];
}

function isResolutionPresetDisabled(preset: ResolutionPreset): boolean {
  return resolutionOptions.some((item) => item.preset === preset && item.disabled);
}

function customSizeValid(value: string): boolean {
  return /^\d{2,5}x\d{2,5}$/i.test(value.trim());
}

function ratioFromSize(size?: string): ImageRatio | null {
  const normalized = size?.trim();
  const match = normalized?.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    return null;
  }
  const value = width / height;
  const scored = ratioOptions.map((item) => {
    const [ratioWidth, ratioHeight] = item.ratio.split(":").map(Number);
    return {
      ratio: item.ratio,
      diff: Math.abs(value - ratioWidth / ratioHeight),
    };
  }).sort((left, right) => left.diff - right.diff);
  return scored[0]?.diff < 0.02 ? scored[0].ratio : null;
}

function presetFromSize(size?: string): ResolutionPreset | null {
  const normalized = size?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  for (const option of resolutionOptions) {
    if (option.preset === "custom") {
      continue;
    }
    if (Object.values(resolutionSizes[option.preset]).some((item) => item.toLowerCase() === normalized)) {
      return option.preset;
    }
  }
  return null;
}

function isImageRatio(value?: string): value is ImageRatio {
  return ratioOptions.some((item) => item.ratio === value);
}

function percentLabel(value: number): string {  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${value.toFixed(value >= 99.95 || value < 10 ? 1 : 0)}%`;
}

function normalizePromptKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanSuggestionText(value: string): string {
  return value
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSuggestionText(payload: unknown, parts: string[]): void {
  if (typeof payload === "string") {
    parts.push(payload);
    return;
  }
  if (!isRecord(payload)) {
    return;
  }

  const keys = ["message", "upstreamText", "output_text_preview", "text", "raw"];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }

  if (isRecord(payload.error)) {
    collectSuggestionText(payload.error, parts);
  }
  if (isRecord(payload.imageDebug)) {
    collectSuggestionText(payload.imageDebug, parts);
  }
  if (isRecord(payload.debug)) {
    collectSuggestionText(payload.debug, parts);
  }
  if (isRecord(payload.parseFailure)) {
    collectSuggestionText(payload.parseFailure, parts);
  }
  if (isRecord(payload.responseSummary)) {
    collectSuggestionText(payload.responseSummary, parts);
  }
}

function candidateFromText(text: string): string | null {
  const normalized = text.replace(/\\n/g, "\n").replace(/\r/g, "\n");
  const directVersionMatch = normalized.match(/(?:我可以直接生成这个版本|可以直接生成这个版本|直接按这个[^“"]*)[：:]\s*([\s\S]+)/);
  if (directVersionMatch?.[1]) {
    return cleanSuggestionText(directVersionMatch[1]);
  }

  const quotedMatches = Array.from(normalized.matchAll(/(?:改成|修改为|替换为|生成这个版本|生成)[：:]\s*[“"]([\s\S]{40,}?)[”"]/g));
  const lastQuoted = quotedMatches.at(-1)?.[1];
  if (lastQuoted) {
    return cleanSuggestionText(lastQuoted);
  }

  const numberedMatch = normalized.match(/(?:改成|修改为|可以帮你改成)[：:]\s*([\s\S]+)/);
  if (numberedMatch?.[1]) {
    return cleanSuggestionText(numberedMatch[1]);
  }

  return null;
}

function extractPromptSuggestion(payload: unknown): PromptSuggestion | null {
  const parts: string[] = [];
  collectSuggestionText(payload, parts);
  const text = parts.join("\n");
  if (!/(不能|无法|抱歉|对抗|公众人物|真实公众人物|可以.*改成|替换为|直接生成这个版本)/.test(text)) {
    return null;
  }

  const prompt = candidateFromText(text);
  if (!prompt || prompt.length < 24) {
    return null;
  }

  return {
    title: "上游给出了可采纳方案",
    prompt,
    source: /上游未返回图片|parseFailure|imageDebug/.test(text) ? "parse-failure" : "upstream-policy",
  };
}

function formatReportBucketLabel(value: number, bucketMs: number): string {
  const date = new Date(value);
  if (bucketMs >= 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" }).format(date);
}

function buildLinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片预览生成失败。"));
    image.src = src;
  });
}

async function createReferencePreview(src: string, originalSize: number): Promise<string> {
  const targetBytes = Math.max(24 * 1024, Math.min(1024 * 1024, Math.floor(originalSize / 10)));
  if (originalSize > 0 && originalSize <= targetBytes) {
    return src;
  }

  try {
    const image = await loadImage(src);
    const canvas = document.createElement("canvas");
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    let scale = Math.min(1, Math.sqrt(targetBytes / Math.max(1, originalSize)));
    let quality = 0.78;
    let preview = src;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nextLongestSide = Math.max(160, Math.round(longestSide * scale));
      const ratio = nextLongestSide / longestSide;
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext("2d");
      if (!context) return src;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      preview = canvas.toDataURL("image/webp", quality);
      const approxBytes = Math.floor((preview.length * 3) / 4);
      if (approxBytes <= targetBytes) {
        return preview;
      }
      scale *= 0.72;
      quality = Math.max(0.32, quality - 0.08);
    }
    return preview;
  } catch {
    return src;
  }
}

function HistoryOwnerSelect(props: {
  options: HistoryOwnerOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleOptions = normalizedQuery
    ? props.options
        .filter((option) => option.kind === "user" && option.searchText.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
        .slice(0, 100)
    : props.options.filter((option) => option.kind !== "user" || option.count > 0 || option.value === props.value);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function selectOption(option: HistoryOwnerOption) {
    props.onChange(option.value);
    setOpen(false);
    setQuery("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div
      className="history-owner-select"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        className={`control history-owner-trigger ${open ? "is-open" : ""}`}
        type="button"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="history-owner-options"
        aria-label={`用户范围：${selected?.label ?? "我的数据"}，${selected?.count ?? 0} 次`}
        onClick={() => {
          setOpen((value) => !value);
          setQuery("");
        }}
      >
        <span className="history-owner-trigger-copy">
          <strong>{selected?.label ?? "我的数据"}</strong>
          <small>{selected?.count ?? 0} 次</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="history-owner-menu">
          <div className="history-owner-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                } else if (event.key === "Enter" && visibleOptions.length === 1 && visibleOptions[0]) {
                  event.preventDefault();
                  selectOption(visibleOptions[0]);
                }
              }}
              placeholder="搜索姓名或账号"
              aria-label="搜索用户"
            />
          </div>
          <div className="history-owner-options" id="history-owner-options" role="listbox" ref={menuRef} aria-label="用户范围">
            {visibleOptions.length > 0 ? visibleOptions.map((option) => (
              <button
                className={`history-owner-option ${option.value === props.value ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                key={`${option.kind}:${option.value}`}
                onClick={() => selectOption(option)}
              >
                <Check size={16} aria-hidden="true" />
                <span>
                  <strong>{option.label}</strong>
                  {option.kind === "user" ? <small>{option.value}</small> : null}
                </span>
                <em>{option.count} 次</em>
              </button>
            )) : (
              <div className="history-owner-empty">没有匹配的用户</div>
            )}
          </div>
          {!normalizedQuery ? <div className="history-owner-hint">搜索可查看其他暂无使用记录的用户</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function HistoryCardActions(props: {
  item: GenerateHistoryItem;
  copied: boolean;
  hint: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => string | undefined;
  onAction: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => void;
}) {
  const { item, hint } = props;
  const failed = Boolean(failureSummary(item.error));
  const entries: Array<{ key: HistoryMenuActionKey; label: string; icon: typeof Pencil; hint?: string }> = failed
    ? [
        { key: "retry" as const, label: "重试", icon: RotateCcw, hint: hint("retry", item) },
        { key: "reuse" as const, label: "再次使用", icon: RotateCcw },
        { key: "copy" as const, label: props.copied ? "已复制" : "复制提示词", icon: Copy },
        { key: "detail" as const, label: "查看详情", icon: Images },
      ]
    : [
        { key: "edit" as const, label: "编辑首张", icon: Pencil, hint: hint("edit", item) },
        { key: "reuse" as const, label: "再次使用", icon: RotateCcw },
        { key: "copy" as const, label: props.copied ? "已复制" : "复制提示词", icon: Copy },
        { key: "download" as const, label: item.images.length > 1 ? `下载全部（${item.images.length} 张）` : "下载图片", icon: Download, hint: hint("download", item) },
        { key: "detail" as const, label: "查看详情", icon: Images },
      ];

  return (
    <div className="generate-history-card-actions">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            className={entry.key === "retry" ? "btn-primary" : "btn-secondary"}
            type="button"
            key={entry.key}
            onClick={() => props.onAction(entry.key, item)}
            disabled={Boolean(entry.hint)}
            title={entry.hint ?? entry.label}
          >
            <Icon size={15} aria-hidden="true" />
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

export function GeneratePage(props: {
  config: AdminConfig | null;
  currentUser: string | null;
  role: UserRole;
  busy: BusyAction;
  showEmails: boolean;
  setBusy: (value: BusyAction) => void;
  setStatus: (value: string) => void;
  setRequestLogs: (value: SetStateAction<RequestLog[]>) => void;
  refreshConfig: (options?: { runtime?: boolean; silent?: boolean }) => Promise<AdminConfig>;
  setPreviewImage: (value: ModalImage | null) => void;
}) {
  const [tab, setTab] = useState<GenerateTab>("create");
  const [prompt, setPrompt] = useState("生成一张白底红苹果商品图，构图简洁，光线干净。");
  const [ratio, setRatio] = useState<ImageRatio>(DEFAULT_IMAGE_RATIO);
  const [resolutionPreset, setResolutionPreset] = useState<ResolutionPreset>(DEFAULT_RESOLUTION_PRESET);
  const [customSize, setCustomSize] = useState(sizeForPreset(DEFAULT_IMAGE_RATIO, DEFAULT_RESOLUTION_PRESET) ?? "1024x576");
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [generationCount, setGenerationCount] = useState("1");
  const [referenceImages, setReferenceImages] = useState<ReferenceImageState[]>([]);
  const [resultImages, setResultImages] = useState<PreviewImage[]>([]);
  const [responseBody, setResponseBody] = useState("生成结果会显示在这里。");
  const [history, setHistory] = useState<GenerateHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyFilters, setHistoryFilters] = useState<GenerationHistoryFilterState>({ ...EMPTY_HISTORY_FILTERS });
  const [reportFilters, setReportFilters] = useState<GenerationHistoryFilterState>({ ...EMPTY_HISTORY_FILTERS });
  const [historyOwnerUsage, setHistoryOwnerUsage] = useState<GenerationOwnerUsageResponse>({ items: [], total: 0 });
  const [historyReloadToken, setHistoryReloadToken] = useState(0);
  const [historyDetailItem, setHistoryDetailItem] = useState<GenerateHistoryItem | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const [historyPickerItems, setHistoryPickerItems] = useState<GenerateHistoryItem[]>([]);
  const [historyPickerLoading, setHistoryPickerLoading] = useState(false);
  const [historyPickerPage, setHistoryPickerPage] = useState(1);
  const [historyPickerTotal, setHistoryPickerTotal] = useState(0);
  const [historyPickerTotalPages, setHistoryPickerTotalPages] = useState(1);
  const [historyPickerQuery, setHistoryPickerQuery] = useState("");
  const [historyPickerSelected, setHistoryPickerSelected] = useState<Map<string, ReferenceImageState>>(() => new Map());
  const [historyPickerMessage, setHistoryPickerMessage] = useState<string | null>(null);
  const [historyViewMode, setHistoryViewMode] = useState<HistoryViewMode>(() => {
    try {
      return window.localStorage.getItem(HISTORY_VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [selectedHistoryItems, setSelectedHistoryItems] = useState<Map<string, GenerateHistoryItem>>(() => new Map());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [report, setReport] = useState<GenerateReportResponse>(EMPTY_GENERATE_REPORT);
  const [reportLoading, setReportLoading] = useState(false);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [manualCopyPrompt, setManualCopyPrompt] = useState<string | null>(null);
  const [pendingJobs, setPendingJobs] = useState<PendingGenerationJob[]>([]);
  const [pendingJobsNow, setPendingJobsNow] = useState(() => Date.now());
  const [submittingGeneration, setSubmittingGeneration] = useState(false);
  const [promptSuggestion, setPromptSuggestion] = useState<PromptSuggestion | null>(null);
  const submittingGenerationRef = useRef(false);
  const pendingJobsRuntime = useRef<{
    pendingJobs: PendingGenerationJob[];
    refreshHistory: (options?: { silent?: boolean }) => Promise<void>;
    refreshConfig: (options?: { runtime?: boolean; silent?: boolean }) => Promise<AdminConfig>;
    setStatus: (value: string) => void;
  }>({
    pendingJobs: [],
    refreshHistory: async () => undefined,
    refreshConfig: props.refreshConfig,
    setStatus: props.setStatus,
  });
  const hasPendingJobs = pendingJobs.length > 0;

  const selectedSize = useMemo(() => {
    const presetSize = sizeForPreset(ratio, resolutionPreset);
    return presetSize ?? customSize.trim();
  }, [customSize, ratio, resolutionPreset]);
  const selectedSizeValid = resolutionPreset !== "custom" || customSizeValid(customSize);
  const latestResultSize = useMemo(() => {
    const first = resultImages[0];
    return first?.width && first.height ? `${first.width}×${first.height}` : selectedSize;
  }, [resultImages, selectedSize]);
  const endpoint = referenceImages.length > 0 ? "/v1/images/edits" : "/v1/images/generations";
  const referenceSummary = referenceImages.length > 0
    ? `${referenceImages.length}/${MAX_REFERENCE_IMAGES} 张参考图 · ${(referenceImages.reduce((sum, image) => sum + image.size, 0) / 1024).toFixed(1)} KB`
    : `可选，最多 ${MAX_REFERENCE_IMAGES} 张，上传后走图片编辑接口`;
  const duplicatePendingJob = pendingJobs.some((job) => job.endpoint === endpoint && job.prompt === prompt.trim());
  const canGenerate = Boolean(props.config?.profile) && prompt.trim().length > 0 && selectedSizeValid && !submittingGeneration && !duplicatePendingJob && props.busy !== "prompt-optimize";
  const canOptimizePrompt = Boolean(props.config?.profile) && prompt.trim().length > 0 && selectedSizeValid && props.busy !== "test" && props.busy !== "prompt-optimize";
  const historyRange = useMemo(
    () => parseHistoryTimeRange(historyFilters.startTime, historyFilters.endTime),
    [historyFilters.endTime, historyFilters.startTime],
  );
  const selectableHistory = useMemo(() => history.filter((item) => item.status === "success" && item.images.length > 0), [history]);
  const selectedHistory = useMemo(() => Array.from(selectedHistoryItems.values()), [selectedHistoryItems]);
  const selectedCurrentPageCount = useMemo(() => selectableHistory.filter((item) => selectedHistoryItems.has(item.id)).length, [selectableHistory, selectedHistoryItems]);
  const selectedHistoryImageCount = useMemo(() => selectedHistory.reduce((total, item) => total + item.images.length, 0), [selectedHistory]);
  const allSelectableHistorySelected = selectableHistory.length > 0 && selectedCurrentPageCount === selectableHistory.length;
  const someSelectableHistorySelected = selectedCurrentPageCount > 0 && !allSelectableHistorySelected;
  const canGoPreviousHistoryPage = historyPage > 1 && !historyLoading;
  const canGoNextHistoryPage = historyPage < historyTotalPages && !historyLoading;
  const historyFilterTotal = useMemo(() => historyFilterCount(historyFilters), [historyFilters]);
  const reportFilterTotal = useMemo(() => historyFilterCount(reportFilters), [reportFilters]);
  const historyPendingPromptIds = useMemo(
    () => new Set(pendingJobs.map((job) => normalizePromptKey(job.prompt))),
    [pendingJobs],
  );
  const historyPickerRoom = Math.max(0, MAX_REFERENCE_IMAGES - referenceImages.length);
  const historyPickerCandidates = useMemo(() => {
    const existingSources = new Set(referenceImages.flatMap((image) => [image.src, image.previewSrc]));
    return historyPickerItems.flatMap((item) => item.images.flatMap((image, imageIndex) => {
      const originalUrl = recoverHistoryReferenceUrl(image.url || "");
      const previewUrl = recoverHistoryReferenceUrl(image.previewUrl || "");
      const src = originalUrl || previewUrl;
      if (!src) return [];
      const previewSrc = previewUrl || src;
      return [{
        key: `${item.id}:${imageIndex}`,
        item,
        image,
        imageIndex,
        src,
        previewSrc,
        alreadyAdded: existingSources.has(src) || existingSources.has(previewSrc),
      }];
    }));
  }, [historyPickerItems, referenceImages]);
  const historyPickerScopeLabel = props.role !== "admin" || !historyFilters.owner
    ? "我的历史"
    : historyFilters.owner === "all"
      ? "全部用户"
      : userDisplayName(props.config, historyFilters.owner);
  const historyOwnerOptions = useMemo(() => {
    const usageByOwner = new Map(historyOwnerUsage.items.map((item) => [item.owner, item.count]));
    const names = new Set<string>();
    for (const user of props.config?.users ?? []) {
      names.add(user.username);
    }
    for (const item of historyOwnerUsage.items) {
      names.add(item.owner);
    }
    for (const item of history) {
      if (item.owner) {
        names.add(item.owner);
      }
    }
    if (historyFilters.owner && historyFilters.owner !== "all") {
      names.add(historyFilters.owner);
    }
    if (props.currentUser) {
      names.delete(props.currentUser);
    }
    const userOptions: HistoryOwnerOption[] = Array.from(names)
      .map((owner) => {
        const label = userDisplayName(props.config, owner);
        return {
          value: owner,
          label,
          searchText: `${label} ${owner}`,
          count: usageByOwner.get(owner) ?? 0,
          kind: "user" as const,
        };
      })
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
    return [
      {
        value: "",
        label: "我的数据",
        searchText: "我的数据",
        count: props.currentUser ? usageByOwner.get(props.currentUser) ?? 0 : 0,
        kind: "mine" as const,
      },
      {
        value: "all",
        label: "全部用户",
        searchText: "全部用户",
        count: historyOwnerUsage.total,
        kind: "all" as const,
      },
      ...userOptions,
    ];
  }, [history, historyFilters.owner, historyOwnerUsage, props.config, props.currentUser]);

  const updateHistoryFilters = useCallback((patch: Partial<GenerationHistoryFilterState>) => {
    setHistoryFilters((current) => ({ ...current, ...patch }));
    setHistoryPage(1);
  }, []);

  const resetHistoryFilters = useCallback(() => {
    setHistoryFilters({ ...EMPTY_HISTORY_FILTERS });
    setHistoryPage(1);
  }, []);

  const historyActionHint = useCallback((key: HistoryMenuActionKey, item: GenerateHistoryItem): string | undefined => {
    if (bulkDownloading) {
      return "正在打包下载，请稍候";
    }
    switch (key) {
      case "edit":
        return item.images.length === 0 ? "这条历史没有可编辑的生成图" : undefined;
      case "download":
        return item.images.length === 0 ? "这条历史没有可下载的生成图" : undefined;
      case "retry": {
        const summary = failureSummary(item.error);
        if (!summary) {
          return "只有失败或已中断的记录可以重试";
        }
        if (!props.config?.profile) {
          return "当前没有可用账号，无法重试";
        }
        if (historyPendingPromptIds.has(normalizePromptKey(item.prompt))) {
          return "相同提示词的任务仍在队列中";
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }, [bulkDownloading, historyPendingPromptIds, props.config?.profile]);

  const renderHistoryFilters = () => (
    <div className="generate-history-filters">
      <label className="field history-search-field">
        <span>提示词</span>
        <div className="history-search-control">
          <Search size={16} aria-hidden="true" />
          <input
            className="control"
            type="search"
            placeholder="检索提示词"
            value={historyFilters.query}
            onChange={(event) => updateHistoryFilters({ query: event.target.value })}
          />
        </div>
      </label>
      <label className="field">
        <span>开始时间</span>
        <input
          className="control"
          type="datetime-local"
          value={historyFilters.startTime}
          max={historyFilters.endTime || undefined}
          onChange={(event) => updateHistoryFilters({ startTime: event.target.value })}
        />
      </label>
      <label className="field">
        <span>结束时间</span>
        <input
          className="control"
          type="datetime-local"
          value={historyFilters.endTime}
          min={historyFilters.startTime || undefined}
          onChange={(event) => updateHistoryFilters({ endTime: event.target.value })}
        />
      </label>
      <label className="field">
        <span>状态</span>
        <select
          className="control"
          value={historyFilters.status}
          onChange={(event) => updateHistoryFilters({ status: event.target.value as HistoryStatusFilter })}
        >
          {(Object.keys(HISTORY_STATUS_FILTER_LABELS) as HistoryStatusFilter[]).map((value) => (
            <option value={value} key={value}>{HISTORY_STATUS_FILTER_LABELS[value]}</option>
          ))}
        </select>
      </label>
      {props.role === "admin" ? (
        <label className="field">
          <span>用户范围</span>
          <HistoryOwnerSelect options={historyOwnerOptions} value={historyFilters.owner} onChange={(value) => updateHistoryFilters({ owner: value })} />
        </label>
      ) : null}
      <button
        className="btn-secondary history-filter-reset"
        type="button"
        onClick={resetHistoryFilters}
        disabled={historyFilterTotal === 0}
        title={historyFilterTotal === 0 ? "没有可重置的筛选条件" : "清除提示词、时间、状态和用户范围"}
      >
        <RotateCcw size={16} aria-hidden="true" />
        重置{historyFilterTotal > 0 ? `（${historyFilterTotal}）` : ""}
      </button>
      {historyRange.invalid ? (
        <p className="generate-history-filter-error" role="status">
          时间范围无效，请确认开始时间早于结束时间。
        </p>
      ) : null}
    </div>
  );

  const renderHistoryPager = (position: "top" | "bottom") => (
    <div className="generate-history-pager" aria-label={`生图历史分页（${position === "top" ? "顶部" : "底部"}）`}>
      <button
        className="btn-secondary"
        type="button"
        onClick={() => setHistoryPage((value) => Math.max(1, value - 1))}
        disabled={!canGoPreviousHistoryPage}
        aria-label="上一页"
      >
        上一页
      </button>
      <span aria-live="polite">
        第 {historyPage} / {historyTotalPages} 页 · 每页 {GENERATE_HISTORY_PAGE_SIZE} 条 · 共 {historyTotal} 条
      </span>
      <button
        className="btn-secondary"
        type="button"
        onClick={() => setHistoryPage((value) => Math.min(historyTotalPages, value + 1))}
        disabled={!canGoNextHistoryPage}
        aria-label="下一页"
      >
        下一页
      </button>
    </div>
  );

  const renderReportFilters = () => (
    <div className="generate-report-filters">
      <label className="field">
        <span>开始时间</span>
        <input
          className="control"
          type="datetime-local"
          value={reportFilters.startTime}
          max={reportFilters.endTime || undefined}
          onChange={(event) => setReportFilters((current) => ({ ...current, startTime: event.target.value }))}
        />
      </label>
      <label className="field">
        <span>结束时间</span>
        <input
          className="control"
          type="datetime-local"
          value={reportFilters.endTime}
          min={reportFilters.startTime || undefined}
          onChange={(event) => setReportFilters((current) => ({ ...current, endTime: event.target.value }))}
        />
      </label>
      {props.role === "admin" ? (
        <label className="field">
          <span>用户范围</span>
          <HistoryOwnerSelect
            options={historyOwnerOptions}
            value={reportFilters.owner}
            onChange={(value) => setReportFilters((current) => ({ ...current, owner: value }))}
          />
        </label>
      ) : null}
      <button
        className="btn-secondary generate-report-filter-reset"
        type="button"
        onClick={() => setReportFilters((current) => ({ ...current, startTime: "", endTime: "", owner: "" }))}
        disabled={reportFilterTotal === 0}
        title={reportFilterTotal === 0 ? "没有可重置的筛选条件" : "清除时间范围和用户范围"}
      >
        <RotateCcw size={16} aria-hidden="true" />
        重置{reportFilterTotal > 0 ? `（${reportFilterTotal}）` : ""}
      </button>
    </div>
  );

  const renderReportChart = () => {
    const buckets = report.buckets;
    if (buckets.length === 0) {
      return (
        <div className="generate-report-empty">
          <BarChart3 size={30} />
          <span>暂无可统计的生图记录。</span>
        </div>
      );
    }

    const width = 900;
    const height = 300;
    const padding = { top: 26, right: 48, bottom: 52, left: 44 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxVolume = Math.max(1, ...buckets.flatMap((bucket) => [bucket.requestCount, bucket.imageCount]));
    const maxUsers = Math.max(1, ...buckets.map((bucket) => bucket.activeUserCount));
    const slotWidth = chartWidth / buckets.length;
    const barWidth = Math.max(5, Math.min(18, slotWidth * 0.28));
    const points = buckets.map((bucket, index) => {
      const x = padding.left + slotWidth * index + slotWidth / 2;
      const y = padding.top + chartHeight - (bucket.activeUserCount / maxUsers) * chartHeight;
      return { x, y };
    });

    return (
      <div className="generate-report-chart" role="img" aria-label="生图次数、生成图片数和活跃人员趋势">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
          <line className="chart-axis" x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + chartHeight} />
          <line className="chart-axis" x1={padding.left} y1={padding.top + chartHeight} x2={width - padding.right} y2={padding.top + chartHeight} />
          {[0.25, 0.5, 0.75, 1].map((value) => {
            const y = padding.top + chartHeight - value * chartHeight;
            return <line className="chart-grid-line" key={value} x1={padding.left} y1={y} x2={width - padding.right} y2={y} />;
          })}
          {buckets.map((bucket, index) => {
            const centerX = padding.left + slotWidth * index + slotWidth / 2;
            const requestHeight = (bucket.requestCount / maxVolume) * chartHeight;
            const imageHeight = (bucket.imageCount / maxVolume) * chartHeight;
            const label = formatReportBucketLabel(bucket.startTime, report.bucketMs);
            return (
              <g key={bucket.startTime}>
                <title>{`${label}：${bucket.requestCount} 次，${bucket.imageCount} 张，${bucket.activeUserCount} 人`}</title>
                <rect className="chart-bar chart-bar-requests" x={centerX - barWidth - 1} y={padding.top + chartHeight - requestHeight} width={barWidth} height={Math.max(2, requestHeight)} rx="3" />
                <rect className="chart-bar chart-bar-images" x={centerX + 1} y={padding.top + chartHeight - imageHeight} width={barWidth} height={Math.max(2, imageHeight)} rx="3" />
                <text className="chart-x-label" x={centerX} y={height - 18} textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}
          <path className="chart-line" d={buildLinePath(points)} />
          {points.map((point, index) => (
            <circle className="chart-line-point" key={buckets[index]?.startTime} cx={point.x} cy={point.y} r="4" />
          ))}
          <text className="chart-scale-label" x={padding.left} y={16}>次数 / 图片</text>
          <text className="chart-scale-label" x={width - padding.right} y={16} textAnchor="end">活跃人员</text>
        </svg>
        <div className="generate-report-bucket-list" aria-label="图表数据明细">
          {buckets.map((bucket) => (
            <div className="generate-report-bucket" key={bucket.startTime}>
              <strong>{formatReportBucketLabel(bucket.startTime, report.bucketMs)}</strong>
              <span>{bucket.requestCount} 次 · {bucket.imageCount} 张 · {bucket.activeUserCount} 人</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  function buildHistoryParams(limit: number, page: number, filters: GenerationHistoryFilterState, options?: { status?: string }): URLSearchParams {
    const params = new URLSearchParams({
      limit: String(limit),
      page: String(page),
      light: "true",
    });
    if (props.role === "admin" && filters.owner) {
      params.set("owner", filters.owner);
    }
    if (filters.query.trim()) {
      params.set("query", filters.query.trim());
    }
    const status = options?.status ?? (filters.status === "all" ? undefined : filters.status);
    if (status) {
      params.set("status", status);
    }
    const range = parseHistoryTimeRange(filters.startTime, filters.endTime);
    if (range.invalid) {
      throw new Error("时间范围无效，请确认开始时间早于结束时间。");
    }
    if (range.startTime !== undefined) {
      params.set("startTime", String(range.startTime));
    }
    if (range.endTime !== undefined) {
      params.set("endTime", String(range.endTime));
    }
    return params;
  }

  const refreshHistory = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setHistoryLoading(true);
    }
    try {
      const params = buildHistoryParams(GENERATE_HISTORY_PAGE_SIZE, historyPage, historyFilters);
      const [next, nextOwnerUsage] = await Promise.all([
        fetchJson<GenerateHistoryResponse>(`/_gateway/generations/history?${params.toString()}`),
        props.role === "admin"
          ? fetchJson<GenerationOwnerUsageResponse>("/_gateway/generations/history/owners")
          : Promise.resolve(null),
      ]);
      setHistory(next.items);
      if (nextOwnerUsage) {
        setHistoryOwnerUsage(nextOwnerUsage);
      }
      const nextTotal = next.total ?? next.items.length;
      setHistoryTotal(nextTotal);
      const nextTotalPages = next.totalPages ?? Math.max(1, Math.ceil(nextTotal / GENERATE_HISTORY_PAGE_SIZE));
      setHistoryTotalPages(nextTotalPages);
      if (historyPage > nextTotalPages) {
        setHistoryPage(nextTotalPages);
      }
    } catch (error) {
      if (!options?.silent) {
        props.setStatus(`读取生图历史失败：${errorMessage(error)}`);
      }
    } finally {
      if (!options?.silent) {
        setHistoryLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFilters, historyPage, props.role, props.setStatus]);

  async function refreshReport(options?: { silent?: boolean }) {
    setReportLoading(true);
    try {
      const params = new URLSearchParams();
      if (props.role === "admin" && reportFilters.owner) {
        params.set("owner", reportFilters.owner);
      }
      const range = parseHistoryTimeRange(reportFilters.startTime, reportFilters.endTime);
      if (range.invalid) {
        throw new Error("时间范围无效，请确认开始时间早于结束时间。");
      }
      if (range.startTime !== undefined) params.set("startTime", String(range.startTime));
      if (range.endTime !== undefined) params.set("endTime", String(range.endTime));
      const query = params.size > 0 ? `?${params.toString()}` : "";
      setReport(await fetchJson<GenerateReportResponse>(`/_gateway/generations/report${query}`));
    } catch (error) {
      if (!options?.silent) {
        props.setStatus(`读取生图报表失败：${errorMessage(error)}`);
      }
    } finally {
      setReportLoading(false);
    }
  }

  function toggleReportOwnerFilter(owner: string) {
    if (props.role !== "admin" || reportLoading) {
      return;
    }
    setReportFilters((current) => ({ ...current, owner: current.owner === owner ? "all" : owner }));
  }

  useEffect(() => {
    if (historyRange.invalid) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      refreshHistory({ silent: true }).catch(() => undefined);
    }, historyFilters.query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [historyFilters, historyRange.invalid, historyPage, historyReloadToken, refreshHistory]);

  useEffect(() => {
    if (!historyPickerOpen) return undefined;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setHistoryPickerLoading(true);
      setHistoryPickerMessage(null);
      try {
        const params = new URLSearchParams({
          limit: String(HISTORY_REFERENCE_PAGE_SIZE),
          page: String(historyPickerPage),
          light: "true",
          status: "success",
        });
        if (props.role === "admin" && historyFilters.owner) {
          params.set("owner", historyFilters.owner);
        }
        if (historyPickerQuery.trim()) {
          params.set("query", historyPickerQuery.trim());
        }
        const next = await fetchJson<GenerateHistoryResponse>(`/_gateway/generations/history?${params.toString()}`, {
          signal: controller.signal,
        });
        setHistoryPickerItems(next.items.filter((item) => item.status === "success" && item.images.length > 0));
        setHistoryPickerTotal(next.total ?? next.items.length);
        const nextTotalPages = next.totalPages ?? Math.max(1, Math.ceil((next.total ?? next.items.length) / HISTORY_REFERENCE_PAGE_SIZE));
        setHistoryPickerTotalPages(nextTotalPages);
        if (historyPickerPage > nextTotalPages) {
          setHistoryPickerPage(nextTotalPages);
        }
      } catch (error) {
        if ((error as { name?: string }).name !== "AbortError") {
          setHistoryPickerItems([]);
          setHistoryPickerMessage(`读取生图历史失败：${errorMessage(error)}`);
        }
      } finally {
        if (!controller.signal.aborted) {
          setHistoryPickerLoading(false);
        }
      }
    }, historyPickerQuery.trim() ? 250 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [historyFilters.owner, historyPickerOpen, historyPickerPage, historyPickerQuery, props.role]);

  useEffect(() => {
    if (!historyPickerOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryPickerOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyPickerOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_VIEW_STORAGE_KEY, historyViewMode);
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
  }, [historyViewMode]);

  useEffect(() => {
    if (tab === "report") {
      refreshReport({ silent: true }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reportFilters]);

  useEffect(() => {
    pendingJobsRuntime.current = { pendingJobs, refreshHistory, refreshConfig: props.refreshConfig, setStatus: props.setStatus };
  });

  useEffect(() => {
    setPendingJobs([]);
    if (!props.currentUser) return undefined;
    const controller = new AbortController();
    void Promise.all(["queued", "running"].map((status) => fetchJson<GenerateHistoryResponse>(
      `/_gateway/generations/history?status=${status}&limit=100&light=false`,
      { signal: controller.signal },
    ))).then((responses) => {
      if (controller.signal.aborted) return;
      const restored = responses.flatMap((response) => response.items).flatMap((item): PendingGenerationJob[] => {
        if (item.status !== "queued" && item.status !== "running") return [];
        return [{
          id: item.id,
          submittedAt: item.createdAt,
          status: item.status,
          endpoint: item.endpoint,
          prompt: item.prompt,
          ratio: item.ratio || "auto",
          size: item.size || "自动尺寸",
          count: normalizeGenerationCount(String(item.request?.n ?? 1)),
          waitDurationMs: item.waitDurationMs,
          durationMs: item.durationMs,
        }];
      });
      setPendingJobs((current) => Array.from(new Map([...restored, ...current].map((job) => [job.id, job])).values())
        .sort((left, right) => right.submittedAt - left.submittedAt));
    }).catch((error) => {
      if (!controller.signal.aborted) pendingJobsRuntime.current.setStatus(`恢复生图队列失败：${errorMessage(error)}`);
    });
    return () => controller.abort();
  }, [props.currentUser]);

  useEffect(() => {
    if (!hasPendingJobs) return undefined;
    const timer = window.setInterval(() => setPendingJobsNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasPendingJobs]);

  useEffect(() => {
    if (!hasPendingJobs) return undefined;

    const controller = new AbortController();
    let timer: number | undefined;
    const refreshPendingJobs = async () => {
      await Promise.all(pendingJobsRuntime.current.pendingJobs.map(async (job) => {
        try {
          const result = await fetchJson<{ item: GenerateHistoryItem }>(`/_gateway/generations/history/${encodeURIComponent(job.id)}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const item = result.item;
          if (item.status === "queued" || item.status === "running") {
            setPendingJobs((items) => {
              const index = items.findIndex((current) => current.id === job.id);
              if (index < 0) return items;
              const current = items[index]!;
              const status = item.status === "queued" ? "queued" : "running";
              if (current.status === status && current.waitDurationMs === item.waitDurationMs && current.durationMs === item.durationMs && !current.pollError) {
                return items;
              }
              const next = [...items];
              next[index] = { ...current, status, waitDurationMs: item.waitDurationMs, durationMs: item.durationMs, pollError: undefined };
              return next;
            });
            return;
          }

          setPendingJobs((items) => items.filter((current) => current.id !== job.id));
          const runtime = pendingJobsRuntime.current;
          runtime.refreshHistory({ silent: true }).catch(() => undefined);
          if (item.status === "success") {
            const images = previewImagesFromHistory(item);
            setResultImages(images);
            setResponseBody(formatJson({ id: item.id, status: item.status, response: item.responseSummary, images: item.images.length }));
            setPromptSuggestion(null);
            runtime.setStatus(images.length > 0 ? `生图完成，耗时 ${formatDuration(item.durationMs)}。` : "生图完成，但没有可预览图片。");
            runtime.refreshConfig({ silent: true }).catch(() => undefined);
            return;
          }

          const suggestion = extractPromptSuggestion(item.error || "");
          setPromptSuggestion(suggestion);
          setResponseBody(formatJson({ id: item.id, status: item.status, error: item.error }));
          runtime.setStatus(suggestion ? "已提取上游给出的替代方案，可点击采纳。" : `生图失败：${item.error || "任务已中断。"}`);
        } catch (error) {
          if (controller.signal.aborted) return;
          const pollError = errorMessage(error);
          setPendingJobs((items) => items.map((current) => current.id === job.id ? { ...current, pollError } : current));
        }
      }));
      if (!controller.signal.aborted) timer = window.setTimeout(() => void refreshPendingJobs(), 2000);
    };

    void refreshPendingJobs();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hasPendingJobs, props.currentUser]);

  function toggleHistorySelection(item: GenerateHistoryItem) {
    setSelectedHistoryItems((current) => {
      const next = new Map(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.set(item.id, item);
      }
      return next;
    });
  }

  function toggleSelectAllHistory() {
    setSelectedHistoryItems((current) => {
      const next = new Map(current);
      for (const item of selectableHistory) {
        if (allSelectableHistorySelected) {
          next.delete(item.id);
        } else {
          next.set(item.id, item);
        }
      }
      return next;
    });
  }

  async function downloadSelectedHistoryImages() {
    if (bulkDownloading || selectedHistory.length === 0) return;

    setBulkDownloading(true);
    props.setStatus(`正在读取 ${selectedHistoryImageCount} 张原图并打包...`);
    try {
      const files = selectedHistory.flatMap((item) => item.images.map((image, imageIndex) => ({ item, image, imageIndex })));
      const entries: Record<string, Uint8Array> = {};
      const failures: string[] = [];
      let cursor = 0;

      const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
        while (cursor < files.length) {
          const file = files[cursor];
          cursor += 1;
          if (!file) continue;
          const taskId = archivePathSegment(file.item.id, "task");
          const filename = archivePathSegment(file.image.filename, `generated-${file.imageIndex + 1}.png`);
          const archivePath = `${taskId}-${String(file.imageIndex + 1).padStart(2, "0")}-${filename}`;
          try {
            const response = await fetch(file.image.url, { credentials: "include" });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            entries[archivePath] = new Uint8Array(await response.arrayBuffer());
          } catch (error) {
            failures.push(`${filename}（${errorMessage(error)}）`);
          }
        }
      });
      await Promise.all(workers);

      const downloadedCount = Object.keys(entries).length;
      if (downloadedCount === 0) {
        throw new Error(failures[0] || "没有可打包的图片");
      }

      const archive = zipSync(entries, { level: 0 });
      const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([archiveBuffer], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `生图历史-${archiveTimestamp()}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      props.setStatus(failures.length > 0
        ? `已打包 ${downloadedCount} 张原图，${failures.length} 张下载失败并已跳过。`
        : `已打包下载 ${downloadedCount} 张原图。`);
    } catch (error) {
      props.setStatus(`批量下载失败：${errorMessage(error)}`);
    } finally {
      setBulkDownloading(false);
    }
  }

  async function addReferenceFiles(files: File[], source: "upload" | "paste") {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      props.setStatus(source === "paste" ? "剪贴板中没有可用的图片。" : "请选择图片文件。");
      return;
    }
    const room = MAX_REFERENCE_IMAGES - referenceImages.length;
    if (room <= 0) {
      props.setStatus(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }

    const selected = imageFiles.slice(0, room);
    try {
      const nextImages = await Promise.all(selected.map(async (file, index) => {
        const src = await readFileAsDataUrl(file);
        return {
          id: createClientId("reference"),
          src,
          previewSrc: await createReferencePreview(src, file.size),
          name: file.name || `粘贴图片-${archiveTimestamp()}-${index + 1}.png`,
          size: file.size,
        };
      }));
      setReferenceImages((items) => [...items, ...nextImages]);
      const limitMessage = imageFiles.length > room ? `，已达到上限，仅添加前 ${room} 张` : "";
      props.setStatus(`已${source === "paste" ? "粘贴" : "添加"} ${nextImages.length} 张参考图${limitMessage}，本次将走 images.edits。`);
    } catch (error) {
      props.setStatus(errorMessage(error));
    }
  }

  async function handleReferenceUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    await addReferenceFiles(files, "upload");
  }

  function handleReferencePaste(event: ReactClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[];
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void addReferenceFiles(files, "paste");
  }

  function removeReferenceImage(id: string) {
    const next = referenceImages.filter((item) => item.id !== id);
    setReferenceImages(next);
    props.setStatus(next.length > 0 ? `已移除参考图，还剩 ${next.length} 张。` : "已移除参考图，本次将走 images.generations。");
  }

  function clearReferences() {
    setReferenceImages([]);
    props.setStatus("已移除参考图，本次将走 images.generations。");
  }

  function openHistoryPicker() {
    if (historyPickerRoom <= 0) {
      props.setStatus(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }
    setHistoryPickerPage(1);
    setHistoryPickerQuery("");
    setHistoryPickerSelected(new Map());
    setHistoryPickerMessage(null);
    setHistoryPickerOpen(true);
  }

  function toggleHistoryReference(key: string, image: ReferenceImageState, alreadyAdded: boolean) {
    if (alreadyAdded) return;
    if (!historyPickerSelected.has(key) && historyPickerSelected.size >= historyPickerRoom) {
      setHistoryPickerMessage(`当前还可添加 ${historyPickerRoom} 张参考图。`);
      return;
    }
    setHistoryPickerMessage(null);
    setHistoryPickerSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, image);
      return next;
    });
  }

  function addSelectedHistoryReferences() {
    const selected = Array.from(historyPickerSelected.values()).slice(0, historyPickerRoom);
    if (selected.length === 0) return;
    setReferenceImages((current) => [...current, ...selected]);
    setHistoryPickerOpen(false);
    setHistoryPickerSelected(new Map());
    props.setStatus(`已从生图历史添加 ${selected.length} 张参考图，本次将走 images.edits。`);
  }

  function applyPromptExample(example: (typeof promptExamples)[number]) {
    setPrompt(example.prompt);
    setRatio(example.ratio);
    if (resolutionPreset !== "custom") {
      setCustomSize(sizeForPreset(example.ratio, resolutionPreset) ?? customSize);
    }
    setReferenceImages([]);
    setPromptSuggestion(null);
    props.setStatus(`已填入${example.label}示例提示词。`);
  }

  function applyRatio(nextRatio: ImageRatio) {
    setRatio(nextRatio);
    if (resolutionPreset !== "custom") {
      setCustomSize(sizeForPreset(nextRatio, resolutionPreset) ?? customSize);
    }
  }

  function applyResolutionPreset(nextPreset: ResolutionPreset) {
    if (isResolutionPresetDisabled(nextPreset)) {
      props.setStatus(CODEX_NATIVE_RESOLUTION_NOTICE);
      return;
    }
    setResolutionPreset(nextPreset);
    const presetSize = sizeForPreset(ratio, nextPreset);
    if (presetSize) {
      setCustomSize(presetSize);
    }
  }

  function applyHistoryParameters(item: GenerateHistoryItem) {
    const nextRatio = isImageRatio(item.ratio) ? item.ratio : ratioFromSize(item.size) ?? DEFAULT_IMAGE_RATIO;
    const matchedPreset = presetFromSize(item.size);
    const nextPreset = matchedPreset && !isResolutionPresetDisabled(matchedPreset) ? matchedPreset : item.size && !matchedPreset ? "custom" : DEFAULT_RESOLUTION_PRESET;
    setRatio(nextRatio);
    setResolutionPreset(nextPreset);
    setCustomSize(nextPreset === "custom" ? item.size?.trim() || "1024x576" : sizeForPreset(nextRatio, nextPreset) || sizeForPreset(DEFAULT_IMAGE_RATIO, DEFAULT_RESOLUTION_PRESET) || "1024x576");
    setQuality(item.quality || DEFAULT_IMAGE_QUALITY);
    setOutputFormat(item.outputFormat || "png");
    if (matchedPreset && isResolutionPresetDisabled(matchedPreset)) {
      props.setStatus(`历史记录原尺寸为 ${item.size}，${CODEX_NATIVE_RESOLUTION_NOTICE}`);
    }
  }

  function acceptPromptSuggestion() {
    if (!promptSuggestion) {
      return;
    }
    setPrompt(promptSuggestion.prompt);
    setPromptSuggestion(null);
    setResultImages([]);
    props.setStatus("已采纳上游方案，可直接重新生图。");
  }

  async function optimizePrompt() {
    const originalPrompt = prompt.trim();
    if (!originalPrompt) {
      props.setStatus("请先输入提示词。");
      return;
    }

    props.setBusy("prompt-optimize");
    props.setStatus("正在优化提示词...");
    try {
      const optimizerSystemPrompt = props.config?.settings.image?.promptOptimizerSystemPrompt?.trim() || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT;
      const result = await fetchJson<ChatCompletionResponse>("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: formatJson({
          model: props.config?.settings.modelRouting?.promptOptimizerModel || props.config?.settings.defaultModel || "gpt-5.4",
          messages: [
            { role: "system", content: optimizerSystemPrompt },
            {
              role: "user",
              content: [
                `原始提示词：${originalPrompt}`,
                `目标比例：${ratio}`,
                `目标尺寸：${selectedSize}`,
                referenceImages.length > 0 ? `用户会携带 ${referenceImages.length} 张参考图，请强调参考图主体、风格和关键元素的一致性。` : "无参考图，请补足画面细节。",
              ].join("\n"),
            },
          ],
          temperature: 0.4,
          max_tokens: 700,
        }),
      });
      const optimized = result.choices?.[0]?.message?.content?.trim();
      if (!optimized) {
        props.setStatus("优化失败：模型没有返回提示词。");
        return;
      }
      setPrompt(optimized.replace(/^["'“”]+|["'“”]+$/g, "").trim());
      props.setStatus("提示词已优化，可直接生图。");
      props.refreshConfig({ silent: true }).catch(() => undefined);
    } catch (error) {
      props.setStatus(`优化失败：${errorMessage(error)}`);
    } finally {
      props.setBusy(null);
    }
  }

  async function runGenerate() {
    if (submittingGenerationRef.current) {
      props.setStatus("正在提交当前生图任务，请稍候。");
      return;
    }
    if (duplicatePendingJob) {
      props.setStatus("相同提示词的任务仍在队列中，请修改提示词或等待完成。");
      return;
    }
    if (!selectedSizeValid) {
      props.setStatus("自定义尺寸格式应为 宽x高，例如 2160x3840。");
      return;
    }
    submittingGenerationRef.current = true;
    setSubmittingGeneration(true);
    setPromptSuggestion(null);
    const imageCount = normalizeGenerationCount(generationCount);
    setGenerationCount(String(imageCount));
    try {
      const body = referenceImages.length > 0
        ? {
            model: props.config?.settings.modelRouting?.imageGenerationModel || "gpt-image-2",
            prompt: prompt.trim(),
            images: referenceImages.map((image) => ({ image_url: image.src })),
            n: imageCount,
            size: selectedSize,
            quality,
            output_format: outputFormat,
            response_format: "b64_json",
            _gateway_background: true,
          }
        : {
            model: props.config?.settings.modelRouting?.imageGenerationModel || "gpt-image-2",
            prompt: prompt.trim(),
            n: imageCount,
            size: selectedSize,
            quality,
            output_format: outputFormat,
            response_format: "b64_json",
            _gateway_background: true,
          };

      const result = await fetchJson<BackgroundGenerationResponse>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: formatJson(body),
      });
      if (!result.id || result.status !== "queued") {
        throw new Error("服务端未返回可跟踪的生图任务。");
      }
      const jobId = result.id;
      const submittedAt = Date.now();
      setPendingJobs((jobs) => [{
        id: jobId,
        submittedAt,
        status: "queued",
        endpoint,
        prompt: prompt.trim(),
        ratio,
        size: selectedSize,
        count: imageCount,
      }, ...jobs.filter((job) => job.id !== jobId)]);
      setResponseBody(formatJson({ id: result.id, status: "queued", history_url: result.history_url }));
      props.setRequestLogs((items) => [
        {
          id: jobId,
          time: submittedAt,
          method: "POST",
          endpoint,
          account: profileLabel(props.config?.profile, props.showEmails),
          model: props.config?.settings.modelRouting?.imageGenerationModel || "gpt-image-2",
          statusCode: 202,
          durationMs: 0,
          source: "生图工作台",
        },
        ...items,
      ].slice(0, 20));
      props.setStatus(`生图任务已加入队列，可继续提交下一项。`);
    } catch (error) {
      const message = errorMessage(error);
      const suggestion = extractPromptSuggestion(message);
      setPromptSuggestion(suggestion);
      setResponseBody(message);
      props.setStatus(suggestion ? "已提取上游给出的替代方案，可点击采纳。" : `生图失败：${message}`);
    } finally {
      submittingGenerationRef.current = false;
      setSubmittingGeneration(false);
    }
  }

  function reuseHistory(item: GenerateHistoryItem) {
    setPrompt(item.prompt);
    applyHistoryParameters(item);
    const restoredReferences = item.referenceImages
      .map((reference) => ({ reference, src: recoverHistoryReferenceUrl(reference.url || reference.source || "") }))
      .filter((entry): entry is { reference: GenerateHistoryItem["referenceImages"][number]; src: string } => Boolean(entry.src))
      .slice(0, MAX_REFERENCE_IMAGES)
      .map(({ reference, src }, index) => {
        return {
          id: createClientId(`history-reference-${index + 1}`),
          src,
          previewSrc: src,
          name: reference.name || `history-reference-${index + 1}`,
          size: 0,
        };
      });
    setReferenceImages(restoredReferences);
    setHistoryDetailItem(null);
    setTab("create");
    const skippedCount = Math.max(0, item.referenceImages.length - restoredReferences.length);
    props.setStatus(skippedCount > 0
      ? `已带入历史提示词和 ${restoredReferences.length} 张参考图，另有 ${skippedCount} 张旧参考图地址无法恢复并已跳过。`
      : `已带入历史提示词、参数${restoredReferences.length > 0 ? `和 ${restoredReferences.length} 张参考图` : ""}。`);
  }

  function editFromHistory(item: GenerateHistoryItem) {
    const image = item.images[0];
    if (!image) {
      props.setStatus("这条历史没有可编辑的生成图。");
      return;
    }

    const originalUrl = recoverHistoryReferenceUrl(image.url || "");
    const previewUrl = recoverHistoryReferenceUrl(image.previewUrl || "");
    const imageUrl = originalUrl || previewUrl;
    if (!imageUrl) {
      props.setStatus("这条历史的图片地址无法恢复，请重新上传参考图。");
      return;
    }
    setPrompt(item.prompt);
    applyHistoryParameters(item);
    setReferenceImages([{
      id: createClientId("history-image-reference"),
      src: imageUrl,
      previewSrc: previewUrl || imageUrl,
      name: image.filename || "history-image.png",
      size: image.size || image.previewSize || 0,
    }]);
    setResultImages([]);
    setResponseBody("已将历史图片作为参考图，本次会走 images.edits。");
    setHistoryDetailItem(null);
    setTab("create");
    props.setStatus(originalUrl
      ? "已将历史图片作为编辑参考图，提交时会由服务端读取原图。"
      : "历史原图不可用，已使用预览图作为编辑参考图。");
  }

  function copyHistoryPrompt(item: GenerateHistoryItem) {
    copyText(item.prompt)
      .then((ok) => {
        if (ok) {
          setCopiedPromptId(item.id);
          window.setTimeout(() => setCopiedPromptId((current) => (current === item.id ? null : current)), 1600);
          props.setStatus("提示词已复制。");
          return;
        }
        setManualCopyPrompt(item.prompt);
        props.setStatus("自动复制失败，已打开手动复制框。");
      })
      .catch(() => {
        setManualCopyPrompt(item.prompt);
        props.setStatus("自动复制失败，已打开手动复制框。");
      });
  }

  function downloadHistoryItem(item: GenerateHistoryItem) {
    if (item.images.length === 0) {
      props.setStatus("这条历史没有可下载的生成图。");
      return;
    }
    for (const image of item.images) {
      const link = document.createElement("a");
      link.href = image.url;
      link.download = image.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    props.setStatus(item.images.length > 1 ? `已开始下载 ${item.images.length} 张生成图。` : "已开始下载生成图。");
  }

  function retryHistoryItem(item: GenerateHistoryItem) {
    const hint = historyActionHint("retry", item);
    if (hint) {
      props.setStatus(hint);
      return;
    }
    setPrompt(item.prompt);
    applyHistoryParameters(item);
    setReferenceImages([]);
    setResultImages([]);
    setResponseBody("已带入失败记录的提示词和参数，可直接重新生图。");
    setHistoryDetailItem(null);
    setTab("create");
    props.setStatus("已带入原提示词和生成参数，点击生图即可重试。");
  }

  function runHistoryRowAction(key: HistoryMenuActionKey, item: GenerateHistoryItem) {
    if (key === "detail") {
      setHistoryDetailItem(item);
      return;
    }
    runHistoryAction(key, item, {
      busy: bulkDownloading,
      canRetry: !historyActionHint("retry", item),
      canEdit: !historyActionHint("edit", item),
      canReuse: true,
      canCopy: Boolean(item.prompt.trim()),
      canDownload: !historyActionHint("download", item),
      retryDisabledReason: historyActionHint("retry", item),
      onEdit: editFromHistory,
      onReuse: reuseHistory,
      onCopy: copyHistoryPrompt,
      onDownload: downloadHistoryItem,
      onRetry: retryHistoryItem,
      setStatus: props.setStatus,
    });
  }

  return (
    <section className="generate-page">
      {manualCopyPrompt ? (
        <div className="manual-copy-panel">
          <div>
            <strong>手动复制提示词</strong>
            <span>浏览器阻止了自动复制，请在这里全选复制。</span>
          </div>
          <textarea className="textarea" value={manualCopyPrompt} readOnly onFocus={(event) => event.currentTarget.select()} />
          <div className="manual-copy-actions">
            <button className="btn-secondary" type="button" onClick={() => setManualCopyPrompt(null)}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
      <div className="generate-toolbar">
        <div className="generate-tabs" role="tablist" aria-label="生图功能">
          <button className={`tab-btn ${tab === "create" ? "is-active" : ""}`} type="button" onClick={() => setTab("create")}>
            生图
          </button>
          <button className={`tab-btn ${tab === "history" ? "is-active" : ""}`} type="button" onClick={() => setTab("history")}>
            历史
          </button>
          <button className={`tab-btn ${tab === "report" ? "is-active" : ""}`} type="button" onClick={() => setTab("report")}>
            统计报表
          </button>
        </div>
        <span className="badge brand">{props.config?.profile ? "账号已就绪" : "未选择账号"}</span>
      </div>

      {tab === "create" ? (
        <div className="generate-workbench">
          <div className="generate-pane generate-form">
            <label className="field">
              <span className="generate-prompt-label">
                提示词
                <button className="btn-secondary prompt-optimize-btn" type="button" onClick={optimizePrompt} disabled={!canOptimizePrompt}>
                  {props.busy === "prompt-optimize" ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                  优化
                </button>
              </span>
              <textarea className="textarea generate-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} />
            </label>

            <div className="generate-control-grid">
              <label className="field">
                <span>比例</span>
                <div className="ratio-grid">
                  {ratioOptions.map((item) => (
                    <button className={`ratio-btn ${ratio === item.ratio ? "is-active" : ""}`} key={item.ratio} type="button" onClick={() => applyRatio(item.ratio)}>
                      <strong>{item.label}</strong>
                      <span>{sizeForPreset(item.ratio, resolutionPreset) ?? "自定义"}</span>
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>分辨率</span>
                <select className="control" value={resolutionPreset} onChange={(event) => applyResolutionPreset(event.target.value as ResolutionPreset)}>
                  {resolutionOptions.map((item) => (
                    <option key={item.preset} value={item.preset} disabled={item.disabled}>{item.reason ? `${item.label}（${item.reason}）` : item.label}</option>
                  ))}
                </select>
                <small className="field-hint">{CODEX_NATIVE_RESOLUTION_NOTICE}</small>
              </label>
              <label className="field custom-size-field">
                <span>尺寸</span>
                <input
                  className={`input ${selectedSizeValid ? "" : "is-invalid"}`}
                  disabled={resolutionPreset !== "custom"}
                  inputMode="numeric"
                  placeholder="2160x3840"
                  value={selectedSize}
                  onChange={(event) => setCustomSize(event.target.value)}
                />
              </label>
              <label className="field">
                <span>质量倾向</span>
                <select className="control" value={quality} onChange={(event) => setQuality(event.target.value as ImageQuality)}>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="auto">自动</option>
                </select>
                <small className="field-hint">Codex 通道可能由上游自动决定，质量档位不保证严格生效。</small>
              </label>
              <label className="field">
                <span>格式</span>
                <select className="control" value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}>
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
              <label className="field">
                <span>张数</span>
                <input
                  className="input"
                  inputMode="numeric"
                  min={MIN_GENERATION_COUNT}
                  max={MAX_GENERATION_COUNT}
                  type="number"
                  value={generationCount}
                  onBlur={() => setGenerationCount(String(normalizeGenerationCount(generationCount)))}
                  onChange={(event) => setGenerationCount(event.target.value)}
                />
              </label>
            </div>

            <details className="reference-panel" onPaste={handleReferencePaste}>
              <summary>
                <strong>参考图</strong>
                <span>{referenceSummary}</span>
              </summary>
              <div className="reference-paste-zone" tabIndex={0} onPaste={handleReferencePaste} aria-label="粘贴参考图片">
                <ClipboardPaste size={20} aria-hidden="true" />
                <div>
                  <strong>直接粘贴图片</strong>
                  <span>点击这里后按 Ctrl/Cmd+V，也可以选择本地图片</span>
                </div>
                <div className="reference-actions">
                  <button className="btn-secondary" type="button" onClick={openHistoryPicker} disabled={historyPickerRoom <= 0}>
                    <Images size={16} />
                    从历史选择
                  </button>
                  <label className="btn-secondary upload-btn">
                    <Upload size={16} />
                    添加图片
                    <input type="file" accept="image/*" multiple onChange={handleReferenceUpload} />
                  </label>
                  {referenceImages.length > 0 ? (
                    <button className="btn-secondary" type="button" onClick={clearReferences}>
                      <RotateCcw size={16} />
                      清空
                    </button>
                  ) : null}
                </div>
              </div>
              {referenceImages.length > 0 ? (
                <div className="reference-grid" aria-label="参考图列表">
                  {referenceImages.map((image, index) => (
                    <figure className="reference-card" key={image.id}>
                      <button
                        className="reference-preview-button"
                        type="button"
                        onClick={() => {
                          const gallery = referencePreviewItems(referenceImages);
                          props.setPreviewImage({ ...gallery[index], gallery, index });
                        }}
                        aria-label={`预览参考图 ${image.name}`}
                      >
                        <img className="reference-preview" src={image.previewSrc} alt={`参考图 ${index + 1}: ${image.name}`} loading="lazy" decoding="async" />
                      </button>
                      <figcaption>
                        <strong title={image.name}>{image.name}</strong>
                        <span>{(image.size / 1024).toFixed(1)} KB</span>
                      </figcaption>
                      <button className="reference-remove" type="button" onClick={() => removeReferenceImage(image.id)} title="移除参考图" aria-label={`移除参考图 ${image.name}`}>
                        <X size={14} />
                      </button>
                    </figure>
                  ))}
                </div>
              ) : null}
            </details>

            <button className="btn-primary generate-submit" type="button" onClick={runGenerate} disabled={!canGenerate}>
              {submittingGeneration ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              {submittingGeneration ? "正在加入队列" : "开始生图"}
            </button>
            {duplicatePendingJob ? <p className="field-hint">已有相同提示词的任务，修改提示词后可继续提交。</p> : null}

            {pendingJobs.length > 0 ? (
              <section className="generation-queue" aria-label="进行中的生图任务">
                <div className="generation-queue-heading">
                  <div>
                    <strong>进行中的任务</strong>
                    <span>可继续提交，任务按服务端并发策略处理</span>
                  </div>
                  <span className="generation-queue-count">{pendingJobs.length} 项</span>
                </div>
                <div className="generation-queue-list">
                  {pendingJobs.map((job) => {
                    const meta = generateStatusMeta(job.status);
                    const elapsed = job.status === "running"
                      ? Math.max(job.durationMs ?? 0, pendingJobsNow - job.submittedAt - (job.waitDurationMs ?? 0))
                      : Math.max(job.waitDurationMs ?? 0, pendingJobsNow - job.submittedAt);
                    return (
                      <article className="generation-queue-item" key={job.id}>
                        <div className="generation-queue-item-main">
                          <div className="generation-queue-item-topline">
                            <span className={`generate-status ${meta.className}`}>{job.status === "running" ? <Loader2 className="spin" size={12} /> : null}{meta.label}</span>
                            <span>{job.size} · {job.count} 张</span>
                          </div>
                          <p title={job.prompt}>{job.prompt}</p>
                          {job.pollError ? <span className="generation-queue-item-error" role="status">状态同步失败，将自动重试：{job.pollError}</span> : null}
                        </div>
                        <div className="generation-queue-item-timing">
                          <strong>{job.status === "queued" ? `已排队 ${formatGenerateElapsed(elapsed)}` : `生成 ${formatGenerateElapsed(elapsed)}`}</strong>
                          <span>{job.endpoint === "/v1/images/edits" ? "参考图编辑" : "文生图"}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <div className="prompt-examples" aria-label="示例提示词">
              {promptExamples.map((example) => (
                <button className="prompt-example-btn" key={example.key} type="button" onClick={() => applyPromptExample(example)}>
                  <strong>{example.label}</strong>
                  <span>{example.ratio}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="generate-pane generate-result">
            <div className="generate-result-head">
              <div>
                <strong>结果预览</strong>
                <span>{endpoint} · {latestResultSize}</span>
              </div>
            </div>
            {resultImages.length > 0 ? (
              <div className="generate-preview-grid">
                {resultImages.map((image, index) => (
                  <figure className="generate-preview-card" key={image.filename}>
                    <button
                      className={ratioClassName(ratio)}
                      type="button"
                      onClick={() => {
                        const gallery = generatedPreviewItems(resultImages, ratio);
                        props.setPreviewImage({ ...gallery[index], gallery, index });
                      }}
                    >
                      <img src={image.src} alt={image.meta} loading="lazy" decoding="async" />
                    </button>
                    <figcaption>{image.meta}</figcaption>
                    <a href={image.fullSrc || image.src} download={image.filename}>
                      <Download size={15} />
                      下载
                    </a>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="generate-empty">
                <ImagePlus size={32} />
                <span>生成后的图片会显示在这里。</span>
              </div>
            )}
            {promptSuggestion ? (
              <div className="prompt-suggestion-card">
                <div>
                  <strong>{promptSuggestion.title}</strong>
                  <span>{promptSuggestion.source === "parse-failure" ? "图片未返回时从上游原始说明中提取。" : "原请求触发限制时从上游建议中提取。"}</span>
                </div>
                <p>{promptSuggestion.prompt}</p>
                <div className="prompt-suggestion-actions">
                  <button className="btn-primary" type="button" onClick={acceptPromptSuggestion}>
                    <CheckCircle2 size={16} />
                    采纳方案
                  </button>
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => {
                      copyText(promptSuggestion.prompt)
                        .then((ok) => props.setStatus(ok ? "替代方案已复制。" : "复制失败，请手动复制。"))
                        .catch(() => props.setStatus("复制失败，请手动复制。"));
                    }}
                  >
                    <Copy size={16} />
                    复制
                  </button>
                </div>
              </div>
            ) : null}
            <details className="generate-response-details">
              <summary>响应 JSON</summary>
              <pre className="pre generate-response">{responseBody}</pre>
            </details>
          </div>
        </div>
      ) : tab === "history" ? (
        <div className="generate-history">
          <div className="generate-history-actions">
            <span>
              {historyLoading
                ? "正在读取服务端历史..."
                : `按当前筛选共 ${historyTotal} 条${historyFilterTotal > 0 ? `（已启用 ${historyFilterTotal} 项筛选）` : ""}，本页 ${history.length} 条。`}
            </span>
            <div className="generate-history-bulk-actions">
              <div className="generate-history-view-toggle" role="group" aria-label="历史记录显示方式">
                <button
                  className={historyViewMode === "grid" ? "is-active" : ""}
                  type="button"
                  onClick={() => setHistoryViewMode("grid")}
                  aria-pressed={historyViewMode === "grid"}
                  title="宫格视图"
                >
                  <LayoutGrid size={16} aria-hidden="true" />
                  <span>宫格</span>
                </button>
                <button
                  className={historyViewMode === "list" ? "is-active" : ""}
                  type="button"
                  onClick={() => setHistoryViewMode("list")}
                  aria-pressed={historyViewMode === "list"}
                  title="列表视图"
                >
                  <List size={16} aria-hidden="true" />
                  <span>列表</span>
                </button>
              </div>
              {historyViewMode === "grid" ? (
                <label className="generate-history-select-all">
                  <input
                    type="checkbox"
                    checked={allSelectableHistorySelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelectableHistorySelected;
                    }}
                    onChange={toggleSelectAllHistory}
                    disabled={selectableHistory.length === 0 || bulkDownloading}
                    aria-label="本页全选可下载记录"
                  />
                  <span>本页全选</span>
                </label>
              ) : null}
              {selectedHistory.length > 0 ? (
                <>
                  <span className="generate-history-selection-summary">
                    已选 {selectedHistory.length} 条 / {selectedHistoryImageCount} 张{selectedHistory.length > selectedCurrentPageCount ? `（含其他页 ${selectedHistory.length - selectedCurrentPageCount} 条）` : ""}
                  </span>
                  <button className="btn-primary" type="button" onClick={downloadSelectedHistoryImages} disabled={bulkDownloading}>
                    {bulkDownloading ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                    {bulkDownloading ? "正在打包" : "批量下载"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setSelectedHistoryItems(new Map())} disabled={bulkDownloading}>
                    清除选择
                  </button>
                </>
              ) : null}
              <button className="btn-secondary" type="button" onClick={() => setHistoryReloadToken((value) => value + 1)} disabled={historyLoading || bulkDownloading}>
                <RotateCcw size={16} aria-hidden="true" />
                刷新
              </button>
            </div>
          </div>
          {renderHistoryFilters()}
          {renderHistoryPager("top")}
          {historyLoading && history.length === 0 ? (
            <div className="empty-state">正在读取服务端历史...</div>
          ) : history.length === 0 ? (
            <div className="empty-state">{historyFilterTotal > 0 ? "没有匹配筛选条件的生图历史。" : "暂无生图历史。"}</div>
          ) : historyViewMode === "list" ? (
            <HistoryTable
              items={history}
              isAdmin={props.role === "admin"}
              config={props.config}
              loading={historyLoading}
              bulkDownloading={bulkDownloading}
              selectedIds={new Set(selectedHistoryItems.keys())}
              allSelectableSelected={allSelectableHistorySelected}
              someSelectableSelected={someSelectableHistorySelected}
              onToggleSelect={toggleHistorySelection}
              onToggleSelectAll={toggleSelectAllHistory}
              onOpenPreview={(item, index) => {
                const gallery = historyPreviewItems(item);
                const target = gallery[index] ?? gallery[0];
                if (target) {
                  props.setPreviewImage({ ...target, gallery, index: index < gallery.length ? index : 0 });
                }
              }}
              onOpenDetail={setHistoryDetailItem}
              onMenuAction={runHistoryRowAction}
              actionHint={historyActionHint}
            />
          ) : (
            <div className="generate-history-grid">
              {history.map((item) => {
                const statusMeta = generateStatusMeta(item.status);
                const firstImage = item.images[0];
                const selectable = item.status === "success" && item.images.length > 0;
                const selected = selectedHistoryItems.has(item.id);
                const summary = failureSummary(item.error);
                return (
                  <article className={`generate-history-card ${selected ? "is-selected" : ""}`} key={item.id}>
                    {selectable ? (
                      <label className="generate-history-card-select" title={selected ? "取消选择" : "选择此记录"}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleHistorySelection(item)}
                          disabled={bulkDownloading}
                          aria-label={`${selected ? "取消选择" : "选择"}：${item.prompt}`}
                        />
                      </label>
                    ) : null}
                    <HistoryPreviewThumb
                      item={item}
                      onOpen={(target, index) => {
                        const gallery = historyPreviewItems(target);
                        const entry = gallery[index] ?? gallery[0];
                        if (entry) {
                          props.setPreviewImage({ ...entry, gallery, index: index < gallery.length ? index : 0 });
                        }
                      }}
                    />
                    <div className="generate-history-card-info">
                      <div className="generate-history-title-row">
                        <span className={`generate-status ${statusMeta.className}`}>{statusMeta.label}</span>
                        <strong className="history-prompt-text" title={item.prompt} data-full-prompt={item.prompt}>
                          {item.prompt}
                        </strong>
                      </div>
                      <span>
                        {formatFullTime(item.createdAt)} · {firstImage?.width && firstImage?.height ? `${firstImage.width}×${firstImage.height}` : item.ratio || item.size} · {item.images.length > 0 ? `生成图 ${item.images.length}` : "无生成图"} · {item.referenceImages.length > 0 ? `参考图 ${item.referenceImages.length}` : "纯文本"} · {formatDuration(item.durationMs)}
                        {item.waitDurationMs && item.waitDurationMs > 0 ? ` · 等待 ${formatDuration(item.waitDurationMs)}` : ""}
                        {props.role === "admin" ? ` · 用户 ${userDisplayName(props.config, item.owner)}` : ""}
                        {firstImage?.previewSize ? ` · 预览 ${(firstImage.previewSize / 1024).toFixed(0)} KB` : ""}
                      </span>
                      {summary ? <span className="generate-history-error" title={item.error}>{summary}</span> : null}
                    </div>
                    <HistoryCardActions
                      item={item}
                      copied={copiedPromptId === item.id}
                      hint={historyActionHint}
                      onAction={runHistoryRowAction}
                    />
                  </article>
                );
              })}
            </div>
          )}
          {renderHistoryPager("bottom")}
        </div>

      ) : (
        <div className="generate-report">
          <div className="generate-report-heading">
            <div>
              <strong>生图使用趋势</strong>
              <span>
                {reportLoading
                  ? "正在聚合完整历史数据..."
                  : report.startTime && report.endTime
                    ? `${formatFullTime(report.startTime)} 至 ${formatFullTime(report.endTime)}`
                    : "当前筛选范围暂无生图记录"}
              </span>
            </div>
            <button className="btn-secondary" type="button" onClick={() => refreshReport()} disabled={reportLoading}>
              <RotateCcw size={16} />
              刷新
            </button>
          </div>
          {renderReportFilters()}
          <div className="generate-report-summary">
            <div className="generate-report-stat">
              <div className="generate-report-stat-head"><Activity size={17} /><span>生图次数</span></div>
              <strong>{report.summary.requestCount}</strong>
              <small>{report.summary.successCount} 成功 / {report.summary.failedCount} 失败</small>
            </div>
            <div className="generate-report-stat">
              <div className="generate-report-stat-head"><Images size={17} /><span>生成图片</span></div>
              <strong>{report.summary.imageCount}</strong>
              <small>平均每次 {(report.summary.imageCount / Math.max(1, report.summary.requestCount)).toFixed(1)} 张</small>
            </div>
            <div className="generate-report-stat">
              <div className="generate-report-stat-head"><Users size={17} /><span>活跃人员</span></div>
              <strong>{report.summary.activeUserCount}</strong>
              <small>人均 {report.summary.averageRequestsPerUser.toFixed(1)} 次</small>
            </div>
            <div className="generate-report-stat">
              <div className="generate-report-stat-head"><CheckCircle2 size={17} /><span>成功率</span></div>
              <strong>{percentLabel(report.summary.successRate)}</strong>
              <small>平均耗时 {formatDuration(report.summary.averageDurationMs)}</small>
            </div>
          </div>
          <div className="generate-report-content">
            <section className="generate-report-panel generate-report-trend-panel">
              <div className="generate-report-panel-head">
                <div>
                  <strong>生图与人员趋势</strong>
                  <span>对比生图次数、生成图片数量和各时间段活跃人员。</span>
                </div>
                <div className="generate-report-legend">
                  <span><i className="legend-bar legend-requests" />生图次数</span>
                  <span><i className="legend-bar legend-images" />图片数量</span>
                  <span><i className="legend-line" />活跃人员</span>
                </div>
              </div>
              {renderReportChart()}
            </section>
            <section className="generate-report-panel generate-report-users-panel">
              <div className="generate-report-panel-head">
                <div>
                  <strong>人员使用排行</strong>
                  <span>{props.role === "admin" ? "按生图次数排序，点击人员可筛选，再次点击取消。" : "按筛选范围内的生图次数排序。"}</span>
                </div>
              </div>
              {report.users.length > 0 ? (
                <div className="generate-report-user-list">
                  {report.users.slice(0, 12).map((item, index) => {
                    const maxRequestCount = report.users[0]?.requestCount ?? 1;
                    const displayName = userDisplayName(props.config, item.owner);
                    const selected = reportFilters.owner === item.owner;
                    return (
                      <button
                        className={`generate-report-user-row ${selected ? "is-selected" : ""}`}
                        type="button"
                        key={item.owner}
                        onClick={() => toggleReportOwnerFilter(item.owner)}
                        disabled={props.role !== "admin" || reportLoading}
                        aria-pressed={props.role === "admin" ? selected : undefined}
                        aria-label={props.role === "admin" ? `${selected ? "取消筛选" : "筛选"}人员：${displayName}` : undefined}
                        title={props.role === "admin" ? `${selected ? "取消筛选" : "筛选"} ${displayName}` : undefined}
                      >
                        <span className="generate-report-user-rank">{index + 1}</span>
                        <div className="generate-report-user-main">
                          <div>
                            <strong>{displayName}</strong>
                            <em>{item.requestCount} 次</em>
                          </div>
                          <small>{item.owner} · {item.imageCount} 张 · 成功率 {percentLabel(item.successRate)}</small>
                          <i><span style={{ width: `${Math.max(3, (item.requestCount / maxRequestCount) * 100)}%` }} /></i>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="generate-report-empty generate-report-user-empty">
                  <Users size={28} />
                  <span>暂无人员使用数据。</span>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {historyDetailItem ? (
        <HistoryDetailDrawer
          key={historyDetailItem.id}
          item={historyDetailItem}
          isAdmin={props.role === "admin"}
          config={props.config}
          copiedPromptId={copiedPromptId}
          onClose={() => setHistoryDetailItem(null)}
          onClickAction={runHistoryRowAction}
          actionHint={historyActionHint}
          onOpenPreview={(item, index) => {
            const gallery = historyPreviewItems(item);
            const entry = gallery[index] ?? gallery[0];
            if (entry) {
              props.setPreviewImage({ ...entry, gallery, index: index < gallery.length ? index : 0 });
            }
          }}
          onLoadFullRecord={async (item) => {
            const result = await fetchJson<{ item: GenerateHistoryItem }>(`/_gateway/generations/history/${encodeURIComponent(item.id)}`);
            return result.item;
          }}
        />
      ) : null}

      {historyPickerOpen ? (
        <Modal
          title="从生图历史选择"
          onClose={() => setHistoryPickerOpen(false)}
          wide
          className="history-reference-modal"
          headerContent={<span className="history-reference-selected-count">已选 {historyPickerSelected.size}/{historyPickerRoom}</span>}
        >
          <div className="history-reference-picker">
            <div className="history-reference-toolbar">
              <label className="history-reference-search">
                <Search size={17} aria-hidden="true" />
                <input
                  className="control"
                  type="search"
                  aria-label="搜索历史图片提示词"
                  placeholder="搜索提示词"
                  value={historyPickerQuery}
                  onChange={(event) => {
                    setHistoryPickerQuery(event.target.value);
                    setHistoryPickerPage(1);
                  }}
                  autoFocus
                />
              </label>
              <span>{historyPickerScopeLabel} · 共 {historyPickerTotal} 条记录</span>
            </div>

            {historyPickerMessage ? <div className="history-reference-message" role="status">{historyPickerMessage}</div> : null}

            <div className="history-reference-results" aria-live="polite">
              {historyPickerLoading ? (
                <div className="history-reference-empty">
                  <Loader2 className="spin" size={28} />
                  <span>正在读取生图历史...</span>
                </div>
              ) : historyPickerCandidates.length > 0 ? (
                <div className="history-reference-grid">
                  {historyPickerCandidates.map(({ key, item, image, imageIndex, src, previewSrc, alreadyAdded }) => {
                    const selected = historyPickerSelected.has(key);
                    const name = image.filename || `历史图片-${imageIndex + 1}.png`;
                    return (
                      <button
                        className={`history-reference-item ${selected ? "is-selected" : ""} ${alreadyAdded ? "is-added" : ""}`}
                        type="button"
                        key={key}
                        onClick={() => toggleHistoryReference(key, {
                          id: createClientId(`history-reference-${item.id}-${imageIndex + 1}`),
                          src,
                          previewSrc,
                          name,
                          size: image.size || image.previewSize || 0,
                        }, alreadyAdded)}
                        disabled={alreadyAdded}
                        aria-pressed={alreadyAdded ? undefined : selected}
                        aria-label={`${alreadyAdded ? "已添加" : selected ? "取消选择" : "选择"}：${item.prompt}`}
                      >
                        <span className="history-reference-image">
                          <img src={previewSrc} alt="" loading="lazy" decoding="async" />
                          {selected ? <span className="history-reference-check"><Check size={15} />已选</span> : null}
                          {alreadyAdded ? <span className="history-reference-check is-added"><Check size={15} />已添加</span> : null}
                        </span>
                        <span className="history-reference-copy">
                          <strong title={item.prompt}>{item.prompt}</strong>
                          <small>{formatFullTime(item.createdAt)}{item.images.length > 1 ? ` · 第 ${imageIndex + 1} 张` : ""}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="history-reference-empty">
                  <Images size={30} />
                  <strong>{historyPickerQuery.trim() ? "没有匹配的历史图片" : "暂无可用的历史图片"}</strong>
                </div>
              )}
            </div>

            <div className="history-reference-footer">
              <div className="history-reference-pager" aria-label="历史图片分页">
                <button className="btn-secondary" type="button" onClick={() => setHistoryPickerPage((page) => Math.max(1, page - 1))} disabled={historyPickerPage <= 1 || historyPickerLoading}>
                  上一页
                </button>
                <span>第 {historyPickerPage} / {historyPickerTotalPages} 页</span>
                <button className="btn-secondary" type="button" onClick={() => setHistoryPickerPage((page) => Math.min(historyPickerTotalPages, page + 1))} disabled={historyPickerPage >= historyPickerTotalPages || historyPickerLoading}>
                  下一页
                </button>
              </div>
              <div className="history-reference-confirm">
                <button className="btn-secondary" type="button" onClick={() => setHistoryPickerOpen(false)}>取消</button>
                <button className="btn-primary" type="button" onClick={addSelectedHistoryReferences} disabled={historyPickerSelected.size === 0}>
                  <ImagePlus size={16} />
                  {historyPickerSelected.size > 0 ? `添加 ${historyPickerSelected.size} 张` : "添加"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
