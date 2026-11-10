import fs from "node:fs/promises";
import { DEFAULT_IMAGE_MODEL, VERSION_DEFAULT_IMAGE_MODELS } from "../models/image-models.js";
import type { GatewaySettings } from "../types.js";
import { getGatewaySqlDatabase } from "./gateway-sql-database.js";
import {
  ensureStateMigrated,
  getSettingsPath,
  getStateDir,
} from "./state-paths.js";

const SETTINGS_ROW_ID = "gateway";
const DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
  "你是专业的 AI 生图提示词优化助手。",
  "请把用户的原始提示词改写成更适合图像生成模型的中文提示词。",
  "保留用户明确指定的主体、风格、文字、尺寸、颜色和限制。",
  "增强画面主体、构图、光线、材质、背景、镜头语言和细节层次。",
  "只输出优化后的提示词正文，不要解释，不要 Markdown，不要添加标题。",
].join("\n");

let settingsDbReady = false;

export const CURRENT_SETTINGS_VERSION = 3;

export function createDefaultSettings(): GatewaySettings {
  return {
    version: CURRENT_SETTINGS_VERSION,
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.4",
    modelRouting: {
      chatModel: "gpt-5.4",
      imageClassifierModel: "gpt-5.6-terra",
      imageGenerationModel: DEFAULT_IMAGE_MODEL,
      imageOrchestratorModel: "gpt-5.6-terra",
      promptOptimizerModel: "gpt-5.4",
    },
    branding: {
      title: "AI Zero Token",
      appIconUrl: "",
      faviconUrl: "",
    },
    security: {
      apiKeyHash: "",
    },
    networkProxy: {
      enabled: false,
      url: "",
      noProxy: "localhost,127.0.0.1,::1",
    },
    autoSwitch: {
      enabled: false,
      excludedProfileIds: [],
    },
    accountRotation: {
      enabled: false,
      strategy: "round_robin",
    },
    runtime: {
      quotaSyncConcurrency: 3,
      accountMaxConcurrency: 2,
      codexRequestSerializationEnabled: true,
      codexRequestMinDelayMs: 2500,
      codexRequestJitterMs: 1500,
    },
    image: {
      freeAccountWebGenerationEnabled: false,
      generationTimeoutMs: 10 * 60 * 1000,
      promptOptimizerSystemPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
      limits: {
        enabled: false,
        perUserDaily: 0,
        perUserHourly: 0,
        minIntervalSeconds: 0,
        userOverrides: [],
      },
      apiChannel: {
        enabled: false,
        mode: "primary",
        baseUrl: "",
        apiKey: "",
        model: DEFAULT_IMAGE_MODEL,
      },
    },
    llm: {
      apiChannel: {
        enabled: false,
        mode: "primary",
        baseUrl: "",
        apiKey: "",
        model: "",
        models: [],
      },
    },
    wecom: {
      enabled: false,
      corpId: "",
      agentId: "",
      secret: "",
      notifyImageResult: true,
      callbackToken: "",
      callbackAesKey: "",
      chatEnabled: false,
    },
    server: {
      host: "0.0.0.0",
      port: 8787,
    },
  };
}

function normalizeSettings(parsed: Partial<GatewaySettings>): GatewaySettings {
  const defaults = createDefaultSettings();
  return {
    version: CURRENT_SETTINGS_VERSION,
    defaultProvider: parsed.defaultProvider ?? defaults.defaultProvider,
    defaultModel: parsed.defaultModel ?? defaults.defaultModel,
    modelRouting: {
      chatModel: normalizeTrimmedString(parsed.modelRouting?.chatModel, parsed.defaultModel ?? defaults.modelRouting.chatModel, 120),
      imageClassifierModel: normalizeTrimmedString(parsed.modelRouting?.imageClassifierModel, defaults.modelRouting.imageClassifierModel, 120) || defaults.modelRouting.imageClassifierModel,
      imageGenerationModel: normalizeImageGenerationModel(parsed.modelRouting?.imageGenerationModel, defaults.modelRouting.imageGenerationModel, parsed.version),
      imageOrchestratorModel: normalizeTrimmedString(parsed.modelRouting?.imageOrchestratorModel, defaults.modelRouting.imageOrchestratorModel, 120) || defaults.modelRouting.imageOrchestratorModel,
      promptOptimizerModel: normalizeTrimmedString(parsed.modelRouting?.promptOptimizerModel, parsed.defaultModel ?? defaults.modelRouting.promptOptimizerModel, 120),
    },
    branding: normalizeBranding(parsed.branding, defaults.branding),
    security: {
      apiKeyHash: normalizeTrimmedString(parsed.security?.apiKeyHash, defaults.security.apiKeyHash, 128),
    },
    networkProxy: {
      enabled: parsed.networkProxy?.enabled ?? defaults.networkProxy.enabled,
      url: parsed.networkProxy?.url ?? defaults.networkProxy.url,
      noProxy: parsed.networkProxy?.noProxy ?? defaults.networkProxy.noProxy,
    },
    autoSwitch: {
      enabled: parsed.autoSwitch?.enabled ?? defaults.autoSwitch.enabled,
      excludedProfileIds: normalizeStringList(parsed.autoSwitch?.excludedProfileIds),
    },
    accountRotation: {
      enabled: parsed.accountRotation?.enabled ?? defaults.accountRotation.enabled,
      strategy: "round_robin",
    },
    runtime: {
      quotaSyncConcurrency: normalizeQuotaSyncConcurrency(parsed.runtime?.quotaSyncConcurrency, defaults.runtime.quotaSyncConcurrency),
      accountMaxConcurrency: normalizeAccountMaxConcurrency(parsed.runtime?.accountMaxConcurrency, defaults.runtime.accountMaxConcurrency),
      codexRequestSerializationEnabled: parsed.runtime?.codexRequestSerializationEnabled ?? defaults.runtime.codexRequestSerializationEnabled,
      codexRequestMinDelayMs: normalizeMilliseconds(parsed.runtime?.codexRequestMinDelayMs, defaults.runtime.codexRequestMinDelayMs, 0, 60_000),
      codexRequestJitterMs: normalizeMilliseconds(parsed.runtime?.codexRequestJitterMs, defaults.runtime.codexRequestJitterMs, 0, 60_000),
    },
    image: {
      freeAccountWebGenerationEnabled: parsed.image?.freeAccountWebGenerationEnabled ?? defaults.image.freeAccountWebGenerationEnabled,
      generationTimeoutMs: normalizeMilliseconds(parsed.image?.generationTimeoutMs, defaults.image.generationTimeoutMs, 60_000, 30 * 60 * 1000),
      promptOptimizerSystemPrompt: normalizeTrimmedString(parsed.image?.promptOptimizerSystemPrompt, defaults.image.promptOptimizerSystemPrompt, 8000),
      limits: normalizeImageLimits(parsed.image?.limits, defaults.image.limits),
      apiChannel: normalizeImageApiChannel(parsed.image?.apiChannel, defaults.image.apiChannel),
    },
    llm: {
      apiChannel: normalizeLlmApiChannel(parsed.llm?.apiChannel, defaults.llm.apiChannel),
    },
    wecom: {
      enabled: parsed.wecom?.enabled ?? defaults.wecom.enabled,
      corpId: parsed.wecom?.corpId ?? defaults.wecom.corpId,
      agentId: parsed.wecom?.agentId ?? defaults.wecom.agentId,
      secret: parsed.wecom?.secret ?? defaults.wecom.secret,
      notifyImageResult: parsed.wecom?.notifyImageResult ?? defaults.wecom.notifyImageResult,
      callbackToken: normalizeTrimmedString(parsed.wecom?.callbackToken, defaults.wecom.callbackToken, 64),
      callbackAesKey: normalizeTrimmedString(parsed.wecom?.callbackAesKey, defaults.wecom.callbackAesKey, 64),
      chatEnabled: parsed.wecom?.chatEnabled ?? defaults.wecom.chatEnabled,
    },
    server: {
      host: parsed.server?.host ?? defaults.server.host,
      port: parsed.server?.port ?? defaults.server.port,
    },
  };
}

export async function loadSettings(): Promise<GatewaySettings> {
  try {
    await ensureSettingsDatabase();
    const row = await getGatewaySqlDatabase().get<{ valueJson?: unknown }>("SELECT value_json AS valueJson FROM gateway_settings WHERE id = ?", SETTINGS_ROW_ID);
    if (typeof row?.valueJson === "string" && row.valueJson) {
      const parsed = JSON.parse(row.valueJson) as Partial<GatewaySettings>;
      const normalized = normalizeSettings(parsed);
      await persistSettingsVersionUpgrade(parsed.version, normalized);
      return normalized;
    }
    if (row?.valueJson && typeof row.valueJson === "object" && !Array.isArray(row.valueJson)) {
      const parsed = row.valueJson as Partial<GatewaySettings>;
      const normalized = normalizeSettings(parsed);
      await persistSettingsVersionUpgrade(parsed.version, normalized);
      return normalized;
    }

    const imported = await importLegacySettings();
    await writeSettingsToDatabase(imported);
    return imported;
  } catch {
    return createDefaultSettings();
  }
}

export function normalizeQuotaSyncConcurrency(value: unknown, fallback = 3): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(32, Math.max(1, Math.trunc(parsed)));
}

export function normalizeAccountMaxConcurrency(value: unknown, fallback = 2): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(32, Math.max(1, Math.trunc(parsed)));
}

export function normalizeMilliseconds(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function normalizeCountLimit(value: unknown, fallback = 0, max = 100_000): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(0, Math.trunc(parsed)));
}

type ImageLimitsSettings = GatewaySettings["image"]["limits"];
type ImageApiChannelSettings = GatewaySettings["image"]["apiChannel"];
type LlmApiChannelSettings = GatewaySettings["llm"]["apiChannel"];
type BrandingSettings = GatewaySettings["branding"];

function normalizeBranding(value: unknown, fallback: BrandingSettings): BrandingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    title: normalizeTrimmedString(record.title, fallback.title, 80),
    appIconUrl: normalizeTrimmedString(record.appIconUrl, fallback.appIconUrl, 500),
    faviconUrl: normalizeTrimmedString(record.faviconUrl, fallback.faviconUrl, 500),
  };
}

function normalizeTrimmedString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().slice(0, maxLength);
}

/**
 * 生图服务模型迁移：记录里的值只要仍等于它所属结构版本的默认值，就视为管理员没有显式选择过，
 * 自动升级到当前默认生图模型。结构版本已是当前版本时不再改写，管理员显式选过的模型一律保留。
 */
function normalizeImageGenerationModel(value: unknown, fallback: string, storedVersion: unknown): string {
  const model = normalizeTrimmedString(value, fallback, 120);
  const version = typeof storedVersion === "number" && Number.isFinite(storedVersion) ? Math.trunc(storedVersion) : 1;
  if (version < CURRENT_SETTINGS_VERSION && model === VERSION_DEFAULT_IMAGE_MODELS[version]) {
    return fallback;
  }
  return model;
}

function normalizeImageLimitOverride(value: unknown): ImageLimitsSettings["userOverrides"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const username = typeof record.username === "string" ? record.username.trim() : "";
  if (!username) {
    return null;
  }

  return {
    username,
    ...(record.perUserDaily === undefined ? {} : { perUserDaily: normalizeCountLimit(record.perUserDaily, 0) }),
    ...(record.perUserHourly === undefined ? {} : { perUserHourly: normalizeCountLimit(record.perUserHourly, 0) }),
    ...(record.minIntervalSeconds === undefined ? {} : { minIntervalSeconds: normalizeCountLimit(record.minIntervalSeconds, 0, 86_400) }),
  };
}

function normalizeImageLimitOverrides(value: unknown): ImageLimitsSettings["userOverrides"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byUsername = new Map<string, ImageLimitsSettings["userOverrides"][number]>();
  for (const item of value) {
    const normalized = normalizeImageLimitOverride(item);
    if (normalized) {
      byUsername.set(normalized.username, normalized);
    }
  }
  return Array.from(byUsername.values()).sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
}

function normalizeImageLimits(value: unknown, fallback: ImageLimitsSettings): ImageLimitsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    perUserDaily: normalizeCountLimit(record.perUserDaily, fallback.perUserDaily),
    perUserHourly: normalizeCountLimit(record.perUserHourly, fallback.perUserHourly),
    minIntervalSeconds: normalizeCountLimit(record.minIntervalSeconds, fallback.minIntervalSeconds, 86_400),
    userOverrides: record.userOverrides === undefined ? fallback.userOverrides : normalizeImageLimitOverrides(record.userOverrides),
  };
}

function normalizeImageApiChannel(value: unknown, fallback: ImageApiChannelSettings): ImageApiChannelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    mode: record.mode === "fallback" ? "fallback" : record.mode === "primary" ? "primary" : fallback.mode,
    baseUrl: normalizeTrimmedString(record.baseUrl, fallback.baseUrl, 500),
    apiKey: normalizeTrimmedString(record.apiKey, fallback.apiKey, 500),
    model: normalizeTrimmedString(record.model, fallback.model, 120) || fallback.model,
  };
}

function normalizeLlmApiChannel(value: unknown, fallback: LlmApiChannelSettings): LlmApiChannelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    mode: record.mode === "fallback" ? "fallback" : record.mode === "primary" ? "primary" : fallback.mode,
    baseUrl: normalizeTrimmedString(record.baseUrl, fallback.baseUrl, 500),
    apiKey: normalizeTrimmedString(record.apiKey, fallback.apiKey, 500),
    // 大模型渠道未启用时允许模型留空，只有真正调用时才要求填好。
    model: normalizeTrimmedString(record.model, fallback.model, 200),
    models: normalizeLlmApiChannelModels(record.models),
  };
}

/** 渠道模型 id 归一化：只保留字符串、trim、去空、去重，最多 200 个，每个最长 200 字符。 */
export function normalizeLlmApiChannelModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const model = item.trim().slice(0, 200);
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
    if (models.length >= 200) {
      break;
    }
  }
  return models;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

let settingsSaveQueue = Promise.resolve();

async function ensureSettingsDatabase(): Promise<void> {
  await ensureStateMigrated();
  await fs.mkdir(getStateDir(), { recursive: true });
  if (settingsDbReady) {
    return;
  }

  await getGatewaySqlDatabase().exec(`
    CREATE TABLE IF NOT EXISTS gateway_settings (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  settingsDbReady = true;
}

/**
 * 旧版本设置升级时把结构版本写回，避免每次读取都重新触发默认值迁移，
 * 也让管理员后续可以再次显式选择旧默认模型。
 */
async function persistSettingsVersionUpgrade(storedVersion: unknown, normalized: GatewaySettings): Promise<void> {
  const version = typeof storedVersion === "number" && Number.isFinite(storedVersion) ? storedVersion : 1;
  if (version >= normalized.version) {
    return;
  }
  try {
    await writeSettingsToDatabase(normalized);
  } catch {
    // 写回失败不影响本次读取，下次读取会再次尝试迁移。
  }
}

async function importLegacySettings(): Promise<GatewaySettings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewaySettings>;
    return normalizeSettings(parsed);
  } catch {
    return createDefaultSettings();
  }
}

async function writeSettingsToDatabase(settings: GatewaySettings): Promise<void> {
  await ensureSettingsDatabase();
  const now = Date.now();
  await getGatewaySqlDatabase().run(
    `
      INSERT INTO gateway_settings (id, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
    SETTINGS_ROW_ID,
    JSON.stringify(normalizeSettings(settings)),
    now,
    now,
  );
}

export async function saveSettings(settings: GatewaySettings): Promise<void> {
  const nextSave = settingsSaveQueue.then(() => writeSettingsToDatabase(settings), () => writeSettingsToDatabase(settings));
  settingsSaveQueue = nextSave.catch(() => undefined);
  await nextSave;
}

export { getSettingsPath };
