import type { GenerationHistoryStatus, HistoryStatusFilter } from "./history-types";

export type { GenerationHistoryStatus };

export type GenerationHistoryFilterState = {
  query: string;
  startTime: string;
  endTime: string;
  owner: string;
  status: HistoryStatusFilter;
};

export const EMPTY_HISTORY_FILTERS: GenerationHistoryFilterState = {
  query: "",
  startTime: "",
  endTime: "",
  owner: "",
  status: "all",
};

export const HISTORY_STATUS_FILTER_LABELS: Record<HistoryStatusFilter, string> = {
  all: "全部状态",
  success: "成功",
  failed: "失败",
  running: "处理中",
  queued: "排队中",
  interrupted: "已中断",
};

export function generateStatusMeta(status: GenerationHistoryStatus): { className: string; label: string } {
  if (status === "success") return { className: "is-success", label: "成功" };
  if (status === "queued") return { className: "is-queued", label: "排队中" };
  if (status === "running") return { className: "is-running", label: "处理中" };
  if (status === "interrupted") return { className: "is-interrupted", label: "已中断" };
  return { className: "is-failed", label: "失败" };
}

/**
 * Converts an upstream failure string into one short, localized line.
 * Raw upstream text is never dropped: it stays available in the detail drawer.
 */
export function failureSummary(error?: string): string | null {
  const raw = error?.trim();
  if (!raw) {
    return null;
  }

  const reason = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1).trim() || raw : raw;
  const lower = raw.toLowerCase();

  if (reason.includes("server_is_overloaded") || /overloaded|服务繁忙|繁忙/.test(reason)) {
    return "上游服务繁忙，请稍后重试";
  }
  if (reason.includes("usage_limit_reached") || /usage limit has been reached/.test(lower)) {
    return "账号额度已用尽，请切换账号或稍后重试";
  }
  if (/rate limit exceeded/.test(lower) || /^HTTP 429\b/.test(reason)) {
    return "请求过于频繁，已被上游限流";
  }
  if (/不能生成|不能帮助|无法继续生成|can’t help|can't help|cannot help|flagged as sexual|安全系统判定/.test(reason)) {
    return "上游内容安全策略拒绝了该提示词";
  }
  if (/未返回图片|没有可预览图片/.test(reason)) {
    return "上游已完成请求但未返回图片";
  }
  if (/超时|timeout|timed out/.test(reason)) {
    return "生成超时，已中止";
  }
  if (/还没有登录|not logged in|未登录/.test(reason)) {
    return "网关没有可用登录账号";
  }
  if (/model is not supported|模型.*不支持|未内置模型/.test(reason)) {
    return "所选模型不受上游支持";
  }
  if (/服务重启|任务已中断/.test(reason)) {
    return "服务重启导致任务中断";
  }

  const singleLine = reason.replace(/\s+/g, " ").trim();
  return singleLine.length > 32 ? `${singleLine.slice(0, 32)}…` : singleLine;
}

/** Full, untruncated failure text for the detail drawer. */
export function failureDetailLines(error?: string): string[] {
  const raw = error?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

export type ParsedHistoryTimeRange = {
  startTime?: number;
  endTime?: number;
  invalid: boolean;
};

/**
 * datetime-local values are interpreted as the viewer's local time.
 * The end boundary is inclusive and covers the whole end minute.
 */
export function parseHistoryTimeRange(startValue: string, endValue: string): ParsedHistoryTimeRange {
  const start = startValue ? Date.parse(startValue) : Number.NaN;
  const end = endValue ? Date.parse(endValue) : Number.NaN;
  const startTime = Number.isFinite(start) ? start : undefined;
  const rawEndTime = Number.isFinite(end) ? end : undefined;
  const endTime = rawEndTime === undefined ? undefined : rawEndTime + 59_999;
  const invalid = Boolean(
    (startValue && startTime === undefined) || (endValue && rawEndTime === undefined) || (startTime !== undefined && endTime !== undefined && startTime > endTime),
  );
  if (invalid) {
    return { invalid: true };
  }
  return { startTime, endTime, invalid: false };
}

export function historyFilterCount(filters: GenerationHistoryFilterState): number {
  return [filters.query.trim(), filters.startTime, filters.endTime, filters.owner, filters.status === "all" ? "" : filters.status]
    .filter(Boolean)
    .length;
}

export type PreviewRatioClass = "ratio-square" | "ratio-wide" | "ratio-tall" | "ratio-classic";

export function ratioClassName(value?: string): PreviewRatioClass {
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
