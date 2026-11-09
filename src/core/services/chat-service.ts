import type { ChatRequest, ChatResult, ProviderId } from "../types.js";
import { askOpenAICodex, createCodexInBandFailureError } from "../providers/openai-codex/chat.js";
import { AuthService } from "./auth-service.js";
import { ConfigService } from "./config-service.js";
import {
  isLlmApiChannelModel,
  requestLlmChatCompletion,
  resolveLlmApiChannel,
  type LlmApiChannelConfig,
  type LlmChatMessage,
} from "./llm-api-channel-service.js";
import { ModelService } from "./model-service.js";
import { RequestThrottleService } from "./request-throttle-service.js";

type ChatServiceDeps = {
  authService: AuthService;
  modelService: ModelService;
  requestThrottleService: RequestThrottleService;
  configService: ConfigService;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async chat(request: ChatRequest): Promise<ChatResult> {
    const provider: ProviderId = request.provider ?? "openai-codex";
    const settings = await this.deps.configService.getSettings();
    const channel = resolveLlmApiChannel(settings.llm?.apiChannel);

    // 请求的模型属于外部渠道目录时，直接走渠道（Codex 无法提供该模型）。
    const requestedModel = request.model?.trim() || "";
    if (channel && requestedModel && isLlmApiChannelModel(channel, requestedModel)) {
      return this.chatViaLlmApiChannel(channel, request, requestedModel);
    }

    // 渠道优先：直接走外部大模型 API，不消耗 Codex 账号额度；渠道失败且尚未
    // 产生任何结果时，回退 Codex 账号（与「生图 API 渠道」的 primary 行为一致）。
    if (channel?.mode === "primary") {
      try {
        return await this.chatViaLlmApiChannel(channel, request);
      } catch (channelError) {
        try {
          return await this.chatViaCodex(provider, request);
        } catch (codexError) {
          throw new Error(
            `大模型 API 渠道调用失败：${errorText(channelError)}；Codex 账号回退失败：${errorText(codexError)}`,
          );
        }
      }
    }

    try {
      return await this.chatViaCodex(provider, request);
    } catch (error) {
      if (channel?.mode === "fallback") {
        try {
          return await this.chatViaLlmApiChannel(channel, request);
        } catch (channelFallbackError) {
          console.warn("[gateway:chat] 大模型 API 渠道回退失败", {
            baseUrl: channel.baseUrl,
            message: errorText(channelFallbackError),
          });
        }
      }
      // 渠道兜底也失败时，把原始的 Codex 错误抛给调用方。
      throw error;
    }
  }

  private async chatViaCodex(provider: ProviderId, request: ChatRequest): Promise<ChatResult> {
    const model = await this.deps.modelService.resolveModel(provider, request.model, {
      allowUnknown: request.experimental?.allowUnknownModel,
    });
    const rotation = await this.deps.authService.withProfileRotation(provider, (profile) =>
      this.deps.requestThrottleService.runForProfile(
        profile,
        () =>
          askOpenAICodex({
            profile,
            prompt: request.input,
            model,
            system: request.system,
            bodyOverride: request.experimental?.codexBody,
          }),
        {
          route: "chat",
          model,
        },
      ),
    );
    const result = rotation.result;
    if (result.failure) {
      throw createCodexInBandFailureError(result.failure);
    }

    return {
      provider,
      model,
      profile: rotation.profile,
      retryCount: rotation.retryCount,
      text: result.text,
      toolCalls: result.toolCalls,
      raw: result.raw,
      artifacts: result.artifacts,
    };
  }

  private async chatViaLlmApiChannel(
    channel: LlmApiChannelConfig,
    request: ChatRequest,
    modelOverride?: string,
  ): Promise<ChatResult> {
    const model = modelOverride?.trim() || channel.model;
    const messages: LlmChatMessage[] = [];
    if (request.system?.trim()) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: request.input ?? "" });

    console.info("[gateway:chat] using 大模型 API 渠道", {
      baseUrl: channel.baseUrl,
      mode: channel.mode,
      model,
    });

    const result = await requestLlmChatCompletion({ channel, messages, model });
    return {
      provider: "openai-codex",
      model: result.model,
      text: result.text,
      toolCalls: [],
      artifacts: [],
      raw: {
        _gatewayLlmRoute: "llm-api-channel",
        usage: result.usage,
        upstream: result.raw,
        latencyMs: result.latencyMs,
      },
    };
  }
}
