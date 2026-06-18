import { BarChart3, Copy, Download, ImagePlus, Loader2, Pencil, RotateCcw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, RequestLog } from "@/shared/types";
import type { BusyAction, PreviewImage } from "@/shared/lib/app-types";
import { copyText, createClientId, errorMessage, extractPreviewImages, readFileAsDataUrl, summarizeJson } from "@/shared/lib/app-utils";
import { formatDuration, formatFullTime, formatJson } from "@/shared/lib/format";
import { profileLabel } from "@/shared/lib/profiles";
import type { UserRole } from "@/routes/routes";

type GenerateTab = "create" | "history" | "report";
type ImageRatio = "1:1" | "16:9" | "9:16" | "4:3";
type OutputFormat = "png" | "webp" | "jpeg";
type PreviewRatioClass = "ratio-square" | "ratio-wide" | "ratio-tall" | "ratio-classic";
type ReferenceImageState = { src: string; previewSrc: string; name: string; size: number };

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type GenerateHistoryItem = {
  id: string;
  owner?: string;
  createdAt: number;
  status: "running" | "success" | "failed";
  endpoint: string;
  account: string;
  model: string;
  prompt: string;
  ratio?: ImageRatio;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  outputFormat?: OutputFormat;
  durationMs: number;
  error?: string;
  referenceImages: Array<{
    name?: string;
    url?: string;
    sourceType: "data-url" | "url" | "file-id";
    source?: string;
  }>;
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

type GenerateReportBucket = {
  key: number;
  label: string;
  count: number;
  success: number;
  failed: number;
  running: number;
  imageCount: number;
  averageDurationMs: number;
};

type GenerateReportStats = {
  total: number;
  success: number;
  failed: number;
  running: number;
  imageCount: number;
  successRate: number;
  averageDurationMs: number;
  buckets: GenerateReportBucket[];
};

const PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
  "你是专业的 AI 生图提示词优化助手。",
  "请把用户的原始提示词改写成更适合图像生成模型的中文提示词。",
  "保留用户明确指定的主体、风格、文字、尺寸、颜色和限制。",
  "增强画面主体、构图、光线、材质、背景、镜头语言和细节层次。",
  "只输出优化后的提示词正文，不要解释，不要 Markdown，不要添加标题。",
].join("\n");

const ratioOptions: Array<{ ratio: ImageRatio; label: string; size: string }> = [
  { ratio: "1:1", label: "1:1", size: "1024x1024" },
  { ratio: "16:9", label: "16:9", size: "1536x864" },
  { ratio: "9:16", label: "9:16", size: "864x1536" },
  { ratio: "4:3", label: "4:3", size: "1280x960" },
];

function ratioClassName(value?: string): PreviewRatioClass {
  const normalized = value?.trim();
  const match = normalized?.match(/^(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio < 0.75) return "ratio-tall";
      if (ratio > 1.45) return "ratio-wide";
      if (ratio > 1.15) return "ratio-classic";
      return "ratio-square";
    }
  }

  if (normalized === "16:9") return "ratio-wide";
  if (normalized === "9:16") return "ratio-tall";
  if (normalized === "4:3") return "ratio-classic";
  return "ratio-square";
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

function percentLabel(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${value.toFixed(value >= 99.95 || value < 10 ? 1 : 0)}%`;
}

function formatReportBucketLabel(value: number, bucketMs: number): string {
  const date = new Date(value);
  if (bucketMs >= 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" }).format(date);
}

function chooseReportBucketMs(spanMs: number): number {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const candidates = [10 * minute, hour, 6 * hour, day, 7 * day, 30 * day];
  return candidates.find((bucketMs) => Math.max(1, Math.ceil(spanMs / bucketMs)) <= 18) ?? 30 * day;
}

function buildGenerateReportStats(items: GenerateHistoryItem[]): GenerateReportStats {
  const total = items.length;
  const success = items.filter((item) => item.status === "success").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const running = items.filter((item) => item.status === "running").length;
  const imageCount = items.reduce((sum, item) => sum + item.images.length, 0);
  const timedItems = items.filter((item) => item.status !== "running" && Number.isFinite(item.durationMs) && item.durationMs > 0);
  const averageDurationMs = timedItems.length > 0
    ? timedItems.reduce((sum, item) => sum + item.durationMs, 0) / timedItems.length
    : 0;

  if (items.length === 0) {
    return {
      total,
      success,
      failed,
      running,
      imageCount,
      successRate: 0,
      averageDurationMs,
      buckets: [],
    };
  }

  const timestamps = items.map((item) => item.createdAt).filter((value) => Number.isFinite(value));
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const bucketMs = chooseReportBucketMs(Math.max(1, maxTime - minTime));
  const start = Math.floor(minTime / bucketMs) * bucketMs;
  const end = Math.floor(maxTime / bucketMs) * bucketMs;
  const bucketMap = new Map<number, {
    count: number;
    success: number;
    failed: number;
    running: number;
    imageCount: number;
    totalDurationMs: number;
    timedCount: number;
  }>();

  for (let current = start; current <= end; current += bucketMs) {
    bucketMap.set(current, {
      count: 0,
      success: 0,
      failed: 0,
      running: 0,
      imageCount: 0,
      totalDurationMs: 0,
      timedCount: 0,
    });
  }

  for (const item of items) {
    const key = Math.floor(item.createdAt / bucketMs) * bucketMs;
    const bucket = bucketMap.get(key) ?? {
      count: 0,
      success: 0,
      failed: 0,
      running: 0,
      imageCount: 0,
      totalDurationMs: 0,
      timedCount: 0,
    };
    bucket.count += 1;
    bucket.imageCount += item.images.length;
    if (item.status === "success") bucket.success += 1;
    if (item.status === "failed") bucket.failed += 1;
    if (item.status === "running") bucket.running += 1;
    if (item.status !== "running" && Number.isFinite(item.durationMs) && item.durationMs > 0) {
      bucket.totalDurationMs += item.durationMs;
      bucket.timedCount += 1;
    }
    bucketMap.set(key, bucket);
  }

  return {
    total,
    success,
    failed,
    running,
    imageCount,
    successRate: total > 0 ? (success / total) * 100 : 0,
    averageDurationMs,
    buckets: Array.from(bucketMap.entries())
      .sort(([left], [right]) => left - right)
      .map(([key, bucket]) => ({
        key,
        label: formatReportBucketLabel(key, bucketMs),
        count: bucket.count,
        success: bucket.success,
        failed: bucket.failed,
        running: bucket.running,
        imageCount: bucket.imageCount,
        averageDurationMs: bucket.timedCount > 0 ? bucket.totalDurationMs / bucket.timedCount : 0,
      })),
  };
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("图片转换结果不是字符串。"));
    };
    reader.onerror = () => reject(reader.error || new Error("图片转换失败。"));
    reader.readAsDataURL(blob);
  });
}

async function imageUrlToDataUrl(url: string): Promise<{ dataUrl: string; size: number }> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`读取历史图片失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return {
    dataUrl: await blobToDataUrl(blob),
    size: blob.size,
  };
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
  setPreviewImage: (value: { src: string; meta: string; filename?: string; ratio?: string } | null) => void;
}) {
  const [tab, setTab] = useState<GenerateTab>("create");
  const [prompt, setPrompt] = useState("生成一张白底红苹果商品图，构图简洁，光线干净。");
  const [ratio, setRatio] = useState<ImageRatio>("1:1");
  const [quality, setQuality] = useState<"low" | "medium" | "high" | "auto">("low");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [referenceImage, setReferenceImage] = useState<ReferenceImageState | null>(null);
  const [resultImages, setResultImages] = useState<PreviewImage[]>([]);
  const [responseBody, setResponseBody] = useState("生成结果会显示在这里。");
  const [history, setHistory] = useState<GenerateHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPromptQuery, setHistoryPromptQuery] = useState("");
  const [historyStartTime, setHistoryStartTime] = useState("");
  const [historyEndTime, setHistoryEndTime] = useState("");
  const [historyOwnerFilter, setHistoryOwnerFilter] = useState("");
  const [historyCustomOwner, setHistoryCustomOwner] = useState("");
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [manualCopyPrompt, setManualCopyPrompt] = useState<string | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = useState(0);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const generatingRef = useRef(false);

  const selectedSize = useMemo(() => ratioOptions.find((item) => item.ratio === ratio)?.size ?? "1024x1024", [ratio]);
  const latestResultSize = useMemo(() => {
    const first = resultImages[0];
    return first?.width && first.height ? `${first.width}×${first.height}` : selectedSize;
  }, [resultImages, selectedSize]);
  const endpoint = referenceImage ? "/v1/images/edits" : "/v1/images/generations";
  const canGenerate = Boolean(props.config?.profile) && prompt.trim().length > 0 && props.busy !== "test" && props.busy !== "prompt-optimize";
  const canOptimizePrompt = Boolean(props.config?.profile) && prompt.trim().length > 0 && props.busy !== "test" && props.busy !== "prompt-optimize";
  const filteredHistory = useMemo(() => {
    const query = historyPromptQuery.trim().toLowerCase();
    const startMs = historyStartTime ? Date.parse(historyStartTime) : Number.NaN;
    const endMs = historyEndTime ? Date.parse(historyEndTime) : Number.NaN;

    return history.filter((item) => {
      if (query && !item.prompt.toLowerCase().includes(query)) {
        return false;
      }
      if (Number.isFinite(startMs) && item.createdAt < startMs) {
        return false;
      }
      if (Number.isFinite(endMs) && item.createdAt > endMs) {
        return false;
      }
      return true;
    });
  }, [history, historyEndTime, historyPromptQuery, historyStartTime]);
  const reportStats = useMemo(() => buildGenerateReportStats(filteredHistory), [filteredHistory]);
  const historyOwnerOptions = useMemo(() => {
    const names = new Set<string>();
    if (props.currentUser) {
      names.add(props.currentUser);
    }
    for (const item of history) {
      if (item.owner) {
        names.add(item.owner);
      }
    }
    return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-CN"));
  }, [history, props.currentUser]);

  const renderHistoryFilters = () => (
    <div className="generate-history-filters">
      <label className="field history-search-field">
        <span>提示词</span>
        <div className="history-search-control">
          <Search size={16} />
          <input
            className="control"
            placeholder="检索提示词"
            value={historyPromptQuery}
            onChange={(event) => setHistoryPromptQuery(event.target.value)}
          />
        </div>
      </label>
      <label className="field">
        <span>开始时间</span>
        <input className="control" type="datetime-local" value={historyStartTime} onChange={(event) => setHistoryStartTime(event.target.value)} />
      </label>
      <label className="field">
        <span>结束时间</span>
        <input className="control" type="datetime-local" value={historyEndTime} onChange={(event) => setHistoryEndTime(event.target.value)} />
      </label>
      {props.role === "admin" ? (
        <>
          <label className="field">
            <span>用户范围</span>
            <select className="control" value={historyOwnerFilter} onChange={(event) => setHistoryOwnerFilter(event.target.value)}>
              <option value="">我的数据</option>
              <option value="all">全部用户</option>
              {historyOwnerOptions.map((owner) => (
                <option key={owner} value={owner}>
                  {owner === props.currentUser ? `${owner}（我）` : owner}
                </option>
              ))}
            </select>
          </label>
          <label className="field history-owner-field">
            <span>指定用户</span>
            <div className="history-search-control">
              <input
                className="control"
                placeholder="输入用户名"
                value={historyCustomOwner}
                onChange={(event) => setHistoryCustomOwner(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setHistoryOwnerFilter(historyCustomOwner.trim());
                  }
                }}
              />
              <button className="history-owner-apply" type="button" onClick={() => setHistoryOwnerFilter(historyCustomOwner.trim())}>
                查看
              </button>
            </div>
          </label>
        </>
      ) : null}
      <button
        className="btn-secondary history-filter-reset"
        type="button"
        onClick={() => {
          setHistoryPromptQuery("");
          setHistoryStartTime("");
          setHistoryEndTime("");
        }}
        disabled={!historyPromptQuery && !historyStartTime && !historyEndTime}
      >
        <RotateCcw size={16} />
        重置
      </button>
    </div>
  );

  const renderReportChart = () => {
    const buckets = reportStats.buckets;
    if (buckets.length === 0) {
      return (
        <div className="generate-report-empty">
          <BarChart3 size={30} />
          <span>暂无可统计的生图记录。</span>
        </div>
      );
    }

    const width = 900;
    const height = 280;
    const padding = { top: 22, right: 24, bottom: 48, left: 42 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
    const maxDuration = Math.max(1, ...buckets.map((bucket) => bucket.averageDurationMs));
    const barGap = 8;
    const barWidth = Math.max(10, (chartWidth - barGap * Math.max(0, buckets.length - 1)) / buckets.length);
    const points = buckets.map((bucket, index) => {
      const x = padding.left + index * (barWidth + barGap) + barWidth / 2;
      const y = padding.top + chartHeight - (bucket.averageDurationMs / maxDuration) * chartHeight;
      return { x, y };
    });

    return (
      <div className="generate-report-chart" role="img" aria-label="生图数量和平均耗时分布">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          <line className="chart-axis" x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + chartHeight} />
          <line className="chart-axis" x1={padding.left} y1={padding.top + chartHeight} x2={width - padding.right} y2={padding.top + chartHeight} />
          {[0.25, 0.5, 0.75, 1].map((value) => {
            const y = padding.top + chartHeight - value * chartHeight;
            return <line className="chart-grid-line" key={value} x1={padding.left} y1={y} x2={width - padding.right} y2={y} />;
          })}
          {buckets.map((bucket, index) => {
            const x = padding.left + index * (barWidth + barGap);
            const barHeight = (bucket.count / maxCount) * chartHeight;
            const y = padding.top + chartHeight - barHeight;
            return (
              <g key={bucket.key}>
                <rect className="chart-bar" x={x} y={y} width={barWidth} height={Math.max(2, barHeight)} rx="5" />
                <text className="chart-bar-label" x={x + barWidth / 2} y={Math.max(14, y - 6)} textAnchor="middle">
                  {bucket.count}
                </text>
                <text className="chart-x-label" x={x + barWidth / 2} y={height - 18} textAnchor="middle">
                  {bucket.label}
                </text>
              </g>
            );
          })}
          <path className="chart-line" d={buildLinePath(points)} />
          {points.map((point, index) => (
            <circle className="chart-line-point" key={buckets[index].key} cx={point.x} cy={point.y} r="4" />
          ))}
        </svg>
        <div className="generate-report-bucket-list" aria-label="图表数据明细">
          {buckets.map((bucket) => (
            <div className="generate-report-bucket" key={bucket.key}>
              <strong>{bucket.label}</strong>
              <span>{bucket.count} 次 · {formatDuration(bucket.averageDurationMs)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  async function refreshHistory(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setHistoryLoading(true);
    }
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (props.role === "admin" && historyOwnerFilter) {
        params.set("owner", historyOwnerFilter);
      }
      const next = await fetchJson<{ items: GenerateHistoryItem[] }>(`/_gateway/generations/history?${params.toString()}`);
      setHistory(next.items);
    } catch (error) {
      if (!options?.silent) {
        props.setStatus(`读取生图历史失败：${errorMessage(error)}`);
      }
    } finally {
      if (!options?.silent) {
        setHistoryLoading(false);
      }
    }
  }

  useEffect(() => {
    refreshHistory({ silent: true }).catch(() => undefined);
  }, [historyOwnerFilter]);

  useEffect(() => {
    if (!generationStartedAt || props.busy !== "test") {
      return undefined;
    }

    const updateElapsed = () => setElapsedNow(performance.now() - generationStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt, props.busy]);

  async function handleReferenceUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const src = await readFileAsDataUrl(file);
      setReferenceImage({ src, previewSrc: await createReferencePreview(src, file.size), name: file.name, size: file.size });
      props.setStatus("参考图已载入，本次将走 images.edits。");
    } catch (error) {
      props.setStatus(errorMessage(error));
    }
  }

  function clearReference() {
    setReferenceImage(null);
    props.setStatus("已移除参考图，本次将走 images.generations。");
  }

  function applyPromptExample(example: (typeof promptExamples)[number]) {
    setPrompt(example.prompt);
    setRatio(example.ratio);
    setReferenceImage(null);
    props.setStatus(`已填入${example.label}示例提示词。`);
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
      const result = await fetchJson<ChatCompletionResponse>("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: formatJson({
          model: props.config?.settings.defaultModel || "gpt-5.4",
          messages: [
            { role: "system", content: PROMPT_OPTIMIZER_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                `原始提示词：${originalPrompt}`,
                `目标比例：${ratio}`,
                `目标尺寸：${selectedSize}`,
                referenceImage ? "用户会携带参考图，请强调参考图主体与风格一致性。" : "无参考图，请补足画面细节。",
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
    if (generatingRef.current || props.busy === "test") {
      props.setStatus("已有生图任务正在执行，请等待完成。");
      return;
    }
    generatingRef.current = true;
    const startedAt = performance.now();
    props.setBusy("test");
    setGenerationStartedAt(startedAt);
    setElapsedNow(0);
    setLastDurationMs(null);
    setResponseBody("正在生成图片...");
    setResultImages([]);
    try {
      const body = referenceImage
        ? {
            model: "gpt-image-2",
            prompt: prompt.trim(),
            images: [{ image_url: referenceImage.src }],
            size: selectedSize,
            quality,
            output_format: outputFormat,
            response_format: "b64_json",
          }
        : {
            model: "gpt-image-2",
            prompt: prompt.trim(),
            size: selectedSize,
            quality,
            output_format: outputFormat,
            response_format: "b64_json",
          };

      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: formatJson(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      const durationMs = performance.now() - startedAt;
      setLastDurationMs(durationMs);
      setResponseBody(typeof parsed === "string" ? parsed : formatJson(summarizeJson(parsed)));
      refreshHistory({ silent: true }).catch(() => undefined);

      if (!response.ok) {
        const message =
          parsed &&
          typeof parsed === "object" &&
          "error" in parsed &&
          typeof (parsed as { error?: { message?: unknown } }).error?.message === "string"
            ? (parsed as { error: { message: string } }).error.message
            : `HTTP ${response.status}`;
        props.setStatus(`生图失败：${message}`);
        return;
      }

      if (parsed === null || typeof parsed === "undefined" || parsed === "") {
        setResponseBody("响应为空：服务端没有返回图片或错误详情，请查看历史/请求日志。");
        props.setStatus("生图异常：服务端返回空响应，已刷新服务端历史。");
        return;
      }

      const images = extractPreviewImages(parsed);
      setResultImages(images);
      props.setRequestLogs((items) => [
        {
          id: createClientId("request"),
          time: Date.now(),
          method: "POST",
          endpoint,
          account: profileLabel(props.config?.profile, props.showEmails),
          model: "gpt-image-2",
          statusCode: response.status,
          durationMs,
          source: "生图工作台",
        },
        ...items,
      ].slice(0, 20));
      props.setStatus(images.length > 0 ? `生图完成，耗时 ${formatDuration(durationMs)}。` : "生图异常：请求成功，但响应里没有图片。");
      props.refreshConfig({ silent: true }).catch(() => undefined);
    } catch (error) {
      setResponseBody(errorMessage(error));
      props.setStatus(`生图失败：${errorMessage(error)}`);
    } finally {
      generatingRef.current = false;
      setGenerationStartedAt(null);
      props.setBusy(null);
    }
  }

  function reuseHistory(item: GenerateHistoryItem) {
    setPrompt(item.prompt);
    setRatio(item.ratio && ratioOptions.some((option) => option.ratio === item.ratio) ? item.ratio : "1:1");
    setQuality(item.quality || "low");
    setOutputFormat(item.outputFormat || "png");
    const firstReference = item.referenceImages.find((reference) => reference.url || reference.source);
    setReferenceImage(firstReference?.url || firstReference?.source ? {
      src: firstReference.url || firstReference.source || "",
      previewSrc: firstReference.url || firstReference.source || "",
      name: firstReference.name || "history-reference",
      size: 0,
    } : null);
    setTab("create");
    props.setStatus("已带入历史提示词和参数。");
  }

  async function editFromHistory(item: GenerateHistoryItem) {
    const image = item.images[0];
    if (!image?.url) {
      props.setStatus("这条历史没有可编辑的生成图。");
      return;
    }

    props.setBusy("test");
    try {
      const { dataUrl, size } = await imageUrlToDataUrl(image.url);
      setPrompt(item.prompt);
      setRatio(item.ratio && ratioOptions.some((option) => option.ratio === item.ratio) ? item.ratio : "1:1");
      setQuality(item.quality || "low");
      setOutputFormat(item.outputFormat || "png");
      setReferenceImage({
        src: dataUrl,
        previewSrc: image.previewUrl || await createReferencePreview(dataUrl, size),
        name: image.filename || "history-image.png",
        size,
      });
      setResultImages([]);
      setResponseBody("已将历史图片作为参考图，本次会走 images.edits。");
      setTab("create");
      props.setStatus("已将历史图片作为编辑参考图。");
    } catch (error) {
      props.setStatus(`载入历史图片失败：${errorMessage(error)}`);
    } finally {
      props.setBusy(null);
    }
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

  async function clearHistory() {
    props.setBusy("test");
    try {
      const params = new URLSearchParams();
      if (props.role === "admin" && historyOwnerFilter) {
        params.set("owner", historyOwnerFilter);
      }
      const next = await fetchJson<{ items: GenerateHistoryItem[] }>(`/_gateway/generations/history${params.size ? `?${params.toString()}` : ""}`, { method: "DELETE" });
      setHistory(next.items);
      props.setStatus("服务端生图历史已清空。");
    } catch (error) {
      props.setStatus(`清空失败：${errorMessage(error)}`);
    } finally {
      props.setBusy(null);
    }
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
                    <button className={`ratio-btn ${ratio === item.ratio ? "is-active" : ""}`} key={item.ratio} type="button" onClick={() => setRatio(item.ratio)}>
                      <strong>{item.label}</strong>
                      <span>{item.size}</span>
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>质量</span>
                <select className="control" value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)}>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="auto">自动</option>
                </select>
              </label>
              <label className="field">
                <span>格式</span>
                <select className="control" value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}>
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
            </div>

            <details className="reference-panel">
              <summary>
                <strong>参考图</strong>
                <span>{referenceImage ? `${referenceImage.name} · ${(referenceImage.size / 1024).toFixed(1)} KB` : "可选，上传后走图片编辑接口"}</span>
              </summary>
              <div className="reference-actions">
                <label className="btn-secondary upload-btn">
                  <Upload size={16} />
                  上传图片
                  <input type="file" accept="image/*" onChange={handleReferenceUpload} />
                </label>
                {referenceImage ? (
                  <button className="btn-secondary" type="button" onClick={clearReference}>
                    <RotateCcw size={16} />
                    移除
                  </button>
                ) : null}
              </div>
              {referenceImage ? <img className="reference-preview" src={referenceImage.previewSrc} alt="参考图预览" /> : null}
            </details>

            {(props.busy === "test" || lastDurationMs !== null) ? (
              <div className="generate-duration">
                <span>{props.busy === "test" ? "已用时" : "上次耗时"}</span>
                <strong>{formatGenerateElapsed(props.busy === "test" ? elapsedNow : lastDurationMs ?? 0)}</strong>
              </div>
            ) : null}

            <button className="btn-primary generate-submit" type="button" onClick={runGenerate} disabled={!canGenerate}>
              {props.busy === "test" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              开始生图
            </button>

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
                {resultImages.map((image) => (
                  <figure className="generate-preview-card" key={image.filename}>
                    <button
                      className={ratioClassName(ratio)}
                      type="button"
                      onClick={() => props.setPreviewImage({ src: image.fullSrc || image.src, meta: image.fullMeta || image.meta, filename: image.filename, ratio: image.width && image.height ? `${image.width}:${image.height}` : ratio })}
                    >
                      <img src={image.src} alt={image.meta} />
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
            <details className="generate-response-details">
              <summary>响应 JSON</summary>
              <pre className="pre generate-response">{responseBody}</pre>
            </details>
          </div>
        </div>
      ) : tab === "history" ? (
        <div className="generate-history">
          <div className="generate-history-actions">
            <span>{historyLoading ? "正在读取服务端历史..." : `显示 ${filteredHistory.length} / ${history.length} 条服务器记录。`}</span>
            <button className="btn-secondary" type="button" onClick={() => refreshHistory()} disabled={historyLoading}>
              <RotateCcw size={16} />
              刷新
            </button>
            <button className="btn-secondary" type="button" onClick={clearHistory} disabled={history.length === 0}>
              <Trash2 size={16} />
              清空历史
            </button>
          </div>
          {renderHistoryFilters()}
          {history.length === 0 ? (
            <div className="empty-state">暂无生图历史。</div>
          ) : filteredHistory.length === 0 ? (
            <div className="empty-state">没有匹配的生图历史。</div>
          ) : (
            <div className="generate-history-grid">
              {filteredHistory.map((item) => (
                <article className="generate-history-card" key={item.id}>
                  <button
                    className={ratioClassName(item.ratio || item.size)}
                    type="button"
                    onClick={() => {
                      const image = item.images[0];
                      props.setPreviewImage(image ? { src: image.url, meta: `${image.mimeType}${image.width && image.height ? ` · ${image.width}×${image.height}` : ""} · ${(image.size / 1024).toFixed(1)} KB`, filename: image.filename, ratio: image.width && image.height ? `${image.width}:${image.height}` : item.ratio || item.size } : null);
                    }}
                  >
                    {item.images[0] ? <img src={item.images[0].previewUrl || item.images[0].url} alt={item.prompt} /> : <ImagePlus size={28} />}
                  </button>
                  <div>
                    <div className="generate-history-title-row">
                      <span className={`generate-status ${item.status === "success" ? "is-success" : item.status === "running" ? "is-running" : "is-failed"}`}>
                        {item.status === "success" ? "成功" : item.status === "running" ? "处理中" : "失败"}
                      </span>
                      <strong className="history-prompt-text" title={item.prompt} data-full-prompt={item.prompt}>
                        {item.prompt}
                      </strong>
                    </div>
                    <span>
                      {formatFullTime(item.createdAt)} · {item.images[0]?.width && item.images[0]?.height ? `${item.images[0].width}×${item.images[0].height}` : item.ratio || item.size} · {item.referenceImages.length > 0 ? `参考图 ${item.referenceImages.length}` : "纯文本"} · {formatDuration(item.durationMs)}
                      {props.role === "admin" ? ` · 用户 ${item.owner || "-"}` : ""}
                      {item.images[0]?.previewSize ? ` · 预览 ${(item.images[0].previewSize / 1024).toFixed(0)} KB` : ""}
                    </span>
                    {item.error ? <span className="generate-history-error">{item.error}</span> : null}
                  </div>
                  <div className="generate-history-card-actions">
                    {item.images[0] ? (
                      <button className="btn-secondary" type="button" onClick={() => editFromHistory(item)} disabled={props.busy === "test"}>
                        <Pencil size={15} />
                        编辑
                      </button>
                    ) : null}
                    <button className="btn-secondary" type="button" onClick={() => reuseHistory(item)}>
                      再次使用
                    </button>
                    <button className="btn-secondary" type="button" onClick={() => copyHistoryPrompt(item)}>
                      <Copy size={15} />
                      {copiedPromptId === item.id ? "已复制" : "复制提示词"}
                    </button>
                    {item.images[0] ? (
                      <a className="btn-secondary" href={item.images[0].url} download={item.images[0].filename}>
                        下载
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="generate-report">
          <div className="generate-history-actions">
            <span>{historyLoading ? "正在读取服务端历史..." : `统计 ${filteredHistory.length} / ${history.length} 条服务器记录。`}</span>
            <button className="btn-secondary" type="button" onClick={() => refreshHistory()} disabled={historyLoading}>
              <RotateCcw size={16} />
              刷新
            </button>
          </div>
          {renderHistoryFilters()}
          <div className="generate-report-summary">
            <div className="generate-report-stat">
              <span>总次数</span>
              <strong>{reportStats.total}</strong>
              <small>{reportStats.imageCount} 张图片</small>
            </div>
            <div className="generate-report-stat">
              <span>成功率</span>
              <strong>{percentLabel(reportStats.successRate)}</strong>
              <small>{reportStats.success} 成功 / {reportStats.failed} 失败</small>
            </div>
            <div className="generate-report-stat">
              <span>平均时间</span>
              <strong>{formatDuration(reportStats.averageDurationMs)}</strong>
              <small>{reportStats.running > 0 ? `${reportStats.running} 条处理中` : "已完成样本"}</small>
            </div>
            <div className="generate-report-stat">
              <span>时间段</span>
              <strong>{reportStats.buckets.length}</strong>
              <small>柱状图次数 / 曲线平均时间</small>
            </div>
          </div>
          <div className="generate-report-panel">
            <div className="generate-report-panel-head">
              <div>
                <strong>数量 / 时间分布</strong>
                <span>柱状图表示生图次数，曲线表示每个时间段的平均耗时。</span>
              </div>
              <div className="generate-report-legend">
                <span><i className="legend-bar" />次数</span>
                <span><i className="legend-line" />平均时间</span>
              </div>
            </div>
            {renderReportChart()}
          </div>
        </div>
      )}
    </section>
  );
}
