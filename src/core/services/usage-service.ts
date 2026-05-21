import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureStateMigrated,
  getUsageDailyPath,
  getUsageDir,
  getUsageEventsDir,
  getUsageLifetimePath,
} from "../store/state-paths.js";

export type UsageTokenUsage = {
  inputTokens?: number | null;
  uncachedInputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
};

export type UsageImageRoute = "none" | "codex-tool" | "chatgpt-web";

export type UsageTokenStatus =
  | "captured"
  | "missing_terminal"
  | "terminal_without_usage"
  | "parse_failed"
  | "upstream_error"
  | "not_returned";

export type UsageRecordEvent = {
  id?: string;
  timestamp?: number;
  method: string;
  endpoint: string;
  model: string;
  source: string;
  statusCode: number;
  success?: boolean;
  durationMs: number;
  profileId?: string;
  accountId?: string;
  accountLabel?: string;
  planType?: string;
  tokenUsage?: UsageTokenUsage | null;
  tokenUsageStatus?: UsageTokenStatus;
  imageCount?: number;
  imageRoute?: UsageImageRoute;
  errorType?: string;
};

export type UsageAggregate = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  estimatedCostUsd: number;
  unknownTokenCount: number;
  unknownTokenStatusCounts: Record<string, number>;
  imageCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  p95DurationMs: number;
  durationBuckets: Record<string, number>;
};

export type UsageDimensionRow = {
  key: string;
  label: string;
  aggregate: UsageAggregate;
};

export type UsageSummary = {
  generatedAt: number;
  startedAt: number;
  todayDate: string;
  storageDir: string;
  startup: UsageAggregate;
  today: UsageAggregate;
  lifetime: UsageAggregate;
  daily: Array<{ date: string; aggregate: UsageAggregate }>;
  byAccount: UsageDimensionRow[];
  byModel: UsageDimensionRow[];
  byEndpoint: UsageDimensionRow[];
  byError: UsageDimensionRow[];
  byTokenUsageStatus: UsageDimensionRow[];
  byImageRoute: UsageDimensionRow[];
  bySource: UsageDimensionRow[];
};

export type UsageResetResult = {
  backupDir: string;
  usage: UsageSummary;
};

type NormalizedUsageRecordEvent = UsageRecordEvent & {
  id: string;
  timestamp: number;
  statusCode: number;
  durationMs: number;
  success: boolean;
  tokenUsageStatus: UsageTokenStatus;
  imageCount: number;
  imageRoute: UsageImageRoute;
};

type UsageDailyStore = {
  version: 1;
  updatedAt: number;
  days: Record<string, UsageAggregate>;
};

type UsageLifetimeStore = {
  version: 1;
  updatedAt: number;
  aggregate: UsageAggregate;
  byAccount: Record<string, UsageDimensionRow>;
  byModel: Record<string, UsageDimensionRow>;
  byEndpoint: Record<string, UsageDimensionRow>;
  byError: Record<string, UsageDimensionRow>;
  byTokenUsageStatus: Record<string, UsageDimensionRow>;
  byImageRoute: Record<string, UsageDimensionRow>;
  bySource: Record<string, UsageDimensionRow>;
};

const durationBucketLimits = [100, 300, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, Number.POSITIVE_INFINITY] as const;
const openAIGpt54LongContextInputThreshold = 272000;

type TokenPricing = {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  cacheCreationUsdPerToken: number;
  cacheReadUsdPerToken: number;
  longContextInputThreshold?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
};

type UsageCostBreakdown = {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  estimatedCostUsd: number;
};

const gpt54Pricing: TokenPricing = {
  inputUsdPerToken: 2.5e-6,
  outputUsdPerToken: 15e-6,
  cacheCreationUsdPerToken: 2.5e-6,
  cacheReadUsdPerToken: 0.25e-6,
  longContextInputThreshold: openAIGpt54LongContextInputThreshold,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

const tokenPricingByModel: Record<string, TokenPricing> = {
  "gpt-5.5": gpt54Pricing,
  "gpt-5.4": gpt54Pricing,
  "gpt-5.4-mini": {
    inputUsdPerToken: 0.75e-6,
    outputUsdPerToken: 4.5e-6,
    cacheCreationUsdPerToken: 0,
    cacheReadUsdPerToken: 0.075e-6,
  },
  "gpt-5.4-nano": {
    inputUsdPerToken: 0.2e-6,
    outputUsdPerToken: 1.25e-6,
    cacheCreationUsdPerToken: 0,
    cacheReadUsdPerToken: 0.02e-6,
  },
  "gpt-5.2": {
    inputUsdPerToken: 1.75e-6,
    outputUsdPerToken: 14e-6,
    cacheCreationUsdPerToken: 1.75e-6,
    cacheReadUsdPerToken: 0.175e-6,
  },
  "gpt-5.3-codex": {
    inputUsdPerToken: 1.5e-6,
    outputUsdPerToken: 12e-6,
    cacheCreationUsdPerToken: 1.5e-6,
    cacheReadUsdPerToken: 0.15e-6,
  },
};

function createAggregate(): UsageAggregate {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheCreationCostUsd: 0,
    cacheReadCostUsd: 0,
    estimatedCostUsd: 0,
    unknownTokenCount: 0,
    unknownTokenStatusCounts: {},
    imageCount: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    p95DurationMs: 0,
    durationBuckets: {},
  };
}

function cloneAggregate(value: UsageAggregate): UsageAggregate {
  return {
    ...value,
    unknownTokenStatusCounts: { ...value.unknownTokenStatusCounts },
    durationBuckets: { ...value.durationBuckets },
  };
}

function normalizeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAggregate(value: unknown): UsageAggregate {
  if (!value || typeof value !== "object") {
    return createAggregate();
  }
  const record = value as Partial<UsageAggregate>;
  const inputTokens = Math.max(0, Math.trunc(normalizeNumber(record.inputTokens)));
  const cacheReadTokens = Math.max(0, Math.trunc(normalizeNumber(record.cacheReadTokens)));
  const aggregate: UsageAggregate = {
    requestCount: Math.max(0, Math.trunc(normalizeNumber(record.requestCount))),
    successCount: Math.max(0, Math.trunc(normalizeNumber(record.successCount))),
    failureCount: Math.max(0, Math.trunc(normalizeNumber(record.failureCount))),
    inputTokens,
    uncachedInputTokens: Math.max(0, Math.trunc(normalizeNumber(record.uncachedInputTokens, Math.max(0, inputTokens - cacheReadTokens)))),
    outputTokens: Math.max(0, Math.trunc(normalizeNumber(record.outputTokens))),
    totalTokens: Math.max(0, Math.trunc(normalizeNumber(record.totalTokens))),
    cacheCreationTokens: Math.max(0, Math.trunc(normalizeNumber(record.cacheCreationTokens))),
    cacheReadTokens,
    inputCostUsd: Math.max(0, normalizeNumber(record.inputCostUsd)),
    outputCostUsd: Math.max(0, normalizeNumber(record.outputCostUsd)),
    cacheCreationCostUsd: Math.max(0, normalizeNumber(record.cacheCreationCostUsd)),
    cacheReadCostUsd: Math.max(0, normalizeNumber(record.cacheReadCostUsd)),
    estimatedCostUsd: Math.max(0, normalizeNumber(record.estimatedCostUsd)),
    unknownTokenCount: Math.max(0, Math.trunc(normalizeNumber(record.unknownTokenCount))),
    unknownTokenStatusCounts: {},
    imageCount: Math.max(0, Math.trunc(normalizeNumber(record.imageCount))),
    totalDurationMs: Math.max(0, normalizeNumber(record.totalDurationMs)),
    averageDurationMs: 0,
    p95DurationMs: 0,
    durationBuckets: {},
  };
  if (record.durationBuckets && typeof record.durationBuckets === "object") {
    for (const [key, item] of Object.entries(record.durationBuckets)) {
      aggregate.durationBuckets[key] = Math.max(0, Math.trunc(normalizeNumber(item)));
    }
  }
  if (record.unknownTokenStatusCounts && typeof record.unknownTokenStatusCounts === "object") {
    for (const [key, item] of Object.entries(record.unknownTokenStatusCounts)) {
      aggregate.unknownTokenStatusCounts[key] = Math.max(0, Math.trunc(normalizeNumber(item)));
    }
  }
  refreshDerivedMetrics(aggregate);
  return aggregate;
}

function normalizeDimensionStore(value: unknown): Record<string, UsageDimensionRow> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const row = item && typeof item === "object" ? (item as Partial<UsageDimensionRow>) : {};
      return [
        key,
        {
          key,
          label: typeof row.label === "string" && row.label.trim() ? row.label : key,
          aggregate: normalizeAggregate(row.aggregate),
        },
      ];
    }),
  );
}

function createDailyStore(): UsageDailyStore {
  return {
    version: 1,
    updatedAt: Date.now(),
    days: {},
  };
}

function createLifetimeStore(): UsageLifetimeStore {
  return {
    version: 1,
    updatedAt: Date.now(),
    aggregate: createAggregate(),
    byAccount: {},
    byModel: {},
    byEndpoint: {},
    byError: {},
    byTokenUsageStatus: {},
    byImageRoute: {},
    bySource: {},
  };
}

function normalizeDailyStore(value: unknown): UsageDailyStore {
  if (!value || typeof value !== "object") {
    return createDailyStore();
  }
  const record = value as Partial<UsageDailyStore>;
  return {
    version: 1,
    updatedAt: normalizeNumber(record.updatedAt, Date.now()),
    days: Object.fromEntries(
      Object.entries(record.days ?? {}).map(([date, aggregate]) => [date, normalizeAggregate(aggregate)]),
    ),
  };
}

function normalizeLifetimeStore(value: unknown): UsageLifetimeStore {
  if (!value || typeof value !== "object") {
    return createLifetimeStore();
  }
  const record = value as Partial<UsageLifetimeStore>;
  return {
    version: 1,
    updatedAt: normalizeNumber(record.updatedAt, Date.now()),
    aggregate: normalizeAggregate(record.aggregate),
    byAccount: normalizeDimensionStore(record.byAccount),
    byModel: normalizeDimensionStore(record.byModel),
    byEndpoint: normalizeDimensionStore(record.byEndpoint),
    byError: normalizeDimensionStore(record.byError),
    byTokenUsageStatus: normalizeDimensionStore(record.byTokenUsageStatus),
    byImageRoute: normalizeDimensionStore(record.byImageRoute),
    bySource: normalizeDimensionStore(record.bySource),
  };
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function durationBucketKey(durationMs: number): string {
  const normalized = Math.max(0, durationMs);
  for (const limit of durationBucketLimits) {
    if (normalized <= limit) {
      return Number.isFinite(limit) ? String(limit) : "inf";
    }
  }
  return "inf";
}

function bucketKeyToDuration(key: string): number {
  if (key === "inf") {
    return 120000;
  }
  const parsed = Number.parseInt(key, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function estimateP95Duration(buckets: Record<string, number>, total: number): number {
  if (total <= 0) {
    return 0;
  }
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (const limit of durationBucketLimits) {
    const key = Number.isFinite(limit) ? String(limit) : "inf";
    seen += buckets[key] ?? 0;
    if (seen >= target) {
      return bucketKeyToDuration(key);
    }
  }
  return 0;
}

function refreshDerivedMetrics(aggregate: UsageAggregate): void {
  aggregate.averageDurationMs = aggregate.requestCount > 0 ? aggregate.totalDurationMs / aggregate.requestCount : 0;
  aggregate.p95DurationMs = estimateP95Duration(aggregate.durationBuckets, aggregate.requestCount);
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTokenUsageForEvent(value: unknown): UsageTokenUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<UsageTokenUsage>;
  const usage: UsageTokenUsage = {
    inputTokens: tokenNumber(record.inputTokens),
    uncachedInputTokens: tokenNumber(record.uncachedInputTokens),
    outputTokens: tokenNumber(record.outputTokens),
    totalTokens: tokenNumber(record.totalTokens),
    cacheCreationTokens: tokenNumber(record.cacheCreationTokens),
    cacheReadTokens: tokenNumber(record.cacheReadTokens),
  };
  return Object.values(usage).some((item) => item !== null) ? usage : null;
}

function normalizeImageRoute(value: unknown): UsageImageRoute {
  return value === "codex-tool" || value === "chatgpt-web" ? value : "none";
}

function normalizeTokenUsageStatus(value: unknown, tokenUsage: UsageTokenUsage | null, success: boolean): UsageTokenStatus {
  if (value === "captured" || value === "missing_terminal" || value === "terminal_without_usage" || value === "parse_failed" || value === "upstream_error" || value === "not_returned") {
    return value;
  }
  if (tokenNumber(tokenUsage?.totalTokens) !== null) {
    return "captured";
  }
  return success ? "not_returned" : "upstream_error";
}

function normalizeUsageRecordEvent(event: Partial<UsageRecordEvent>): NormalizedUsageRecordEvent {
  const statusCode = Math.trunc(normalizeNumber(event.statusCode));
  const timestamp = normalizeNumber(event.timestamp, Date.now());
  const success = event.success ?? (statusCode >= 200 && statusCode < 400);
  const tokenUsage = normalizeTokenUsageForEvent(event.tokenUsage);
  return {
    ...event,
    id: optionalString(event.id) ?? randomUUID(),
    timestamp,
    statusCode,
    durationMs: Math.max(0, normalizeNumber(event.durationMs)),
    endpoint: optionalString(event.endpoint) ?? "-",
    method: optionalString(event.method) ?? "-",
    model: optionalString(event.model) ?? "-",
    source: optionalString(event.source) ?? "-",
    profileId: optionalString(event.profileId),
    accountId: optionalString(event.accountId),
    accountLabel: optionalString(event.accountLabel),
    planType: optionalString(event.planType),
    errorType: optionalString(event.errorType),
    tokenUsage,
    tokenUsageStatus: normalizeTokenUsageStatus(event.tokenUsageStatus, tokenUsage, success),
    imageRoute: normalizeImageRoute(event.imageRoute),
    imageCount: Math.max(0, Math.trunc(normalizeNumber(event.imageCount))),
    success,
  };
}

function lastModelSegment(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/");
  return parts[parts.length - 1]?.trim() ?? "";
}

function canonicalizeModelForPricing(model: string): string {
  let normalized = lastModelSegment(model).toLowerCase();
  if (!normalized) {
    return "";
  }
  normalized = normalized.replaceAll("_", "-").replace(/\s+/g, "-");
  while (normalized.includes("--")) {
    normalized = normalized.replaceAll("--", "-");
  }
  if (normalized.startsWith("gpt5")) {
    normalized = `gpt-5${normalized.slice("gpt5".length)}`;
  }
  normalized = normalized
    .replaceAll("gpt-5.4mini", "gpt-5.4-mini")
    .replaceAll("gpt-5.4nano", "gpt-5.4-nano")
    .replaceAll("gpt-5.3-codexspark", "gpt-5.3-codex-spark")
    .replaceAll("gpt-5.3codexspark", "gpt-5.3-codex-spark")
    .replaceAll("gpt-5.3codex", "gpt-5.3-codex");
  const compactSuffix = "-openai-compact";
  if (normalized.endsWith(compactSuffix)) {
    normalized = normalized.slice(0, -compactSuffix.length);
  }
  return normalized;
}

function pricingKeyForModel(model: string): string | null {
  const normalized = canonicalizeModelForPricing(model);
  if (!normalized) {
    return null;
  }
  if (normalized.includes("gpt-5.5")) {
    return "gpt-5.5";
  }
  if (normalized.includes("gpt-5.4-mini")) {
    return "gpt-5.4-mini";
  }
  if (normalized.includes("gpt-5.4-nano")) {
    return "gpt-5.4-nano";
  }
  if (normalized.includes("gpt-5.4")) {
    return "gpt-5.4";
  }
  if (normalized.includes("gpt-5.2")) {
    return "gpt-5.2";
  }
  if (normalized.includes("gpt-5.3-codex") || normalized.includes("gpt-5.3") || normalized.includes("codex")) {
    return "gpt-5.3-codex";
  }
  if (normalized.includes("gpt-5")) {
    return "gpt-5.4";
  }
  return null;
}

function estimateUsageCost(model: string, tokenUsage: UsageTokenUsage | null | undefined): UsageCostBreakdown {
  const pricingKey = pricingKeyForModel(model);
  const pricing = pricingKey ? tokenPricingByModel[pricingKey] : undefined;
  if (!pricing) {
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheCreationCostUsd: 0,
      cacheReadCostUsd: 0,
      estimatedCostUsd: 0,
    };
  }

  const inputTokens = tokenNumber(tokenUsage?.inputTokens) ?? 0;
  const cacheReadTokens = tokenNumber(tokenUsage?.cacheReadTokens) ?? 0;
  const uncachedInputTokens = tokenNumber(tokenUsage?.uncachedInputTokens) ?? Math.max(0, inputTokens - cacheReadTokens);
  const outputTokens = tokenNumber(tokenUsage?.outputTokens) ?? 0;
  const cacheCreationTokens = tokenNumber(tokenUsage?.cacheCreationTokens) ?? 0;
  const totalInputTokens = uncachedInputTokens + cacheReadTokens;
  const longContext =
    pricing.longContextInputThreshold &&
    totalInputTokens > pricing.longContextInputThreshold;
  const inputMultiplier = longContext ? pricing.longContextInputMultiplier ?? 1 : 1;
  const outputMultiplier = longContext ? pricing.longContextOutputMultiplier ?? 1 : 1;
  const inputCostUsd = uncachedInputTokens * pricing.inputUsdPerToken * inputMultiplier;
  const outputCostUsd = outputTokens * pricing.outputUsdPerToken * outputMultiplier;
  const cacheCreationCostUsd = cacheCreationTokens * pricing.cacheCreationUsdPerToken;
  const cacheReadCostUsd = cacheReadTokens * pricing.cacheReadUsdPerToken;
  return {
    inputCostUsd,
    outputCostUsd,
    cacheCreationCostUsd,
    cacheReadCostUsd,
    estimatedCostUsd: inputCostUsd + outputCostUsd + cacheCreationCostUsd + cacheReadCostUsd,
  };
}

function tokenUsageStatusForEvent(event: UsageRecordEvent): UsageTokenStatus {
  return normalizeTokenUsageStatus(event.tokenUsageStatus, event.tokenUsage ?? null, event.success ?? (event.statusCode >= 200 && event.statusCode < 400));
}

function addToAggregate(aggregate: UsageAggregate, event: Required<Pick<UsageRecordEvent, "statusCode" | "durationMs">> & UsageRecordEvent): void {
  const success = event.success ?? (event.statusCode >= 200 && event.statusCode < 400);
  const inputTokens = tokenNumber(event.tokenUsage?.inputTokens);
  const cacheReadTokens = tokenNumber(event.tokenUsage?.cacheReadTokens);
  const cacheCreationTokens = tokenNumber(event.tokenUsage?.cacheCreationTokens);
  const inferredUncachedInputTokens = inputTokens !== null ? Math.max(0, inputTokens - (cacheReadTokens ?? 0)) : null;
  const uncachedInputTokens = tokenNumber(event.tokenUsage?.uncachedInputTokens) ?? inferredUncachedInputTokens;
  const outputTokens = tokenNumber(event.tokenUsage?.outputTokens);
  const totalTokens = tokenNumber(event.tokenUsage?.totalTokens) ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);
  const cost = estimateUsageCost(event.model, event.tokenUsage);
  aggregate.requestCount += 1;
  aggregate.successCount += success ? 1 : 0;
  aggregate.failureCount += success ? 0 : 1;
  aggregate.inputTokens += inputTokens ?? 0;
  aggregate.uncachedInputTokens += uncachedInputTokens ?? 0;
  aggregate.outputTokens += outputTokens ?? 0;
  aggregate.totalTokens += totalTokens ?? 0;
  aggregate.cacheCreationTokens += cacheCreationTokens ?? 0;
  aggregate.cacheReadTokens += cacheReadTokens ?? 0;
  aggregate.inputCostUsd += cost.inputCostUsd;
  aggregate.outputCostUsd += cost.outputCostUsd;
  aggregate.cacheCreationCostUsd += cost.cacheCreationCostUsd;
  aggregate.cacheReadCostUsd += cost.cacheReadCostUsd;
  aggregate.estimatedCostUsd += cost.estimatedCostUsd;
  if (totalTokens === null) {
    const tokenUsageStatus = tokenUsageStatusForEvent(event);
    aggregate.unknownTokenCount += 1;
    aggregate.unknownTokenStatusCounts[tokenUsageStatus] = (aggregate.unknownTokenStatusCounts[tokenUsageStatus] ?? 0) + 1;
  }
  aggregate.imageCount += Math.max(0, Math.trunc(event.imageCount ?? 0));
  aggregate.totalDurationMs += Math.max(0, event.durationMs);
  const bucket = durationBucketKey(event.durationMs);
  aggregate.durationBuckets[bucket] = (aggregate.durationBuckets[bucket] ?? 0) + 1;
  refreshDerivedMetrics(aggregate);
}

function imageRouteLabel(route: string): string {
  if (route === "codex-tool") {
    return "Codex 图片工具";
  }
  if (route === "chatgpt-web") {
    return "ChatGPT 网页生图";
  }
  return "非生图";
}

function tokenUsageStatusLabel(status: string): string {
  if (status === "captured") {
    return "已捕获用量";
  }
  if (status === "missing_terminal") {
    return "缺少终态事件";
  }
  if (status === "terminal_without_usage") {
    return "终态无 usage";
  }
  if (status === "parse_failed") {
    return "SSE 解析失败";
  }
  if (status === "upstream_error") {
    return "上游错误";
  }
  return "未返回 usage";
}

function addEventToStores(daily: UsageDailyStore, lifetime: UsageLifetimeStore, normalized: NormalizedUsageRecordEvent): void {
  const date = formatLocalDate(normalized.timestamp);
  daily.days[date] = daily.days[date] ? normalizeAggregate(daily.days[date]) : createAggregate();
  addToAggregate(daily.days[date], normalized);
  addToAggregate(lifetime.aggregate, normalized);
  bumpDimension(lifetime.byAccount, normalized.profileId || normalized.accountId || normalized.accountLabel || "-", normalized.accountLabel || normalized.accountId || normalized.profileId || "-", normalized);
  bumpDimension(lifetime.byModel, normalized.model || "-", normalized.model || "-", normalized);
  bumpDimension(lifetime.byEndpoint, `${normalized.method} ${normalized.endpoint}`, `${normalized.method} ${normalized.endpoint}`, normalized);
  bumpDimension(lifetime.bySource, normalized.source || "-", normalized.source || "-", normalized);
  bumpDimension(lifetime.byTokenUsageStatus, normalized.tokenUsageStatus ?? "not_returned", tokenUsageStatusLabel(normalized.tokenUsageStatus ?? "not_returned"), normalized);
  bumpDimension(lifetime.byImageRoute, normalized.imageRoute, imageRouteLabel(normalized.imageRoute), normalized);
  if (!normalized.success) {
    const errorType = normalized.errorType?.trim() || `HTTP ${normalized.statusCode}`;
    bumpDimension(lifetime.byError, errorType, errorType, normalized);
  }
  daily.updatedAt = Math.max(daily.updatedAt, normalized.timestamp);
  lifetime.updatedAt = Math.max(lifetime.updatedAt, normalized.timestamp);
}

function bumpDimension(store: Record<string, UsageDimensionRow>, key: string, label: string, event: UsageRecordEvent & { statusCode: number; durationMs: number }): void {
  const normalizedKey = key.trim() || "-";
  const existing = store[normalizedKey] ?? {
    key: normalizedKey,
    label: label.trim() || normalizedKey,
    aggregate: createAggregate(),
  };
  existing.label = label.trim() || existing.label;
  addToAggregate(existing.aggregate, event);
  store[normalizedKey] = existing;
}

function topRows(store: Record<string, UsageDimensionRow>, limit = 12): UsageDimensionRow[] {
  return Object.values(store)
    .sort((a, b) => b.aggregate.requestCount - a.aggregate.requestCount || b.aggregate.totalTokens - a.aggregate.totalTokens || a.label.localeCompare(b.label, "zh-CN"))
    .slice(0, limit)
    .map((row) => ({
      key: row.key,
      label: row.label,
      aggregate: cloneAggregate(row.aggregate),
    }));
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function formatBackupTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

async function uniqueBackupDir(usageDir: string): Promise<string> {
  const parentDir = path.dirname(usageDir);
  const baseName = `${path.basename(usageDir)}.backup.${formatBackupTimestamp()}`;
  let candidate = path.join(parentDir, baseName);
  for (let index = 2; await fileExists(candidate); index += 1) {
    candidate = path.join(parentDir, `${baseName}-${index}`);
  }
  return candidate;
}

function aggregateNeedsCostBackfill(aggregate: UsageAggregate): boolean {
  return aggregate.totalTokens > 0 && aggregate.estimatedCostUsd <= 0;
}

function shouldBackfillUsageCosts(daily: UsageDailyStore, lifetime: UsageLifetimeStore): boolean {
  const knownPricedModelMissingCost = Object.values(lifetime.byModel).some((row) =>
    aggregateNeedsCostBackfill(row.aggregate) && pricingKeyForModel(row.key) !== null,
  );
  if (!knownPricedModelMissingCost) {
    return false;
  }
  return aggregateNeedsCostBackfill(lifetime.aggregate) || Object.values(daily.days).some(aggregateNeedsCostBackfill);
}

function shouldBackfillUsageDiagnostics(daily: UsageDailyStore, lifetime: UsageLifetimeStore): boolean {
  if (lifetime.aggregate.requestCount <= 0) {
    return false;
  }
  if (Object.keys(lifetime.byTokenUsageStatus).length === 0) {
    return true;
  }
  if (lifetime.aggregate.unknownTokenCount > 0 && Object.keys(lifetime.aggregate.unknownTokenStatusCounts).length === 0) {
    return true;
  }
  return Object.values(daily.days).some((aggregate) =>
    aggregate.unknownTokenCount > 0 && Object.keys(aggregate.unknownTokenStatusCounts).length === 0,
  );
}

async function rebuildStoresFromEventLogs(): Promise<{ daily: UsageDailyStore; lifetime: UsageLifetimeStore } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(getUsageEventsDir());
  } catch {
    return null;
  }

  const eventFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  if (eventFiles.length === 0) {
    return null;
  }

  const daily = createDailyStore();
  const lifetime = createLifetimeStore();
  let seen = false;
  for (const fileName of eventFiles) {
    let content: string;
    try {
      content = await fs.readFile(path.join(getUsageEventsDir(), fileName), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Partial<UsageRecordEvent>;
        addEventToStores(daily, lifetime, normalizeUsageRecordEvent(parsed));
        seen = true;
      } catch {
        // Ignore malformed historical rows; new writes are still validated by record().
      }
    }
  }

  return seen ? { daily, lifetime } : null;
}

export class UsageService {
  private readonly startedAt = Date.now();
  private readonly startupAggregate = createAggregate();
  private dailyStore: UsageDailyStore | null = null;
  private lifetimeStore: UsageLifetimeStore | null = null;
  private loadPromise: Promise<void> | null = null;
  private saveQueue = Promise.resolve();

  async record(event: UsageRecordEvent): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizeUsageRecordEvent(event);
    const timestamp = normalized.timestamp;
    const date = formatLocalDate(timestamp);
    const daily = this.dailyStore ?? createDailyStore();
    const lifetime = this.lifetimeStore ?? createLifetimeStore();
    addToAggregate(this.startupAggregate, normalized);
    addEventToStores(daily, lifetime, normalized);
    this.dailyStore = daily;
    this.lifetimeStore = lifetime;

    const eventPath = path.join(getUsageEventsDir(), `${date}.jsonl`);
    const dailyPath = getUsageDailyPath();
    const lifetimePath = getUsageLifetimePath();
    this.saveQueue = this.saveQueue.then(async () => {
      await fs.mkdir(getUsageEventsDir(), { recursive: true });
      await fs.appendFile(eventPath, `${JSON.stringify(normalized)}\n`, "utf8");
      await Promise.all([
        writeJsonAtomic(dailyPath, daily),
        writeJsonAtomic(lifetimePath, lifetime),
      ]);
    }, async () => {
      await fs.mkdir(getUsageEventsDir(), { recursive: true });
      await fs.appendFile(eventPath, `${JSON.stringify(normalized)}\n`, "utf8");
      await Promise.all([
        writeJsonAtomic(dailyPath, daily),
        writeJsonAtomic(lifetimePath, lifetime),
      ]);
    });
    await this.saveQueue;
  }

  async getSummary(): Promise<UsageSummary> {
    await this.ensureLoaded();
    const daily = this.dailyStore ?? createDailyStore();
    const lifetime = this.lifetimeStore ?? createLifetimeStore();
    const todayDate = formatLocalDate(Date.now());
    return {
      generatedAt: Date.now(),
      startedAt: this.startedAt,
      todayDate,
      storageDir: getUsageDir(),
      startup: cloneAggregate(this.startupAggregate),
      today: cloneAggregate(daily.days[todayDate] ?? createAggregate()),
      lifetime: cloneAggregate(lifetime.aggregate),
      daily: Object.entries(daily.days)
        .sort(([left], [right]) => right.localeCompare(left))
        .slice(0, 30)
        .map(([date, aggregate]) => ({ date, aggregate: cloneAggregate(aggregate) })),
      byAccount: topRows(lifetime.byAccount, 16),
      byModel: topRows(lifetime.byModel, 16),
      byEndpoint: topRows(lifetime.byEndpoint, 16),
      byError: topRows(lifetime.byError, 16),
      byTokenUsageStatus: topRows(lifetime.byTokenUsageStatus, 8),
      byImageRoute: topRows(lifetime.byImageRoute, 8),
      bySource: topRows(lifetime.bySource, 8),
    };
  }

  async backupAndReset(): Promise<UsageResetResult> {
    await this.ensureLoaded();
    let backupDir = "";
    const reset = async () => {
      const usageDir = getUsageDir();
      await fs.mkdir(path.dirname(usageDir), { recursive: true });
      backupDir = await uniqueBackupDir(usageDir);
      if (await fileExists(usageDir)) {
        await fs.rename(usageDir, backupDir);
      } else {
        await fs.mkdir(backupDir, { recursive: true });
      }

      const daily = createDailyStore();
      const lifetime = createLifetimeStore();
      Object.assign(this.startupAggregate, createAggregate());
      this.dailyStore = daily;
      this.lifetimeStore = lifetime;
      await fs.mkdir(getUsageEventsDir(), { recursive: true });
      await Promise.all([
        writeJsonAtomic(getUsageDailyPath(), daily),
        writeJsonAtomic(getUsageLifetimePath(), lifetime),
      ]);
    };
    this.saveQueue = this.saveQueue.then(reset, reset);
    await this.saveQueue;
    return {
      backupDir,
      usage: await this.getSummary(),
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await ensureStateMigrated();
        await fs.mkdir(getUsageDir(), { recursive: true });
        await fs.mkdir(getUsageEventsDir(), { recursive: true });
        const [dailyRaw, lifetimeRaw] = await Promise.all([
          readJsonFile(getUsageDailyPath()),
          readJsonFile(getUsageLifetimePath()),
        ]);
        this.dailyStore = normalizeDailyStore(dailyRaw);
        this.lifetimeStore = normalizeLifetimeStore(lifetimeRaw);
        if (shouldBackfillUsageCosts(this.dailyStore, this.lifetimeStore) || shouldBackfillUsageDiagnostics(this.dailyStore, this.lifetimeStore)) {
          const rebuilt = await rebuildStoresFromEventLogs();
          if (rebuilt) {
            this.dailyStore = rebuilt.daily;
            this.lifetimeStore = rebuilt.lifetime;
            await Promise.all([
              writeJsonAtomic(getUsageDailyPath(), rebuilt.daily),
              writeJsonAtomic(getUsageLifetimePath(), rebuilt.lifetime),
            ]);
          }
        }
      })();
    }
    await this.loadPromise;
  }
}
