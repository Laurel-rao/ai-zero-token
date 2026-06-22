export type QuotaSnapshot = {
  capturedAt?: number;
  sourceRequestId?: string;
  activeLimit?: string;
  planType?: string;
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  primaryWindowMinutes?: number;
  secondaryWindowMinutes?: number;
  primaryResetAfterSeconds?: number;
  secondaryResetAfterSeconds?: number;
  primaryResetAt?: number;
  secondaryResetAt?: number;
  creditsHasCredits?: boolean;
  creditsUnlimited?: boolean;
  creditsBalance?: string;
  promoMessage?: string;
};

export type AuthStatus = {
  state: "ok" | "token_invalidated" | "auth_error";
  checkedAt: number;
  message?: string;
  code?: string;
  httpStatus?: number;
};

export type ProfileExportAudit = {
  exported: boolean;
  count: number;
  firstExportedAt?: number;
  lastExportedAt?: number;
  lastExportKind?: "single" | "batch" | "all";
};

export type ProfileSummary = {
  provider: string;
  profileId: string;
  accountId: string;
  codexAccountId?: string;
  accountIdSource?: "chatgpt_account_id" | "account_id" | "chatgpt_user_id" | "user_id" | "sub" | "email" | "access_token_sha256";
  codexApplySupported: boolean;
  codexApplyReason?: string;
  email?: string;
  quota?: QuotaSnapshot;
  authStatus?: AuthStatus;
  expiresAt: number;
  accessTokenPreview: string;
  refreshTokenPreview: string;
  isActive: boolean;
  exportAudit?: ProfileExportAudit;
};

export type GatewaySettings = {
  version: number;
  defaultProvider: string;
  defaultModel: string;
  branding: {
    title: string;
    appIconUrl: string;
    faviconUrl: string;
  };
  networkProxy: {
    enabled: boolean;
    url: string;
    noProxy: string;
  };
  autoSwitch: {
    enabled: boolean;
    excludedProfileIds: string[];
  };
  accountRotation: {
    enabled: boolean;
    strategy: "round_robin";
  };
  runtime: {
    quotaSyncConcurrency: number;
    accountMaxConcurrency: number;
    codexRequestSerializationEnabled: boolean;
    codexRequestMinDelayMs: number;
    codexRequestJitterMs: number;
  };
  image: {
    freeAccountWebGenerationEnabled: boolean;
    limits?: {
      enabled: boolean;
      perUserDaily: number;
      perUserHourly: number;
      minIntervalSeconds: number;
      userOverrides: Array<{
        username: string;
        perUserDaily?: number;
        perUserHourly?: number;
        minIntervalSeconds?: number;
      }>;
    };
  };
  wecom: {
    enabled: boolean;
    corpId: string;
    agentId: string;
    secret: string;
  };
  server: {
    host: string;
    port: number;
  };
};

export type GatewayStatus = {
  ok: boolean;
  activeProvider?: string;
  activeProfileId?: string;
  defaultModel: string;
  loggedIn: boolean;
  expiresAt?: number;
  profileCount: number;
  serverHost: string;
  serverPort: number;
};

export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
  input: Array<"text" | "image">;
  source: string;
  isDefault?: boolean;
};

export type ModelCatalogInfo = {
  source: string;
  cachePath: string;
  fetchedAt?: string;
  modelCount: number;
};

export type ModelAutoRefreshStatus = {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  nextRunAt?: number;
  lastModelCount?: number;
  lastSource?: string;
  lastError?: string;
};

export type VersionStatus = {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  checkedAt: number;
  needsUpdate: boolean;
  registryUrl: string;
  status: "ok" | "update-available" | "error";
  error?: string;
};

export type SupportedEndpoint = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
};

export type GatewayShareAddress = {
  host: string;
  label: string;
  adminUrl: string;
  baseUrl: string;
  codexBaseUrl: string;
};

export type GatewayShareInfo = {
  primary: GatewayShareAddress | null;
  addresses: GatewayShareAddress[];
  local: GatewayShareAddress;
  serverHost: string;
  serverPort: number;
  lanReachable: boolean;
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

export type AdminConfig = {
  auth?: {
    user: string;
    role: "admin" | "user";
  } | null;
  status: GatewayStatus;
  settings: GatewaySettings;
  models: ModelInfo[];
  modelCatalog: ModelCatalogInfo;
  modelAutoRefresh?: ModelAutoRefreshStatus;
  versionStatus: VersionStatus;
  profile: ProfileSummary | null;
  profiles: ProfileSummary[];
  users?: Array<{
    username: string;
    displayName?: string;
  }>;
  codex: {
    exists: boolean;
    path: string;
    accountId?: string;
    email?: string;
    gatewayProvider: {
      path: string;
      providerId: string;
      exists: boolean;
      active: boolean;
      baseUrl?: string;
      modelProvider?: string;
    };
  };
  usage?: UsageSummary;
  adminUrl: string;
  baseUrl: string;
  codexBaseUrl?: string;
  supportedEndpoints: SupportedEndpoint[];
  restartSupported?: boolean;
  codexRestartSupported?: boolean;
};

export type RequestLog = {
  id: string;
  owner?: string;
  time: number;
  method: string;
  endpoint: string;
  account: string;
  model: string;
  statusCode: number;
  durationMs: number;
  source: string;
  details?: Record<string, unknown>;
};
