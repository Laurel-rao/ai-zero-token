import { DEFAULT_IMAGE_MODEL } from "../models/image-models.js";
import type { GatewaySettings } from "../types.js";

export type ImageApiChannelConfig = GatewaySettings["image"]["apiChannel"];

export type ImageApiChannelRequest = {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  inputImages?: Array<{ imageUrl: string }>;
};

export type ImageApiChannelResult = {
  created: number;
  data: Array<{
    b64_json: string;
    revised_prompt?: string;
  }>;
  background?: "transparent" | "opaque";
  output_format?: "png" | "webp" | "jpeg";
  quality?: "low" | "medium" | "high" | "xhigh" | "max";
  size?: string;
  _gatewayImageRoute: "api-channel";
};

type UpstreamImageItem = {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
};

type UpstreamImagePayload = {
  created?: unknown;
  data?: unknown;
  size?: unknown;
  quality?: unknown;
  output_format?: unknown;
  background?: unknown;
  error?: unknown;
  message?: unknown;
};

const CHANNEL_ROUTE = "api-channel" as const;

/** 生图 API 渠道是否可用（开关打开且 base URL / key 都填了）。 */
export function resolveImageApiChannel(settings: GatewaySettings): ImageApiChannelConfig | undefined {
  const channel = settings.image?.apiChannel;
  if (!channel?.enabled) {
    return undefined;
  }
  if (!channel.baseUrl?.trim() || !channel.apiKey?.trim()) {
    return undefined;
  }
  return channel;
}

export function resolveImageApiChannelModel(channel: ImageApiChannelConfig, requestedModel?: string): string {
  const configured = channel.model?.trim();
  if (configured) {
    return configured;
  }
  const requested = requestedModel?.trim();
  return requested || DEFAULT_IMAGE_MODEL;
}

function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function extractUpstreamError(payload: UpstreamImagePayload, fallbackText: string): string {
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

function parseDataUrl(value: string): { mimeType: string; base64: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] || "image/png";
  const data = match[3] ?? "";
  return match[2] ? { mimeType, base64: data } : { mimeType, base64: Buffer.from(decodeURIComponent(data), "utf8").toString("base64") };
}

async function imageUrlToBlob(imageUrl: string, timeoutMs: number): Promise<{ blob: Blob; extension: string }> {
  const dataUrl = parseDataUrl(imageUrl);
  if (dataUrl) {
    return {
      blob: new Blob([Buffer.from(dataUrl.base64, "base64")], { type: dataUrl.mimeType }),
      extension: mimeToExtension(dataUrl.mimeType),
    };
  }
  let response: Response;
  try {
    response = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`参考图下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`参考图下载失败：HTTP ${response.status}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { blob: new Blob([buffer], { type: mimeType }), extension: mimeToExtension(mimeType) };
}

function mimeToExtension(mimeType: string): string {
  if (mimeType.includes("webp")) {
    return ".webp";
  }
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return ".jpg";
  }
  return ".png";
}

async function fetchImageAsBase64(url: string, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`生成结果图片下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`生成结果图片下载失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

function normalizeImageItem(item: UpstreamImageItem, resultBase64: string | undefined): { b64_json: string; revised_prompt?: string } {
  const b64 = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
  let normalizedBase64 = b64;
  if (normalizedBase64) {
    const dataUrl = parseDataUrl(normalizedBase64);
    if (dataUrl) {
      normalizedBase64 = dataUrl.base64;
    }
  } else if (resultBase64) {
    normalizedBase64 = resultBase64;
  }
  if (!normalizedBase64) {
    throw new Error("生图 API 渠道返回的数据里没有图片。");
  }
  const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
  return revisedPrompt ? { b64_json: normalizedBase64, revised_prompt: revisedPrompt } : { b64_json: normalizedBase64 };
}

function normalizeOutputFormat(value: unknown): "png" | "webp" | "jpeg" | undefined {
  return value === "png" || value === "webp" || value === "jpeg" ? value : undefined;
}

function normalizeQuality(value: unknown): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}

function normalizeBackground(value: unknown): "transparent" | "opaque" | undefined {
  return value === "transparent" || value === "opaque" ? value : undefined;
}

/**
 * 把生图请求转发到外部 OpenAI 兼容生图 API（自建渠道）。
 * 只负责发请求 + 归一化响应；失败时抛出的错误由调用方决定是否回退。
 */
export async function requestImageApiChannel(params: {
  channel: ImageApiChannelConfig;
  request: ImageApiChannelRequest;
  timeoutMs: number;
}): Promise<ImageApiChannelResult> {
  const { channel, request } = params;
  const baseUrl = normalizeApiBaseUrl(channel.baseUrl);
  const apiKey = channel.apiKey.trim();
  const model = resolveImageApiChannelModel(channel, request.model);
  const timeoutMs = Math.max(30_000, params.timeoutMs);
  const isEdit = Boolean(request.inputImages && request.inputImages.length > 0);

  const startedAt = Date.now();
  let response: Response;
  let payloadText: string;

  try {
    if (isEdit) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", request.prompt);
      form.set("n", "1");
      form.set("response_format", "b64_json");
      if (request.size) form.set("size", request.size);
      if (request.quality) form.set("quality", request.quality);
      if (request.background) form.set("background", request.background);
      if (request.outputFormat) form.set("output_format", request.outputFormat);
      if (typeof request.outputCompression === "number") form.set("output_compression", String(request.outputCompression));
      if (request.moderation) form.set("moderation", request.moderation);

      for (const [index, reference] of (request.inputImages ?? []).entries()) {
        const { blob, extension } = await imageUrlToBlob(reference.imageUrl, timeoutMs);
        form.append("image", blob, `image-${index}${extension}`);
      }

      response = await fetch(`${baseUrl}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else {
      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        n: 1,
        response_format: "b64_json",
      };
      if (request.size) body.size = request.size;
      if (request.quality) body.quality = request.quality;
      if (request.background) body.background = request.background;
      if (request.outputFormat) body.output_format = request.outputFormat;
      if (typeof request.outputCompression === "number") body.output_compression = request.outputCompression;
      if (request.moderation) body.moderation = request.moderation;

      response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    payloadText = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`生图 API 渠道请求失败（${Date.now() - startedAt}ms）：${message}`);
  }

  if (!response.ok) {
    let parsed: UpstreamImagePayload = {};
    try {
      parsed = JSON.parse(payloadText) as UpstreamImagePayload;
    } catch {
      // 上游返回的可能是 HTML 错误页，直接用原文
    }
    throw new Error(`生图 API 渠道返回 HTTP ${response.status}：${extractUpstreamError(parsed, payloadText)}`);
  }

  let payload: UpstreamImagePayload;
  try {
    payload = JSON.parse(payloadText) as UpstreamImagePayload;
  } catch {
    throw new Error("生图 API 渠道返回的不是有效 JSON。");
  }

  const items = Array.isArray(payload.data) ? (payload.data as UpstreamImageItem[]) : [];
  if (items.length === 0) {
    throw new Error(`生图 API 渠道没有返回图片：${extractUpstreamError(payload, payloadText)}`);
  }

  const data: Array<{ b64_json: string; revised_prompt?: string }> = [];
  for (const item of items) {
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const downloaded = !item.b64_json && url ? await fetchImageAsBase64(url, timeoutMs) : undefined;
    data.push(normalizeImageItem(item, downloaded));
  }

  const created = typeof payload.created === "number" && Number.isFinite(payload.created) ? payload.created : Math.floor(Date.now() / 1000);
  const outputFormat = normalizeOutputFormat(payload.output_format) ?? (request.outputFormat === "webp" || request.outputFormat === "jpeg" ? request.outputFormat : undefined);
  const quality = normalizeQuality(payload.quality) ?? normalizeQuality(request.quality);
  const background = normalizeBackground(payload.background) ?? normalizeBackground(request.background);
  const size = typeof payload.size === "string" ? payload.size : request.size;

  return {
    created,
    data,
    ...(outputFormat ? { output_format: outputFormat } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background } : {}),
    ...(size ? { size } : {}),
    _gatewayImageRoute: CHANNEL_ROUTE,
  };
}
