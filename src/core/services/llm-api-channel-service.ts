import type { GatewaySettings } from "../types.js";

export type LlmApiChannelConfig = GatewaySettings["llm"]["apiChannel"];

export type LlmChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmChatMessage = {
  role: "system" | "user" | "assistant";
  /** 纯文本或 OpenAI 兼容的多模态 content parts（文本 + image_url data URL）。 */
  content: string | LlmChatContentPart[];
};

export type LlmChatCompletionRequest = {
  channel: LlmApiChannelConfig;
  messages: LlmChatMessage[];
  /** 覆盖 channel.model。 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 默认 120000。 */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type LlmChatCompletionResult = {
  text: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  raw: unknown;
  latencyMs: number;
  upstreamStatus: number;
};

type LlmChatUsage = NonNullable<LlmChatCompletionResult["usage"]>;

type UpstreamContentPart = { text?: unknown };
type UpstreamChoice = {
  message?: { content?: unknown };
  delta?: { content?: unknown };
};
type UpstreamUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
};
type UpstreamPayload = {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
  message?: unknown;
};

type UpstreamModelsPayload = {
  data?: unknown;
  error?: unknown;
  message?: unknown;
};

const DEFAULT_TIMEOUT_MS = 120_000;

/** 大模型 API 渠道是否可用（开关打开且 base URL / key / model 都填了）。 */
export function resolveLlmApiChannel(channel: LlmApiChannelConfig | undefined): LlmApiChannelConfig | undefined {
  if (!channel?.enabled) {
    return undefined;
  }
  if (!channel.baseUrl?.trim() || !channel.apiKey?.trim() || !channel.model?.trim()) {
    return undefined;
  }
  return channel;
}

/**
 * 归一化渠道 Base URL：去掉首尾空白和结尾斜杠、去掉误填的 /chat/completions，
 * 没有以 /v1 结尾时自动补上（调用方再拼 /chat/completions）。
 */
export function normalizeLlmApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * 渠道可用模型全集：单独填写的 channel.model + 同步到的 channel.models，
 * trim、去空、去重并保持顺序（channel.model 排在最前）。
 */
export function listLlmApiChannelModelIds(channel: LlmApiChannelConfig | undefined): string[] {
  if (!channel) {
    return [];
  }

  const candidates = [channel.model, ...(Array.isArray(channel.models) ? channel.models : [])];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const model = typeof candidate === "string" ? candidate.trim() : "";
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }
  return models;
}

/** 指定模型是否属于渠道目录（含单独填写的 channel.model）。 */
export function isLlmApiChannelModel(channel: LlmApiChannelConfig | undefined, model: string | undefined): boolean {
  const requested = model?.trim();
  if (!requested) {
    return false;
  }
  return listLlmApiChannelModelIds(channel).includes(requested);
}

/**
 * 从上游 OpenAI 兼容 `GET /models` 拉取可用模型 id。
 * 只负责发请求 + 归一化响应；失败时抛出中文错误，由调用方决定是否提示。
 */
export async function listLlmApiChannelModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const rawBaseUrl = params.baseUrl?.trim() ?? "";
  if (!rawBaseUrl) {
    throw new Error("大模型 API 渠道未配置 Base URL。");
  }
  const apiKey = params.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error("大模型 API 渠道未配置 API Key。");
  }
  const baseUrl = normalizeLlmApiBaseUrl(rawBaseUrl);
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let response: Response;
  let payloadText: string;
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    payloadText = await response.text();
  } catch (error) {
    throw new Error(`大模型 API 渠道模型列表请求失败（${Date.now() - startedAt}ms）：${errorMessage(error)}`);
  }

  if (!response.ok) {
    let parsed: UpstreamModelsPayload = {};
    try {
      parsed = JSON.parse(payloadText) as UpstreamModelsPayload;
    } catch {
      // 上游返回的可能是 HTML 错误页，直接用原文
    }
    throw new Error(`大模型 API 渠道模型列表请求失败（HTTP ${response.status}）：${extractUpstreamError(parsed, payloadText)}`);
  }

  let payload: UpstreamModelsPayload;
  try {
    payload = JSON.parse(payloadText) as UpstreamModelsPayload;
  } catch {
    throw new Error("大模型 API 渠道返回的不是有效 JSON。");
  }

  const items = Array.isArray(payload.data) ? payload.data : [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id =
      item && typeof item === "object" && !Array.isArray(item)
        ? trimToText((item as { id?: unknown }).id).slice(0, 200)
        : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(id);
    if (models.length >= 200) {
      break;
    }
  }

  if (models.length === 0) {
    throw new Error("大模型 API 渠道没有返回模型列表。");
  }
  return models;
}

function trimToText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const part of content as Array<UpstreamContentPart | string>) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }
    // content parts 的文本要原样拼接，不能 trim，否则跨分片的首尾空格会丢。
    if (typeof part?.text === "string" && part.text) {
      textParts.push(part.text);
    }
  }
  return textParts.join("");
}

function extractUpstreamError(payload: UpstreamPayload, fallbackText: string): string {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  return fallbackText.trim().slice(0, 300) || "上游没有返回错误信息";
}

function mapUsage(value: unknown): LlmChatUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as UpstreamUsage;
  const usage: LlmChatUsage = {};
  if (typeof record.prompt_tokens === "number" && Number.isFinite(record.prompt_tokens)) {
    usage.prompt_tokens = record.prompt_tokens;
  }
  if (typeof record.completion_tokens === "number" && Number.isFinite(record.completion_tokens)) {
    usage.completion_tokens = record.completion_tokens;
  }
  if (typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)) {
    usage.total_tokens = record.total_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRequestBody(
  request: LlmChatCompletionRequest,
  stream: boolean,
): { baseUrl: string; apiKey: string; model: string; body: Record<string, unknown> } {
  const rawBaseUrl = request.channel.baseUrl?.trim() ?? "";
  if (!rawBaseUrl) {
    throw new Error("大模型 API 渠道未配置 Base URL。");
  }
  const apiKey = request.channel.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error("大模型 API 渠道未配置 API Key。");
  }
  const model = trimToText(request.model) || trimToText(request.channel.model);
  if (!model) {
    throw new Error("大模型 API 渠道未配置模型。");
  }

  const body: Record<string, unknown> = {
    model,
    messages: request.messages,
    stream,
  };
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) {
    body.temperature = request.temperature;
  }
  if (typeof request.maxTokens === "number" && Number.isFinite(request.maxTokens)) {
    body.max_tokens = Math.trunc(request.maxTokens);
  }

  return { baseUrl: normalizeLlmApiBaseUrl(rawBaseUrl), apiKey, model, body };
}

function createRequestSignal(request: LlmChatCompletionRequest): AbortSignal {
  const timeoutMs =
    typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? request.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
}

/**
 * 调用外部 OpenAI 兼容大模型 API（非流式）。
 * 只负责发请求 + 归一化响应；失败时抛出的错误由调用方决定是否回退。
 */
export async function requestLlmChatCompletion(request: LlmChatCompletionRequest): Promise<LlmChatCompletionResult> {
  const startedAt = Date.now();
  const { baseUrl, apiKey, model, body } = buildRequestBody(request, false);
  const signal = createRequestSignal(request);

  let response: Response;
  let payloadText: string;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    payloadText = await response.text();
  } catch (error) {
    throw new Error(`大模型 API 渠道请求失败（${Date.now() - startedAt}ms）：${errorMessage(error)}`);
  }
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    let parsed: UpstreamPayload = {};
    try {
      parsed = JSON.parse(payloadText) as UpstreamPayload;
    } catch {
      // 上游返回的可能是 HTML 错误页，直接用原文
    }
    throw new Error(`大模型 API 渠道请求失败（HTTP ${response.status}）：${extractUpstreamError(parsed, payloadText)}`);
  }

  let payload: UpstreamPayload;
  try {
    payload = JSON.parse(payloadText) as UpstreamPayload;
  } catch {
    throw new Error("大模型 API 渠道返回的不是有效 JSON。");
  }

  const choices = Array.isArray(payload.choices) ? (payload.choices as UpstreamChoice[]) : [];
  const text = extractContentText(choices[0]?.message?.content);
  if (!text) {
    throw new Error("大模型 API 渠道没有返回文本内容。");
  }

  const usage = mapUsage(payload.usage);
  return {
    text,
    model: trimToText(payload.model) || model,
    ...(usage ? { usage } : {}),
    raw: payload,
    latencyMs,
    upstreamStatus: response.status,
  };
}

/**
 * 调用外部 OpenAI 兼容大模型 API（流式 SSE）。
 * 按行解析 `data: `，`[DONE]` 结束；有内容才 yield delta，收到 usage 时 yield usage，最后 yield done。
 */
export async function* streamLlmChatCompletion(
  request: LlmChatCompletionRequest,
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "usage"; usage: LlmChatUsage }
  | { type: "done"; model: string; upstreamStatus: number }
> {
  const startedAt = Date.now();
  const { baseUrl, apiKey, model, body } = buildRequestBody(request, true);
  const signal = createRequestSignal(request);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new Error(`大模型 API 渠道请求失败（${Date.now() - startedAt}ms）：${errorMessage(error)}`);
  }
  const upstreamStatus = response.status;

  if (!response.ok) {
    let payloadText = "";
    try {
      payloadText = await response.text();
    } catch {
      // 读取错误响应体失败时只能退回状态码
    }
    let parsed: UpstreamPayload = {};
    try {
      parsed = JSON.parse(payloadText) as UpstreamPayload;
    } catch {
      // 上游返回的可能是 HTML 错误页，直接用原文
    }
    throw new Error(`大模型 API 渠道请求失败（HTTP ${response.status}）：${extractUpstreamError(parsed, payloadText)}`);
  }

  let streamModel = model;
  let finished = false;
  const events: Array<
    | { type: "delta"; text: string }
    | { type: "usage"; usage: LlmChatUsage }
  > = [];

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) {
      return;
    }
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data) {
      return;
    }
    if (data === "[DONE]") {
      finished = true;
      return;
    }

    let payload: UpstreamPayload;
    try {
      payload = JSON.parse(data) as UpstreamPayload;
    } catch {
      // 单个 SSE 数据块解析失败不影响后续流
      return;
    }

    const responseModel = trimToText(payload.model);
    if (responseModel) {
      streamModel = responseModel;
    }
    const choices = Array.isArray(payload.choices) ? (payload.choices as UpstreamChoice[]) : [];
    const deltaText = extractContentText(choices[0]?.delta?.content);
    if (deltaText) {
      events.push({ type: "delta", text: deltaText });
    }
    const usage = mapUsage(payload.usage);
    if (usage) {
      events.push({ type: "usage", usage });
    }
  };

  const flushEvents = function* (): Generator<
    | { type: "delta"; text: string }
    | { type: "usage"; usage: LlmChatUsage }
  > {
    while (events.length > 0) {
      const event = events.shift();
      if (event) {
        yield event;
      }
    }
  };

  const stream = response.body;
  if (!stream) {
    yield { type: "done", model: streamModel, upstreamStatus };
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error(`大模型 API 渠道请求失败（${Date.now() - startedAt}ms）：${errorMessage(error)}`);
      }
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
        if (finished) {
          break;
        }
      }
      yield* flushEvents();
    }
    if (!finished && buffer.trim()) {
      consumeLine(buffer);
      buffer = "";
      yield* flushEvents();
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 取消读取失败对调用方没有意义，忽略。
    }
  }

  yield { type: "done", model: streamModel, upstreamStatus };
}
