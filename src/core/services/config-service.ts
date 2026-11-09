import type { GatewaySettings, ProviderId } from "../types.js";
import { DEFAULT_IMAGE_MODEL, isSupportedImageModel } from "../models/image-models.js";
import { getPreferredCodexModel, hasCodexModel } from "../models/openai-codex-models.js";
import {
  createDefaultSettings,
  loadSettings,
  normalizeAccountMaxConcurrency,
  normalizeCountLimit,
  normalizeLlmApiChannelModels,
  normalizeMilliseconds,
  normalizeQuotaSyncConcurrency,
  saveSettings,
} from "../store/settings-store.js";
import { isLlmApiChannelModel, listLlmApiChannelModelIds, resolveLlmApiChannel } from "./llm-api-channel-service.js";

type NetworkProxyParams = {
  enabled: boolean;
  url?: string;
  noProxy?: string;
};

type BrandingParams = Partial<GatewaySettings["branding"]>;

function normalizeBranding(params: BrandingParams | undefined, settings: GatewaySettings["branding"]): GatewaySettings["branding"] {
  if (!params) {
    return settings;
  }

  const title = params.title?.trim() ?? settings.title;
  return {
    title: title || "AI Zero Token",
    appIconUrl: params.appIconUrl?.trim() ?? settings.appIconUrl,
    faviconUrl: params.faviconUrl?.trim() ?? settings.faviconUrl,
  };
}

function normalizeNetworkProxy(settings: GatewaySettings, params: NetworkProxyParams): GatewaySettings["networkProxy"] {
  const requestedUrl = params.url?.trim() ?? "";
  const url = requestedUrl || (!params.enabled ? settings.networkProxy.url : "");
  const noProxy = params.noProxy?.trim() || settings.networkProxy.noProxy || "localhost,127.0.0.1,::1";

  if (params.enabled) {
    if (!url) {
      throw new Error("启用代理时必须填写代理地址。");
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("代理地址格式错误，请填写完整的代理 URL。");
    }

    const supportedProtocols = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);
    if (!supportedProtocols.has(parsed.protocol)) {
      throw new Error("代理地址仅支持 http、https、socks4、socks4a、socks5 或 socks5h。");
    }
  }

  return {
    enabled: params.enabled,
    url,
    noProxy,
  };
}

function normalizeProfileIdList(value: string[] | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }

  return Array.from(
    new Set(
      value
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeImageLimitOverrides(
  value: GatewaySettings["image"]["limits"]["userOverrides"] | undefined,
  fallback: GatewaySettings["image"]["limits"]["userOverrides"],
): GatewaySettings["image"]["limits"]["userOverrides"] {
  if (!value) {
    return fallback;
  }

  const byUsername = new Map<string, GatewaySettings["image"]["limits"]["userOverrides"][number]>();
  for (const item of value) {
    const username = item.username.trim();
    if (!username) {
      continue;
    }
    byUsername.set(username, {
      username,
      ...(item.perUserDaily === undefined ? {} : { perUserDaily: normalizeCountLimit(item.perUserDaily, 0) }),
      ...(item.perUserHourly === undefined ? {} : { perUserHourly: normalizeCountLimit(item.perUserHourly, 0) }),
      ...(item.minIntervalSeconds === undefined ? {} : { minIntervalSeconds: normalizeCountLimit(item.minIntervalSeconds, 0, 86_400) }),
    });
  }

  return Array.from(byUsername.values()).sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
}

function normalizeImageLimits(
  params: Partial<GatewaySettings["image"]["limits"]> | undefined,
  settings: GatewaySettings["image"]["limits"],
): GatewaySettings["image"]["limits"] {
  if (!params) {
    return settings;
  }

  return {
    enabled: params.enabled ?? settings.enabled,
    perUserDaily: normalizeCountLimit(params.perUserDaily, settings.perUserDaily),
    perUserHourly: normalizeCountLimit(params.perUserHourly, settings.perUserHourly),
    minIntervalSeconds: normalizeCountLimit(params.minIntervalSeconds, settings.minIntervalSeconds, 86_400),
    userOverrides: normalizeImageLimitOverrides(params.userOverrides, settings.userOverrides),
  };
}

function normalizeImageApiChannelSave(
  params: Partial<GatewaySettings["image"]["apiChannel"]> | undefined,
  settings: GatewaySettings["image"]["apiChannel"],
): GatewaySettings["image"]["apiChannel"] {
  if (!params) {
    return settings;
  }

  const baseUrl = params.baseUrl === undefined ? settings.baseUrl : params.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = params.apiKey === undefined ? settings.apiKey : params.apiKey.trim();
  const enabled = params.enabled ?? settings.enabled;
  const mode = params.mode === "fallback" ? "fallback" : params.mode === "primary" ? "primary" : settings.mode;
  const model = params.model === undefined ? settings.model : params.model.trim() || settings.model;

  if (enabled && (!baseUrl || !apiKey)) {
    throw new Error("启用生图 API 渠道时必须填写 Base URL 和 API Key。");
  }

  return { enabled, mode, baseUrl, apiKey, model };
}

function normalizeLlmApiChannelSave(
  params: Partial<GatewaySettings["llm"]["apiChannel"]> | undefined,
  settings: GatewaySettings["llm"]["apiChannel"],
): GatewaySettings["llm"]["apiChannel"] {
  if (!params) {
    return settings;
  }

  const baseUrl = params.baseUrl === undefined ? settings.baseUrl : params.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = params.apiKey === undefined ? settings.apiKey : params.apiKey.trim();
  const enabled = params.enabled ?? settings.enabled;
  const mode = params.mode === "fallback" ? "fallback" : params.mode === "primary" ? "primary" : settings.mode;
  // 大模型渠道允许在未启用时把模型留空；启用时下面统一校验。
  const model = params.model === undefined ? settings.model : params.model.trim();
  // 同步到的模型目录：未传时保留原列表，不强制把 channel.model 塞进去。
  const models = params.models === undefined ? settings.models : normalizeLlmApiChannelModels(params.models);

  if (enabled && (!baseUrl || !apiKey || !model)) {
    throw new Error("启用大模型 API 渠道时必须填写 Base URL、API Key 和模型。");
  }

  return { enabled, mode, baseUrl, apiKey, model, models };
}

export class ConfigService {
  async getSettings(): Promise<GatewaySettings> {
    return this.ensureSettings();
  }

  async ensureSettings(): Promise<GatewaySettings> {
    return loadSettings();
  }

  async getDefaultProvider(): Promise<ProviderId> {
    const settings = await this.getSettings();
    return settings.defaultProvider;
  }

  async getDefaultModel(provider: ProviderId = "openai-codex"): Promise<string> {
    const settings = await this.getSettings();
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }
    const model = settings.modelRouting.chatModel || settings.defaultModel;
    // 聊天默认模型可以指向大模型 API 渠道里的外部模型。
    if (isLlmApiChannelModel(resolveLlmApiChannel(settings.llm?.apiChannel), model)) {
      return model;
    }
    return (await hasCodexModel(model)) ? model : getPreferredCodexModel();
  }

  async getImageOrchestratorModel(): Promise<string> {
    return (await this.getSettings()).modelRouting.imageOrchestratorModel;
  }

  async getImageGenerationModel(): Promise<string> {
    const model = (await this.getSettings()).modelRouting.imageGenerationModel;
    return isSupportedImageModel(model) ? model : DEFAULT_IMAGE_MODEL;
  }

  async setDefaultModel(model: string, provider: ProviderId = "openai-codex"): Promise<GatewaySettings> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }
    if (!(await hasCodexModel(model))) {
      throw new Error(`当前网关未找到可用模型: ${model}`);
    }

    const settings = await this.getSettings();
    const next = {
      ...settings,
      defaultProvider: provider,
      defaultModel: model,
      modelRouting: {
        ...settings.modelRouting,
        chatModel: model,
      },
    };
    await saveSettings(next);
    return next;
  }

  async setNetworkProxy(params: NetworkProxyParams): Promise<GatewaySettings> {
    const settings = await this.getSettings();
    const next = {
      ...settings,
      networkProxy: normalizeNetworkProxy(settings, params),
    };
    await saveSettings(next);
    return next;
  }

  async setAutoSwitch(params: { enabled?: boolean; excludedProfileIds?: string[] }): Promise<GatewaySettings> {
    const settings = await this.getSettings();
    const next = {
      ...settings,
      autoSwitch: {
        enabled: params.enabled ?? settings.autoSwitch.enabled,
        excludedProfileIds: normalizeProfileIdList(params.excludedProfileIds, settings.autoSwitch.excludedProfileIds),
      },
    };
    await saveSettings(next);
    return next;
  }

  async setRuntimeConfig(params: {
    quotaSyncConcurrency?: number;
    accountMaxConcurrency?: number;
    codexRequestSerializationEnabled?: boolean;
    codexRequestMinDelayMs?: number;
    codexRequestJitterMs?: number;
  }): Promise<GatewaySettings> {
    const settings = await this.getSettings();
    const next = {
      ...settings,
      runtime: {
        ...settings.runtime,
        quotaSyncConcurrency: normalizeQuotaSyncConcurrency(params.quotaSyncConcurrency, settings.runtime.quotaSyncConcurrency),
        accountMaxConcurrency: normalizeAccountMaxConcurrency(params.accountMaxConcurrency, settings.runtime.accountMaxConcurrency),
        codexRequestSerializationEnabled: params.codexRequestSerializationEnabled ?? settings.runtime.codexRequestSerializationEnabled,
        codexRequestMinDelayMs: normalizeMilliseconds(params.codexRequestMinDelayMs, settings.runtime.codexRequestMinDelayMs, 0, 60_000),
        codexRequestJitterMs: normalizeMilliseconds(params.codexRequestJitterMs, settings.runtime.codexRequestJitterMs, 0, 60_000),
      },
    };
    await saveSettings(next);
    return next;
  }

  async getServerConfig(): Promise<{ host: string; port: number }> {
    const settings = await this.getSettings();
    return settings.server;
  }

  async setServerConfig(params: { host?: string; port?: number }): Promise<GatewaySettings> {
    const settings = await this.getSettings();
    const next = {
      ...settings,
      server: {
        host: params.host ?? settings.server.host,
        port: params.port ?? settings.server.port,
      },
    };
    await saveSettings(next);
    return next;
  }

  async updateSettings(params: {
    defaultModel?: string;
    modelRouting?: Partial<GatewaySettings["modelRouting"]>;
    branding?: BrandingParams;
    security?: { apiKeyHash?: string };
    networkProxy?: NetworkProxyParams;
    autoSwitch?: { enabled?: boolean; excludedProfileIds?: string[] };
    accountRotation?: { enabled?: boolean; strategy?: "round_robin" };
    runtime?: {
      quotaSyncConcurrency?: number;
      accountMaxConcurrency?: number;
      codexRequestSerializationEnabled?: boolean;
      codexRequestMinDelayMs?: number;
      codexRequestJitterMs?: number;
    };
    image?: {
      freeAccountWebGenerationEnabled?: boolean;
      generationTimeoutMs?: number;
      promptOptimizerSystemPrompt?: string;
      limits?: Partial<GatewaySettings["image"]["limits"]>;
      apiChannel?: Partial<GatewaySettings["image"]["apiChannel"]>;
    };
    llm?: {
      apiChannel?: Partial<GatewaySettings["llm"]["apiChannel"]>;
    };
    wecom?: { enabled?: boolean; corpId?: string; agentId?: string; secret?: string; notifyImageResult?: boolean };
    server?: { port: number };
  }): Promise<GatewaySettings> {
    const settings = await this.getSettings();
    let next: GatewaySettings = { ...settings };

    // 先应用大模型 API 渠道配置（含同步到的模型目录），同一次 PUT 里新增的渠道模型
    // 才能通过后面的默认模型 / 模型路由校验。
    if (params.llm) {
      next = {
        ...next,
        llm: {
          apiChannel: normalizeLlmApiChannelSave(params.llm.apiChannel, next.llm.apiChannel),
        },
      };
    }

    if (params.defaultModel) {
      const model = params.defaultModel.trim();
      if (!(await hasCodexModel(model)) && !isLlmApiChannelModel(next.llm.apiChannel, model)) {
        throw new Error(`当前网关未找到可用模型: ${params.defaultModel}`);
      }
      next = {
        ...next,
        defaultProvider: "openai-codex",
        defaultModel: model,
        modelRouting: {
          ...next.modelRouting,
          chatModel: model,
        },
      };
    }

    if (params.modelRouting) {
      const routing = { ...params.modelRouting };
      const channelModelIds = new Set(listLlmApiChannelModelIds(next.llm.apiChannel));
      const textModels: Array<[Exclude<keyof GatewaySettings["modelRouting"], "imageGenerationModel">, string]> = [
        ["chatModel", "聊天模型"],
        ["imageClassifierModel", "生图检查模型"],
        ["imageOrchestratorModel", "生图编排模型"],
        ["promptOptimizerModel", "提示词优化模型"],
      ];
      for (const [key, label] of textModels) {
        const model = routing[key];
        if (model === undefined) {
          continue;
        }
        const normalizedModel = model.trim();
        if (isSupportedImageModel(normalizedModel)) {
          throw Object.assign(new Error(`${label}未找到可用文本模型: ${model}，请同步模型目录后重新选择。`), { statusCode: 400 });
        }
        // Codex 目录优先；命中渠道模型目录时也允许，外部文本 API 可以直接调用。
        const codexModel = await hasCodexModel(normalizedModel);
        const channelModel = channelModelIds.has(normalizedModel);
        // 生图编排需要 Codex 的 image_generation 工具，外部文本 API 无法执行。
        if (key === "imageOrchestratorModel" && channelModel && !codexModel) {
          throw Object.assign(new Error("生图编排模型需要 Codex 的 image_generation 工具，不能使用大模型 API 渠道模型。"), {
            statusCode: 400,
          });
        }
        if (!codexModel && !channelModel) {
          throw Object.assign(new Error(`${label}未找到可用文本模型: ${model}，请同步模型目录后重新选择。`), { statusCode: 400 });
        }
        routing[key] = normalizedModel;
      }

      if (routing.imageGenerationModel !== undefined) {
        const normalizedModel = routing.imageGenerationModel.trim();
        if (!isSupportedImageModel(normalizedModel)) {
          throw Object.assign(new Error(`生图服务模型不受支持: ${routing.imageGenerationModel}`), { statusCode: 400 });
        }
        routing.imageGenerationModel = normalizedModel;
      }

      next = {
        ...next,
        defaultModel: routing.chatModel ?? next.defaultModel,
        modelRouting: {
          ...next.modelRouting,
          ...routing,
        },
      };
    }

    if (params.networkProxy) {
      next = {
        ...next,
        networkProxy: normalizeNetworkProxy(next, params.networkProxy),
      };
    }

    if (params.branding) {
      next = {
        ...next,
        branding: normalizeBranding(params.branding, next.branding),
      };
    }

    if (params.security) {
      next = {
        ...next,
        security: {
          apiKeyHash: params.security.apiKeyHash?.trim() ?? next.security.apiKeyHash,
        },
      };
    }

    if (params.autoSwitch) {
      next = {
        ...next,
        autoSwitch: {
          enabled: params.autoSwitch.enabled ?? next.autoSwitch.enabled,
          excludedProfileIds: normalizeProfileIdList(params.autoSwitch.excludedProfileIds, next.autoSwitch.excludedProfileIds),
        },
      };
    }

    if (params.accountRotation) {
      next = {
        ...next,
        accountRotation: {
          enabled: params.accountRotation.enabled ?? next.accountRotation.enabled,
          strategy: "round_robin",
        },
      };
    }

    if (params.runtime) {
      next = {
        ...next,
        runtime: {
          ...next.runtime,
          quotaSyncConcurrency: normalizeQuotaSyncConcurrency(params.runtime.quotaSyncConcurrency, next.runtime.quotaSyncConcurrency),
          accountMaxConcurrency: normalizeAccountMaxConcurrency(params.runtime.accountMaxConcurrency, next.runtime.accountMaxConcurrency),
          codexRequestSerializationEnabled: params.runtime.codexRequestSerializationEnabled ?? next.runtime.codexRequestSerializationEnabled,
          codexRequestMinDelayMs: normalizeMilliseconds(params.runtime.codexRequestMinDelayMs, next.runtime.codexRequestMinDelayMs, 0, 60_000),
          codexRequestJitterMs: normalizeMilliseconds(params.runtime.codexRequestJitterMs, next.runtime.codexRequestJitterMs, 0, 60_000),
        },
      };
    }

    if (params.image) {
      next = {
        ...next,
        image: {
          ...next.image,
          freeAccountWebGenerationEnabled: params.image.freeAccountWebGenerationEnabled ?? next.image.freeAccountWebGenerationEnabled,
          generationTimeoutMs: normalizeMilliseconds(params.image.generationTimeoutMs, next.image.generationTimeoutMs, 60_000, 30 * 60 * 1000),
          promptOptimizerSystemPrompt: params.image.promptOptimizerSystemPrompt?.trim().slice(0, 8000) || next.image.promptOptimizerSystemPrompt,
          limits: normalizeImageLimits(params.image.limits, next.image.limits),
          apiChannel: normalizeImageApiChannelSave(params.image.apiChannel, next.image.apiChannel),
        },
      };
    }

    if (params.wecom) {
      const enabled = params.wecom.enabled ?? next.wecom.enabled;
      const corpId = params.wecom.corpId?.trim() ?? next.wecom.corpId;
      const agentId = params.wecom.agentId?.trim() ?? next.wecom.agentId;
      const secret = params.wecom.secret?.trim() ?? next.wecom.secret;
      const notifyImageResult = params.wecom.notifyImageResult ?? next.wecom.notifyImageResult;
      if (enabled && (!corpId || !agentId || !secret)) {
        throw new Error("启用企业微信扫码登录时必须填写企业 ID、AgentID 和 Secret。");
      }
      next = {
        ...next,
        wecom: {
          enabled,
          corpId,
          agentId,
          secret,
          notifyImageResult,
        },
      };
    }

    if (params.server) {
      next = {
        ...next,
        server: {
          ...next.server,
          port: params.server.port,
        },
      };
    }

    await saveSettings(next);
    return next;
  }

  async resetSettings(): Promise<GatewaySettings> {
    const defaults = createDefaultSettings();
    await saveSettings(defaults);
    return defaults;
  }
}
