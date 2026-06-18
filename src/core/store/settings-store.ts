import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { GatewaySettings } from "../types.js";
import {
  ensureStateMigrated,
  getSettingsPath,
  getStateDir,
} from "./state-paths.js";

export function createDefaultSettings(): GatewaySettings {
  return {
    version: 1,
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.4",
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
      limits: {
        enabled: false,
        perUserDaily: 0,
        perUserHourly: 0,
        minIntervalSeconds: 0,
        userOverrides: [],
      },
    },
    wecom: {
      enabled: false,
      corpId: "",
      agentId: "",
      secret: "",
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
    version: 1,
    defaultProvider: parsed.defaultProvider ?? defaults.defaultProvider,
    defaultModel: parsed.defaultModel ?? defaults.defaultModel,
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
      limits: normalizeImageLimits(parsed.image?.limits, defaults.image.limits),
    },
    wecom: {
      enabled: parsed.wecom?.enabled ?? defaults.wecom.enabled,
      corpId: parsed.wecom?.corpId ?? defaults.wecom.corpId,
      agentId: parsed.wecom?.agentId ?? defaults.wecom.agentId,
      secret: parsed.wecom?.secret ?? defaults.wecom.secret,
    },
    server: {
      host: parsed.server?.host ?? defaults.server.host,
      port: parsed.server?.port ?? defaults.server.port,
    },
  };
}

export async function loadSettings(): Promise<GatewaySettings> {
  try {
    await ensureStateMigrated();
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewaySettings>;
    return normalizeSettings(parsed);
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
    userOverrides: normalizeImageLimitOverrides(record.userOverrides),
  };
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

async function writeSettingsAtomic(settings: GatewaySettings): Promise<void> {
  await ensureStateMigrated();
  await fs.mkdir(getStateDir(), { recursive: true });

  const settingsPath = getSettingsPath();
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, settingsPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveSettings(settings: GatewaySettings): Promise<void> {
  const nextSave = settingsSaveQueue.then(() => writeSettingsAtomic(settings), () => writeSettingsAtomic(settings));
  settingsSaveQueue = nextSave.catch(() => undefined);
  await nextSave;
}

export { getSettingsPath };
