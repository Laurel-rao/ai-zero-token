import {
  getCodexModelCatalog,
  hasCodexModel,
  refreshCodexModelCatalogFromNetwork,
} from "../models/openai-codex-models.js";
import type { ModelCatalogInfo, ModelInfo, ProviderId } from "../types.js";
import type { AuthService } from "./auth-service.js";
import { ConfigService } from "./config-service.js";

const CODEX_MODEL_AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const CODEX_MODEL_AUTO_REFRESH_INITIAL_DELAY_MS = 20 * 1000;

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

export class ModelService {
  private autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRefreshStarted = false;
  private autoRefreshStatus: ModelAutoRefreshStatus = {
    enabled: false,
    intervalMs: CODEX_MODEL_AUTO_REFRESH_INTERVAL_MS,
    running: false,
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async listModels(provider: ProviderId = "openai-codex"): Promise<ModelInfo[]> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }

    const [{ models }, defaultModel] = await Promise.all([
      getCodexModelCatalog(),
      this.configService.getDefaultModel(provider),
    ]);
    return models.map((model) => ({
      ...model,
      isDefault: model.id === defaultModel,
    }));
  }

  async getCatalog(provider: ProviderId = "openai-codex"): Promise<ModelCatalogInfo> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }

    return (await getCodexModelCatalog()).catalog;
  }

  async refreshModels(provider: ProviderId = "openai-codex"): Promise<{
    models: ModelInfo[];
    catalog: ModelCatalogInfo;
  }> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }

    const profile = await this.authService.requireUsableProfile(provider, {
      skipAutoSwitch: true,
    });

    let result: { models: ModelInfo[]; catalog: ModelCatalogInfo };
    try {
      result = await refreshCodexModelCatalogFromNetwork(profile);
      await this.authService.recordProfileRequestSuccess(profile.profileId, undefined, provider, {
        skipAutoSwitch: true,
      });
    } catch (error) {
      await this.authService.recordProfileRequestFailure(profile.profileId, error, undefined, provider, {
        skipAutoSwitch: true,
      });
      throw error;
    }

    const defaultModel = await this.configService.getDefaultModel(provider);

    return {
      models: result.models.map((model) => ({
        ...model,
        isDefault: model.id === defaultModel,
      })),
      catalog: result.catalog,
    };
  }

  getAutoRefreshStatus(): ModelAutoRefreshStatus {
    return { ...this.autoRefreshStatus };
  }

  startAutoRefresh(options?: { initialDelayMs?: number; intervalMs?: number }): void {
    if (this.autoRefreshStarted) {
      return;
    }

    const intervalMs = options?.intervalMs ?? CODEX_MODEL_AUTO_REFRESH_INTERVAL_MS;
    this.autoRefreshStarted = true;
    this.autoRefreshStatus = {
      ...this.autoRefreshStatus,
      enabled: true,
      intervalMs,
    };
    this.scheduleAutoRefresh(options?.initialDelayMs ?? CODEX_MODEL_AUTO_REFRESH_INITIAL_DELAY_MS);
  }

  stopAutoRefresh(): void {
    this.autoRefreshStarted = false;
    this.autoRefreshStatus = {
      ...this.autoRefreshStatus,
      enabled: false,
      nextRunAt: undefined,
    };
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  private scheduleAutoRefresh(delayMs: number): void {
    if (!this.autoRefreshStarted) {
      return;
    }

    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
    }

    const normalizedDelayMs = Math.max(0, delayMs);
    this.autoRefreshStatus = {
      ...this.autoRefreshStatus,
      nextRunAt: Date.now() + normalizedDelayMs,
    };
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = null;
      this.runAutoRefresh().catch((error) => {
        console.warn("[gateway:models] auto refresh failed", error);
      });
    }, normalizedDelayMs);
    this.autoRefreshTimer.unref?.();
  }

  private async runAutoRefresh(): Promise<void> {
    if (!this.autoRefreshStarted) {
      return;
    }

    if (this.autoRefreshStatus.running) {
      this.scheduleAutoRefresh(this.autoRefreshStatus.intervalMs);
      return;
    }

    const startedAt = Date.now();
    this.autoRefreshStatus = {
      ...this.autoRefreshStatus,
      running: true,
      lastStartedAt: startedAt,
      nextRunAt: undefined,
    };

    try {
      const result = await this.refreshModels();
      this.autoRefreshStatus = {
        ...this.autoRefreshStatus,
        running: false,
        lastFinishedAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastModelCount: result.catalog.modelCount,
        lastSource: result.catalog.source,
        lastError: undefined,
      };
    } catch (error) {
      this.autoRefreshStatus = {
        ...this.autoRefreshStatus,
        running: false,
        lastFinishedAt: Date.now(),
        lastFailureAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.scheduleAutoRefresh(this.autoRefreshStatus.intervalMs);
    }
  }

  async getDefaultModel(provider: ProviderId = "openai-codex"): Promise<string> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }

    return this.configService.getDefaultModel(provider);
  }

  async resolveModel(
    provider: ProviderId = "openai-codex",
    requested?: string,
    options?: { allowUnknown?: boolean },
  ): Promise<string> {
    if (provider !== "openai-codex") {
      throw new Error(`暂不支持 provider: ${provider}`);
    }

    if (!requested) {
      return this.configService.getDefaultModel(provider);
    }

    if (options?.allowUnknown) {
      return requested;
    }

    if (!(await hasCodexModel(requested))) {
      throw new Error(`当前网关未找到可用模型: ${requested}`);
    }

    return requested;
  }
}
