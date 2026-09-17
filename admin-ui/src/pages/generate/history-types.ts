export type ImageQuality = "low" | "medium" | "high" | "auto";
export type OutputFormat = "png" | "webp" | "jpeg";
export type HistoryViewMode = "grid" | "list";
export type GenerationHistoryStatus = "queued" | "running" | "success" | "failed" | "interrupted";

export type GenerateHistoryItem = {
  id: string;
  owner?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt?: number;
  status: GenerationHistoryStatus;
  endpoint: string;
  account: string;
  model: string;
  prompt: string;
  ratio?: string;
  size?: string;
  quality?: ImageQuality;
  outputFormat?: OutputFormat;
  durationMs: number;
  waitDurationMs?: number;
  request?: { n?: number };
  responseSummary?: Record<string, unknown>;
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

export type GenerateHistoryResponse = {
  items: GenerateHistoryItem[];
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
};

export type GenerationOwnerUsageResponse = {
  items: Array<{ owner: string; count: number }>;
  total: number;
};

export type HistoryOwnerOption = {
  value: string;
  label: string;
  searchText: string;
  count: number;
  kind: "mine" | "all" | "user";
};

export type HistoryStatusFilter = "all" | GenerationHistoryStatus;

