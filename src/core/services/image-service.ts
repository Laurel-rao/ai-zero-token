import { AuthService } from "./auth-service.js";
import { ConfigService } from "./config-service.js";
import { askOpenAICodex } from "../providers/openai-codex/chat.js";
import { generateChatGPTWebImage } from "../providers/openai-codex/chatgpt-web-image.js";
import type { OAuthProfile } from "../types.js";
import { RequestThrottleService } from "./request-throttle-service.js";
type ImageRequest = {
  prompt: string;
  model?: string;
  n?: number;
  inputImages?: Array<{
    imageUrl: string;
  }>;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  outputFormat?: "png" | "webp" | "jpeg";
  outputCompression?: number;
  moderation?: "auto" | "low";
};

type ImageRequestLifecycle = {
  requestId?: string;
  priority?: number;
  onQueued?: () => void | Promise<void>;
  onStart?: (profile: OAuthProfile) => void | Promise<void>;
};

type ImageResult = {
  created: number;
  data: Array<{
    b64_json: string;
    revised_prompt?: string;
  }>;
  background?: "transparent" | "opaque";
  output_format?: "png" | "webp" | "jpeg";
  quality?: "low" | "medium" | "high";
  size?: string;
  usage?: {
    input_tokens: number;
    input_tokens_details?: {
      image_tokens: number;
      text_tokens: number;
    };
    output_tokens: number;
    output_tokens_details?: {
      image_tokens: number;
      text_tokens: number;
    };
    total_tokens: number;
  };
  _gatewayProfile?: OAuthProfile;
};

type ImageUsage = NonNullable<ImageResult["usage"]>;
type ImageTokenDetails = NonNullable<ImageUsage["input_tokens_details"]>;

type ImageGenerationOutput = {
  id?: string;
  type?: string;
  result?: unknown;
  partial_image_b64?: unknown;
  revised_prompt?: string;
  background?: string;
  output_format?: string;
  quality?: string;
  size?: string;
};

type ImageFailureDetails = {
  code?: string;
  message: string;
  requestId?: string;
  transient: boolean;
};

type ImageParseFailureMetadata = {
  upstreamText?: string;
  debug?: Record<string, unknown>;
  raw?: unknown;
};

const SUPPORTED_IMAGE_MODELS = new Set([
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
]);

const IMAGE_ORCHESTRATOR_MODEL = "gpt-5.4-mini";
const MAX_IMAGE_REQUEST_COUNT = 10;

const SUPPORTED_IMAGE_QUALITIES = new Set([
  "low",
  "medium",
  "high",
]);

const SUPPORTED_IMAGE_FORMATS = new Set([
  "png",
  "webp",
  "jpeg",
]);

const SUPPORTED_IMAGE_BACKGROUNDS = new Set([
  "transparent",
  "opaque",
]);

const IMAGE_GENERATION_MAX_ATTEMPTS = 3;
const IMAGE_GENERATION_RETRY_DELAYS_MS = [1500, 4000];

function normalizeImageRequestCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : 1;
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(MAX_IMAGE_REQUEST_COUNT, Math.max(1, Math.trunc(parsed)));
}

function sumTokenDetails(
  left: ImageTokenDetails | undefined,
  right: ImageTokenDetails | undefined,
): ImageTokenDetails | undefined {
  if (!left && !right) {
    return undefined;
  }
  return {
    image_tokens: (left?.image_tokens ?? 0) + (right?.image_tokens ?? 0),
    text_tokens: (left?.text_tokens ?? 0) + (right?.text_tokens ?? 0),
  };
}

function sumImageUsage(left: ImageResult["usage"] | undefined, right: ImageResult["usage"] | undefined): ImageResult["usage"] | undefined {
  if (!left && !right) {
    return undefined;
  }
  return {
    input_tokens: (left?.input_tokens ?? 0) + (right?.input_tokens ?? 0),
    input_tokens_details: sumTokenDetails(left?.input_tokens_details, right?.input_tokens_details),
    output_tokens: (left?.output_tokens ?? 0) + (right?.output_tokens ?? 0),
    output_tokens_details: sumTokenDetails(left?.output_tokens_details, right?.output_tokens_details),
    total_tokens: (left?.total_tokens ?? 0) + (right?.total_tokens ?? 0),
  };
}

function mergeImageResults(results: ImageResult[], count: number): ImageResult {
  const first = results[0];
  if (!first) {
    throw createError("图片生成失败：上游未返回图片。", 502);
  }
  const data = results.flatMap((result) => result.data).slice(0, count);
  const lastProfile = [...results].reverse().find((result) => result._gatewayProfile)?._gatewayProfile;
  return {
    created: first.created,
    data,
    background: first.background,
    output_format: first.output_format,
    quality: first.quality,
    size: first.size,
    usage: results.reduce<ImageResult["usage"] | undefined>((usage, result) => sumImageUsage(usage, result.usage), undefined),
    _gatewayProfile: lastProfile ?? first._gatewayProfile,
  };
}

function truncateForLog(value: string, max = 160): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toImageGenerationOutput(value: unknown): ImageGenerationOutput | null {
  if (!isRecord(value) || value.type !== "image_generation_call") {
    return null;
  }

  return value as ImageGenerationOutput;
}

function toImageGenerationEventOutput(value: unknown): ImageGenerationOutput | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (value.type.startsWith("response.output_item.") && isRecord(value.item)) {
    return toImageGenerationOutput(value.item);
  }

  if (value.type === "response.image_generation_call.partial_image") {
    return {
      id: typeof value.item_id === "string" ? value.item_id : undefined,
      type: "image_generation_call",
      partial_image_b64: typeof value.partial_image_b64 === "string" ? value.partial_image_b64 : undefined,
      background: typeof value.background === "string" ? value.background : undefined,
      output_format: typeof value.output_format === "string" ? value.output_format : undefined,
      size: typeof value.size === "string" ? value.size : undefined,
    };
  }

  return null;
}

function normalizeReturnedSize(size: unknown, fallback?: string): ImageResult["size"] | undefined {
  if (typeof size === "string" && size.trim()) {
    return size.trim();
  }

  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }

  return undefined;
}

function normalizeReturnedQuality(quality: unknown): ImageResult["quality"] | undefined {
  if (typeof quality === "string" && SUPPORTED_IMAGE_QUALITIES.has(quality)) {
    return quality as ImageResult["quality"];
  }

  return undefined;
}

function normalizeReturnedFormat(format: unknown): ImageResult["output_format"] | undefined {
  if (typeof format === "string" && SUPPORTED_IMAGE_FORMATS.has(format)) {
    return format as ImageResult["output_format"];
  }

  return undefined;
}

function normalizeReturnedBackground(background: unknown): ImageResult["background"] | undefined {
  if (typeof background === "string" && SUPPORTED_IMAGE_BACKGROUNDS.has(background)) {
    return background as ImageResult["background"];
  }

  return undefined;
}

function normalizeImageBase64(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const dataUrlMatch = /^data:image\/[^;,]+;base64,(.+)$/i.exec(trimmed);
  const base64 = dataUrlMatch?.[1] ?? trimmed;
  if (base64.length < 80 || !/^[A-Za-z0-9+/=_-]+$/.test(base64)) {
    return null;
  }

  return base64;
}

function collectImageBase64Values(value: unknown): string[] {
  const results: string[] = [];
  const add = (candidate: unknown) => {
    const base64 = normalizeImageBase64(candidate);
    if (base64 && !results.includes(base64)) {
      results.push(base64);
    }
  };

  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      add(candidate);
      return;
    }

    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }

    if (!isRecord(candidate)) {
      return;
    }

    for (const key of ["b64_json", "result", "image_base64", "base64", "image_data", "data", "images", "results", "output"]) {
      if (key in candidate) {
        visit(candidate[key]);
      }
    }
  };

  visit(value);
  return results;
}

function finalImageResults(image: ImageGenerationOutput): string[] {
  return collectImageBase64Values({
    result: image.result,
    b64_json: (image as Record<string, unknown>).b64_json,
    image_base64: (image as Record<string, unknown>).image_base64,
    base64: (image as Record<string, unknown>).base64,
    image_data: (image as Record<string, unknown>).image_data,
    data: (image as Record<string, unknown>).data,
    images: (image as Record<string, unknown>).images,
    results: (image as Record<string, unknown>).results,
    output: (image as Record<string, unknown>).output,
  });
}

function partialImageResults(image: ImageGenerationOutput): string[] {
  return collectImageBase64Values({
    partial_image_b64: image.partial_image_b64,
    partial_images: (image as Record<string, unknown>).partial_images,
  });
}

function expandImageOutput(image: ImageGenerationOutput, results: string[], fallbackId: string): ImageGenerationOutput[] {
  return results.map((result, index) => ({
    ...image,
    id: image.id ? `${image.id}${index === 0 ? "" : `:${index + 1}`}` : `${fallbackId}:${index + 1}`,
    result,
    partial_image_b64: undefined,
  }));
}

function collectExpandedImageOutput(
  target: Map<string, ImageGenerationOutput>,
  image: ImageGenerationOutput,
  fallbackId: string,
  mode: "final" | "partial",
): boolean {
  const results = mode === "final" ? finalImageResults(image) : partialImageResults(image);
  const expanded = expandImageOutput(image, results, fallbackId);
  for (let index = 0; index < expanded.length; index += 1) {
    const item = expanded[index];
    target.set(item.id ?? `${fallbackId}:${index + 1}`, item);
  }
  return expanded.length > 0;
}

function collectImageGenerationOutputs(raw: unknown): ImageGenerationOutput[] {
  if (!isRecord(raw)) {
    return [];
  }

  const finalItems = new Map<string, ImageGenerationOutput>();
  const partialItems = new Map<string, ImageGenerationOutput>();
  const response = isRecord(raw.response) ? raw.response : null;
  const events = Array.isArray(raw.events) ? raw.events : [];

  if (response && Array.isArray(response.output)) {
    for (let index = 0; index < response.output.length; index += 1) {
      const output = response.output[index];
      const image = toImageGenerationOutput(output);
      if (!image) {
        continue;
      }

      const fallbackId = `response:${index + 1}`;
      if (!collectExpandedImageOutput(finalItems, image, fallbackId, "final")) {
        collectExpandedImageOutput(partialItems, image, fallbackId, "partial");
      }
    }
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const image = toImageGenerationEventOutput(event);
    if (!image) {
      continue;
    }

    const fallbackId = `event:${index + 1}`;
    if (!collectExpandedImageOutput(finalItems, image, fallbackId, "final")) {
      collectExpandedImageOutput(partialItems, image, fallbackId, "partial");
    }
  }

  if (finalItems.size > 0) {
    return Array.from(finalItems.values());
  }

  return Array.from(partialItems.values()).map((item) => ({
    ...item,
    result: normalizeImageBase64(item.result) ?? normalizeImageBase64(item.partial_image_b64) ?? "",
  }));
}

function appendUniqueText(parts: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || parts.includes(normalized)) {
    return;
  }

  parts.push(normalized);
}

function collectOutputTextParts(value: unknown, parts: string[]): void {
  if (!isRecord(value)) {
    return;
  }

  appendUniqueText(parts, value.output_text);
  appendUniqueText(parts, value.text);

  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      if (!isRecord(part)) {
        continue;
      }
      appendUniqueText(parts, part.text);
      appendUniqueText(parts, part.output_text);
    }
  }

  if (Array.isArray(value.output)) {
    for (const output of value.output) {
      collectOutputTextParts(output, parts);
    }
  }
}

function extractUpstreamOutputText(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const parts: string[] = [];
  const response = isRecord(raw.response) ? raw.response : null;
  if (response) {
    collectOutputTextParts(response, parts);
  }

  const events = Array.isArray(raw.events) ? raw.events : [];
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }

    if (typeof event.type === "string" && event.type.includes("output_text")) {
      appendUniqueText(parts, event.delta);
      appendUniqueText(parts, event.text);
    }

    if (isRecord(event.part)) {
      collectOutputTextParts(event.part, parts);
    }
    if (isRecord(event.item)) {
      collectOutputTextParts(event.item, parts);
    }
  }

  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined ? truncateForLog(joined, 1000) : undefined;
}

function summarizeImageDebug(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    return {
      rawType: typeof raw,
    };
  }

  const response = isRecord(raw.response) ? raw.response : null;
  const events = Array.isArray(raw.events) ? raw.events : [];
  const describeValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      return {
        type: "string",
        length: value.length,
        preview: value.slice(0, 80),
      };
    }

    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
      };
    }

    if (isRecord(value)) {
      return {
        type: "object",
        keys: Object.keys(value).slice(0, 20),
      };
    }

    return {
      type: typeof value,
      value,
    };
  };
  const imageEvents = events
    .filter((event) => isRecord(event) && typeof event.type === "string" && event.type.includes("image_generation"))
    .slice(0, 12)
    .map((event) => {
      const safeEvent = event as Record<string, unknown>;
      const item = isRecord(safeEvent.item) ? safeEvent.item : null;
      return {
        type: safeEvent.type,
        item_id: typeof safeEvent.item_id === "string" ? safeEvent.item_id : undefined,
        output_index: typeof safeEvent.output_index === "number" ? safeEvent.output_index : undefined,
        keys: Object.keys(safeEvent).slice(0, 24),
        status: typeof safeEvent.status === "string" ? safeEvent.status : undefined,
        item: item
          ? {
              id: typeof item.id === "string" ? item.id : undefined,
              type: typeof item.type === "string" ? item.type : undefined,
              status: typeof item.status === "string" ? item.status : undefined,
              keys: Object.keys(item).slice(0, 24),
              result: describeValue(item.result),
              partial_image_b64: describeValue(item.partial_image_b64),
            }
          : undefined,
        result: describeValue(safeEvent.result),
        partial_image_b64_length:
          typeof safeEvent.partial_image_b64 === "string" ? safeEvent.partial_image_b64.length : undefined,
      };
    });
  const outputItems = Array.isArray(response?.output)
    ? response.output.slice(0, 12).map((item) => {
        if (!isRecord(item)) {
          return describeValue(item);
        }

        return {
          id: typeof item.id === "string" ? item.id : undefined,
          type: typeof item.type === "string" ? item.type : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
          keys: Object.keys(item).slice(0, 24),
          result: describeValue(item.result),
          partial_image_b64: describeValue(item.partial_image_b64),
        };
      })
    : [];

  return {
    response_status: typeof response?.status === "string" ? response.status : undefined,
    response_error: isRecord(response?.error)
      ? {
          code: typeof response.error.code === "string" ? response.error.code : undefined,
          message: typeof response.error.message === "string" ? response.error.message : undefined,
          type: typeof response.error.type === "string" ? response.error.type : undefined,
        }
      : undefined,
    response_output_length: Array.isArray(response?.output) ? response.output.length : 0,
    response_output_items: outputItems,
    event_count: events.length,
    event_types: events
      .filter((event) => isRecord(event) && typeof event.type === "string")
      .slice(0, 20)
      .map((event) => (event as Record<string, unknown>).type),
    output_text_preview: extractUpstreamOutputText(raw),
    error_events: events
      .filter((event) => isRecord(event) && (event.type === "error" || event.type === "response.failed"))
      .slice(0, 5)
      .map((event) => {
        const safeEvent = event as Record<string, unknown>;
        const eventError = isRecord(safeEvent.error) ? safeEvent.error : null;
        const eventResponse = isRecord(safeEvent.response) ? safeEvent.response : null;
        const responseError = eventResponse && isRecord(eventResponse.error) ? eventResponse.error : null;
        return {
          type: safeEvent.type,
          code:
            typeof eventError?.code === "string"
              ? eventError.code
              : typeof responseError?.code === "string"
                ? responseError.code
                : undefined,
          message:
            typeof eventError?.message === "string"
              ? eventError.message
              : typeof responseError?.message === "string"
                ? responseError.message
                : undefined,
        };
      }),
    image_events: imageEvents,
  };
}

function extractRequestIdFromMessage(message: string): string | undefined {
  const match = message.match(/request ID ([a-z0-9-]+)/i);
  return match?.[1];
}

function createImageFailureDetails(code: unknown, message: unknown): ImageFailureDetails | null {
  const normalizedMessage =
    typeof message === "string" && message.trim()
      ? message.trim()
      : typeof code === "string" && code.trim()
        ? code.trim()
        : null;

  if (!normalizedMessage) {
    return null;
  }

  const normalizedCode = typeof code === "string" && code.trim() ? code.trim() : undefined;
  return {
    code: normalizedCode,
    message: normalizedMessage,
    requestId: extractRequestIdFromMessage(normalizedMessage),
    transient:
      normalizedCode === "server_error" ||
      /retry your request/i.test(normalizedMessage) ||
      /temporar/i.test(normalizedMessage),
  };
}

function extractImageFailureDetails(raw: unknown): ImageFailureDetails | null {
  if (!isRecord(raw)) {
    return null;
  }

  const response = isRecord(raw.response) ? raw.response : null;
  if (response) {
    const responseError = isRecord(response.error) ? response.error : null;
    const responseStatus = typeof response.status === "string" ? response.status : undefined;
    const details = createImageFailureDetails(responseError?.code, responseError?.message);
    if (responseStatus === "failed" && details) {
      return details;
    }
  }

  const events = Array.isArray(raw.events) ? raw.events : [];
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }

    if (event.type === "error") {
      const eventError = isRecord(event.error) ? event.error : event;
      const details = createImageFailureDetails(eventError.code, eventError.message);
      if (details) {
        return details;
      }
    }

    if (event.type === "response.failed" && isRecord(event.response)) {
      const responseError = isRecord(event.response.error) ? event.response.error : null;
      const details = createImageFailureDetails(responseError?.code, responseError?.message);
      if (details) {
        return details;
      }
    }
  }

  return null;
}

function createError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function createImageParseError(
  message: string,
  statusCode: number,
  metadata?: ImageParseFailureMetadata,
): Error & { statusCode: number; upstreamText?: string; imageDebug?: Record<string, unknown>; upstreamRaw?: unknown } {
  const error = createError(message, statusCode) as Error & {
    statusCode: number;
    upstreamText?: string;
    imageDebug?: Record<string, unknown>;
    upstreamRaw?: unknown;
  };
  if (metadata?.upstreamText) {
    error.upstreamText = metadata.upstreamText;
  }
  if (metadata?.debug) {
    error.imageDebug = metadata.debug;
  }
  if (typeof metadata?.raw !== "undefined") {
    error.upstreamRaw = metadata.raw;
  }
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractImageUsage(raw: unknown): ImageResult["usage"] | undefined {
  if (!isRecord(raw) || !isRecord(raw.response)) {
    return undefined;
  }

  const toolUsage = isRecord(raw.response.tool_usage) ? raw.response.tool_usage : null;
  const imageGen = toolUsage && isRecord(toolUsage.image_gen) ? toolUsage.image_gen : null;
  if (
    !imageGen ||
    typeof imageGen.input_tokens !== "number" ||
    typeof imageGen.output_tokens !== "number" ||
    typeof imageGen.total_tokens !== "number"
  ) {
    return undefined;
  }

  return {
    input_tokens: imageGen.input_tokens,
    input_tokens_details: isRecord(imageGen.input_tokens_details)
      ? {
          image_tokens: Number(imageGen.input_tokens_details.image_tokens ?? 0),
          text_tokens: Number(imageGen.input_tokens_details.text_tokens ?? 0),
        }
      : undefined,
    output_tokens: imageGen.output_tokens,
    output_tokens_details: isRecord(imageGen.output_tokens_details)
      ? {
          image_tokens: Number(imageGen.output_tokens_details.image_tokens ?? 0),
          text_tokens: Number(imageGen.output_tokens_details.text_tokens ?? 0),
        }
      : undefined,
    total_tokens: imageGen.total_tokens,
  };
}

function isFreePlan(profile: OAuthProfile): boolean {
  return profile.quota?.planType?.toLowerCase() === "free";
}

function attachGatewayProfileToError(error: unknown, profile: OAuthProfile): void {
  if (error && typeof error === "object") {
    (error as { _gatewayProfile?: OAuthProfile })._gatewayProfile = profile;
  }
}

export class ImageService {
  constructor(
    private readonly deps: {
      authService: AuthService;
      configService: ConfigService;
      requestThrottleService: RequestThrottleService;
    },
  ) {}

  private resolveRequestedImageModel(model?: string): string {
    if (!model) {
      return "gpt-image-2";
    }

    if (!SUPPORTED_IMAGE_MODELS.has(model)) {
      throw new Error(`当前网关仅支持这些生图模型: ${Array.from(SUPPORTED_IMAGE_MODELS).join(", ")}`);
    }

    return model;
  }

  async generate(request: ImageRequest, lifecycle?: ImageRequestLifecycle): Promise<ImageResult> {
    const count = normalizeImageRequestCount(request.n);
    const results: ImageResult[] = [];
    while (results.reduce((total, result) => total + result.data.length, 0) < count) {
      const result = await this.generateSingle(request, lifecycle);
      results.push(result);
      if (result.data.length === 0) {
        break;
      }
    }
    return mergeImageResults(results, count);
  }

  private async generateSingle(request: ImageRequest, lifecycle?: ImageRequestLifecycle): Promise<ImageResult> {
    const profile = await this.deps.authService.requireUsableProfile("openai-codex");
    const orchestratorModel = IMAGE_ORCHESTRATOR_MODEL;
    const requestedImageModel = this.resolveRequestedImageModel(request.model);
    const settings = await this.deps.configService.getSettings();
    const requestSummary = {
      requestedImageModel,
      orchestratorModel,
      promptLength: request.prompt.length,
      promptPreview: truncateForLog(request.prompt),
      size: request.size ?? "default",
      quality: request.quality ?? "default",
      background: request.background ?? "default",
      outputFormat: request.outputFormat ?? "default",
      outputCompression: typeof request.outputCompression === "number" ? request.outputCompression : undefined,
      moderation: request.moderation ?? "default",
      inputImageCount: request.inputImages?.length ?? 0,
    };

    console.info("[gateway:image] upstream request", requestSummary);

    if (isFreePlan(profile) && settings.image.freeAccountWebGenerationEnabled) {
      try {
        console.info("[gateway:image] using ChatGPT web image route for Free profile", requestSummary);
        const response = await this.deps.requestThrottleService.runForProfile(
          profile,
          () => generateChatGPTWebImage({
            profile,
            prompt: request.prompt,
            model: requestedImageModel,
            inputImages: request.inputImages,
            size: request.size,
            responseFormat: "b64_json",
            timeoutMs: settings.image.generationTimeoutMs,
          }),
          {
            requestId: lifecycle?.requestId,
            route: "images/chatgpt-web",
            model: requestedImageModel,
            priority: lifecycle?.priority,
            onQueued: lifecycle?.onQueued,
            onStart: () => lifecycle?.onStart?.(profile),
          },
        );
        await this.deps.authService.recordProfileRequestSuccess(profile.profileId, undefined, "openai-codex");
        console.info("[gateway:image] ChatGPT web image response", {
          ...requestSummary,
          imageCount: response.data.length,
          firstImageBase64Length: response.data[0]?.b64_json.length ?? 0,
        });
        return {
          ...response,
          _gatewayProfile: profile,
        };
      } catch (error) {
        await this.deps.authService.recordProfileRequestFailure(profile.profileId, error, undefined, "openai-codex");
        attachGatewayProfileToError(error, profile);
        throw error;
      }
    }

    const tool: Record<string, unknown> = {
      type: "image_generation",
      model: requestedImageModel,
    };

    if (request.size) {
      tool.size = request.size;
    }
    if (request.quality) {
      tool.quality = request.quality;
    }
    if (request.background) {
      tool.background = request.background;
    }
    if (request.outputFormat) {
      tool.output_format = request.outputFormat;
    }
    if (typeof request.outputCompression === "number") {
      tool.output_compression = request.outputCompression;
    }
    if (request.moderation) {
      tool.moderation = request.moderation;
    }
    if (request.inputImages && request.inputImages.length > 0) {
      tool.action = "edit";
    }

    for (let attempt = 1; attempt <= IMAGE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await this.deps.requestThrottleService.runForProfile(
          profile,
          () => askOpenAICodex({
            profile,
            model: orchestratorModel,
            bodyOverride: {
              model: orchestratorModel,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: request.prompt,
                    },
                    ...(request.inputImages ?? []).map((image) => ({
                      type: "input_image",
                      image_url: image.imageUrl,
                    })),
                  ],
                },
              ],
              tools: [tool],
              tool_choice: {
                type: "image_generation",
              },
              include: ["reasoning.encrypted_content"],
            },
          }),
          {
            requestId: lifecycle?.requestId,
            route: request.inputImages && request.inputImages.length > 0 ? "images/edits" : "images/generations",
            model: orchestratorModel,
            priority: lifecycle?.priority,
            onQueued: lifecycle?.onQueued,
            onStart: () => lifecycle?.onStart?.(profile),
          },
        );
        await this.deps.authService.recordProfileRequestSuccess(profile.profileId, result.quota, "openai-codex");
      } catch (error) {
        const quota = (error as { quota?: import("../types.js").CodexQuotaSnapshot }).quota;
        await this.deps.authService.recordProfileRequestFailure(profile.profileId, error, quota, "openai-codex");
        attachGatewayProfileToError(error, profile);
        throw error;
      }

      const raw = isRecord(result.raw) ? result.raw : {};
      const response = isRecord(raw.response) ? raw.response : null;
      const images = collectImageGenerationOutputs(raw);
      const debugSummary = summarizeImageDebug(raw);
      const upstreamText = extractUpstreamOutputText(raw);
      if (images.length === 0) {
        const upstreamFailure = extractImageFailureDetails(raw);
        console.error("[gateway:image] parse failure", {
          ...requestSummary,
          attempt,
          upstreamFailure,
          upstreamText,
          debug: debugSummary,
        });

        if (upstreamFailure?.transient && attempt < IMAGE_GENERATION_MAX_ATTEMPTS) {
          const retryDelayMs = IMAGE_GENERATION_RETRY_DELAYS_MS[attempt - 1] ?? 4000;
          console.warn("[gateway:image] transient upstream failure, retrying", {
            ...requestSummary,
            attempt,
            retryDelayMs,
            code: upstreamFailure.code,
            requestId: upstreamFailure.requestId,
          });
          await sleep(retryDelayMs);
          continue;
        }

        if (upstreamFailure) {
          const reason = upstreamFailure.code ? `${upstreamFailure.code}: ${upstreamFailure.message}` : upstreamFailure.message;
          throw createImageParseError(`上游图片生成失败: ${reason}`, upstreamFailure.transient ? 503 : 502, {
            upstreamText,
            debug: debugSummary,
            raw,
          });
        }

        if (request.inputImages && request.inputImages.length > 0) {
          try {
            console.warn("[gateway:image] Codex image edit returned no image; falling back to ChatGPT web image route", {
              ...requestSummary,
              attempt,
              debug: debugSummary,
            });
            const fallbackResponse = await this.deps.requestThrottleService.runForProfile(
              profile,
              () => generateChatGPTWebImage({
                profile,
                prompt: request.prompt,
                model: requestedImageModel,
                inputImages: request.inputImages,
                size: request.size,
                responseFormat: "b64_json",
                timeoutMs: settings.image.generationTimeoutMs,
              }),
              {
                requestId: lifecycle?.requestId,
                route: "images/chatgpt-web-fallback",
                model: requestedImageModel,
                priority: lifecycle?.priority,
                onQueued: lifecycle?.onQueued,
                onStart: () => lifecycle?.onStart?.(profile),
              },
            );
            await this.deps.authService.recordProfileRequestSuccess(profile.profileId, undefined, "openai-codex");
            console.info("[gateway:image] ChatGPT web image fallback response", {
              ...requestSummary,
              imageCount: fallbackResponse.data.length,
              firstImageBase64Length: fallbackResponse.data[0]?.b64_json.length ?? 0,
            });
            return {
              ...fallbackResponse,
              _gatewayProfile: profile,
            };
          } catch (fallbackError) {
            console.warn("[gateway:image] ChatGPT web image fallback failed", {
              ...requestSummary,
              attempt,
              message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
          }
        }
        const message = upstreamText
          ? `图片生成请求已完成，但上游未返回图片。原始返回: ${upstreamText}`
          : "图片生成请求已完成，但没有解析出 image_generation_call 结果。";
        throw createImageParseError(message, 502, {
          upstreamText,
          debug: debugSummary,
          raw,
        });
      }

      const first = images[0];
      const imageResult: ImageResult = {
        created:
          typeof response?.created_at === "number"
            ? response.created_at
            : Math.floor(Date.now() / 1000),
        data: images.map((image) => ({
          b64_json: normalizeImageBase64(image.result) ?? "",
          ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}),
        })),
        background: normalizeReturnedBackground(first.background),
        output_format: normalizeReturnedFormat(first.output_format),
        quality: normalizeReturnedQuality(first.quality),
        size: normalizeReturnedSize(first.size, request.size),
        usage: extractImageUsage(raw),
        _gatewayProfile: profile,
      };

      console.info("[gateway:image] upstream response", {
        ...requestSummary,
        attempt,
        imageCount: imageResult.data.length,
        firstImageBase64Length: imageResult.data[0]?.b64_json.length ?? 0,
        outputFormat: imageResult.output_format ?? request.outputFormat ?? "unknown",
        quality: imageResult.quality ?? request.quality ?? "unknown",
        size: imageResult.size ?? request.size ?? "unknown",
        debug: debugSummary,
      });

      return imageResult;
    }

    throw createError("图片生成失败：超过最大重试次数。", 503);
  }
}
