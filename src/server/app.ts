import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  brotliDecompress,
  gunzip,
  inflate,
  zstdDecompress,
} from "node:zlib";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { createGatewayContext } from "../core/context.js";
import type { ChatResult, GatewaySettings, OAuthProfile, ProfileSummary } from "../core/types.js";
import { isTransientHttpError, requestText } from "../core/providers/http-client.js";
import { streamOpenAICodex } from "../core/providers/openai-codex/chat.js";
import { generateChatGPTWebImage, type ChatGPTWebImageResult } from "../core/providers/openai-codex/chatgpt-web-image.js";
import {
  startOpenAICodexRemoteLogin,
  type OpenAICodexRemoteLoginSession,
} from "../core/providers/openai-codex/oauth.js";
import type { UsageImageRoute, UsageRecordEvent, UsageTokenStatus, UsageTokenUsage } from "../core/services/usage-service.js";
import type { GatewayUserRole } from "../core/services/gateway-database-service.js";
import { getGenerationAssetsDir } from "../core/store/state-paths.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const adminUiDistDir = path.join(packageRoot, "admin-ui", "dist");
const adminUiIndexPath = path.join(adminUiDistDir, "index.html");
const BYTES_PER_MIB = 1024 * 1024;
const MAX_GATEWAY_REQUEST_LOGS = 100;
const MAX_PERSISTED_REQUEST_LOGS = 200;
const MAX_CODEX_RESPONSE_PROFILE_BINDINGS = 5000;
const CODEX_STREAM_DRAIN_AFTER_CLIENT_CLOSE_MS = 30_000;
const IMAGE_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ROUTE_BODY_LIMIT_BYTES = 128 * BYTES_PER_MIB;
const CODEX_COMPACT_BODY_LIMIT_BYTES = 256 * BYTES_PER_MIB;
const ADMIN_SESSION_COOKIE = "azt_admin_session";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const WECOM_LOGIN_STATE_COOKIE = "azt_wecom_login_state";
const WECOM_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const WECOM_EMBED_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const WECOM_EMBED_COMPLETE_TTL_MS = 60 * 1000;
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
const zstdDecompressAsync = typeof zstdDecompress === "function" ? promisify(zstdDecompress) : null;

const assetContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

type GatewayRequestLog = {
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

type GatewayRequestUsageMeta = {
  profile?: OAuthProfile | null;
  tokenUsage?: UsageTokenUsage | null;
  tokenUsageStatus?: UsageTokenStatus;
  imageCount?: number;
  imageRoute?: UsageImageRoute;
  errorType?: string;
};

type GatewayImageAsset = {
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  previewUrl?: string;
  previewMimeType?: string;
  previewSize?: number;
};

type ImageLimitCheckResult = {
  allowed: boolean;
  message?: string;
  reason?: "daily" | "hourly" | "interval";
  retryAfterSeconds?: number;
  usage?: {
    owner: string;
    dailyCount: number;
    hourlyCount: number;
    perUserDaily: number;
    perUserHourly: number;
    minIntervalSeconds: number;
    lastCreatedAt?: number;
  };
};

type GatewayShareAddress = {
  host: string;
  label: string;
  adminUrl: string;
  baseUrl: string;
  codexBaseUrl: string;
};

type SecurityConfig = {
  adminUser: string | null;
  adminPasswordHash: string | null;
  apiKeyHash: string | null;
  sessionSecret: string;
};

type AdminSession = {
  user: string;
  role: GatewayUserRole;
  expiresAt: number;
};

type WecomLoginChannel = "qr" | "oauth";

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getEnvValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function createSecurityConfig(): SecurityConfig {
  const adminUser = getEnvValue("AZT_ADMIN_USER", "ADMIN_USER");
  const adminPassword = getEnvValue("AZT_ADMIN_PASSWORD", "ADMIN_PASSWORD");
  const apiKey = getEnvValue("AZT_API_KEY", "API_KEY");
  const sessionSecret = getEnvValue("AZT_SESSION_SECRET", "SESSION_SECRET") ?? "change-me";

  return {
    adminUser,
    adminPasswordHash: adminPassword ? hashSecret(adminPassword) : null,
    apiKeyHash: apiKey ? hashSecret(apiKey) : null,
    sessionSecret,
  };
}

function secureEqualHash(hash: string | null, value: string | null | undefined): boolean {
  if (!hash || !value) {
    return false;
  }
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(hashSecret(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function toGatewayImageAssets(
  images: Array<{
    filename: string;
    url: string;
    mimeType: string;
    size: number;
    previewUrl?: string;
    previewMimeType?: string;
    previewSize?: number;
    width?: number;
    height?: number;
  }>,
): GatewayImageAsset[] {
  return images.map((image) => ({
    filename: image.filename,
    url: image.url,
    mimeType: image.mimeType,
    size: image.size,
    width: image.width,
    height: image.height,
    previewUrl: image.previewUrl,
    previewMimeType: image.previewMimeType,
    previewSize: image.previewSize,
  }));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

function createAdminSessionToken(config: SecurityConfig, user: string, role: GatewayUserRole): string {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const nonce = randomBytes(16).toString("hex");
  const payload = Buffer.from(JSON.stringify({ user, role, expiresAt, nonce }), "utf8").toString("base64url");
  const signature = createHash("sha256")
    .update(`${payload}.${config.sessionSecret}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(config: SecurityConfig, token: string | undefined): AdminSession | null {
  if (!token) {
    return null;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }
  const expected = createHash("sha256")
    .update(`${payload}.${config.sessionSecret}`)
    .digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AdminSession>;
    if (typeof parsed.user !== "string" || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      return null;
    }
    const role = parsed.role === "user" ? "user" : "admin";
    return { user: parsed.user, role, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function buildSessionCookie(token: string): string {
  const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000);
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function buildExpiredSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function buildWecomStateCookie(state: string): string {
  const maxAge = Math.floor(WECOM_LOGIN_STATE_TTL_MS / 1000);
  return `${WECOM_LOGIN_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function buildExpiredWecomStateCookie(): string {
  return `${WECOM_LOGIN_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function getAdminSessionFromRequest(config: SecurityConfig, request: FastifyRequest): AdminSession | null {
  const cookies = parseCookies(request.headers.cookie);
  return verifyAdminSessionToken(config, cookies[ADMIN_SESSION_COOKIE]);
}

function isAdminSession(session: AdminSession | null): boolean {
  return session?.role === "admin";
}

function requestOwnerFromSession(session: AdminSession | null): string | undefined {
  return session?.user;
}

function isWecomUserAgent(userAgent: string | undefined): boolean {
  return /wxwork|micromessenger/i.test(userAgent ?? "");
}

function isPublicPath(method: string, url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "/";
  return method === "OPTIONS" ||
    pathOnly === "/" ||
    pathOnly === "/favicon.ico" ||
    pathOnly === "/_gateway/health" ||
    pathOnly === "/_gateway/auth/status" ||
    pathOnly === "/_gateway/auth/login" ||
    pathOnly === "/_gateway/auth/wecom/start" ||
    pathOnly === "/_gateway/auth/wecom/oauth/start" ||
    pathOnly === "/_gateway/auth/wecom/url" ||
    pathOnly === "/_gateway/auth/wecom/panel-config" ||
    pathOnly === "/_gateway/auth/wecom/panel-login" ||
    pathOnly === "/_gateway/auth/wecom/callback" ||
    pathOnly === "/_gateway/auth/wecom/complete" ||
    pathOnly === "/_gateway/auth/logout" ||
    pathOnly.startsWith("/assets/");
}

function isAdminPath(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "/";
  return pathOnly.startsWith("/_gateway/");
}

function isUserGatewayPath(method: string, url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "/";
  if (method === "GET" && pathOnly === "/_gateway/admin/config") {
    return true;
  }
  if (method === "GET" && pathOnly === "/_gateway/admin/request-logs") {
    return true;
  }
  if ((method === "GET" || method === "DELETE") && pathOnly === "/_gateway/generations/history") {
    return true;
  }
  if (method === "GET" && pathOnly.startsWith("/_gateway/generations/images/")) {
    return true;
  }
  return false;
}

function isApiPath(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "/";
  return pathOnly.startsWith("/v1/") || pathOnly.startsWith("/codex/v1/");
}

type CodexImageGenerationRequest = {
  prompt: string;
  inputImages: Array<{ imageUrl: string }>;
  imageModel: string;
  size?: string;
  outputFormat?: "png" | "webp" | "jpeg";
};

function getContentType(filePath: string): string {
  return assetContentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function decodeJsonRequestBody(body: Buffer, contentEncoding: string | string[] | undefined): Promise<Buffer> {
  const encodings = (Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== "identity");

  let decoded = body;
  for (const encoding of encodings.reverse()) {
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = await gunzipAsync(decoded);
    } else if (encoding === "deflate") {
      decoded = await inflateAsync(decoded);
    } else if (encoding === "br") {
      decoded = await brotliDecompressAsync(decoded);
    } else if (encoding === "zstd") {
      if (!zstdDecompressAsync) {
        throw new Error("当前 Node.js 运行时不支持 zstd 请求体解压，请升级运行时后重试。");
      }
      decoded = await zstdDecompressAsync(decoded);
    } else {
      throw new Error(`不支持的请求体压缩格式: ${encoding}`);
    }
  }

  return decoded;
}

async function parseJsonRequestBody(request: FastifyRequest, body: string | Buffer): Promise<unknown> {
  const rawBody = typeof body === "string" ? Buffer.from(body) : body;
  if (rawBody.length === 0) {
    return {};
  }

  const decoded = await decodeJsonRequestBody(rawBody, request.headers["content-encoding"]);
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

async function readAdminUiAsset(assetPath: string): Promise<{ body: Buffer; filePath: string } | null> {
  const normalized = path.normalize(assetPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.resolve(adminUiDistDir, normalized);
  const root = path.resolve(adminUiDistDir);

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  try {
    return {
      body: await fs.readFile(filePath),
      filePath,
    };
  } catch {
    return null;
  }
}

const responsesBodySchema = z.object({
  model: z.string().optional(),
  input: z.unknown().optional(),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  include: z.array(z.string()).optional(),
  text: z.record(z.string(), z.unknown()).optional(),
  store: z.boolean().optional(),
  parallel_tool_calls: z.boolean().optional(),
  experimental_codex: z
    .object({
      body: z.record(z.string(), z.unknown()).optional(),
      allow_unknown_model: z.boolean().optional(),
      include_raw: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

const chatCompletionContentPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    image_url: z
      .union([
        z.string(),
        z
          .object({
            url: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

const chatCompletionMessageSchema = z
  .object({
    role: z.string().optional(),
    content: z.union([z.string(), z.array(chatCompletionContentPartSchema)]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();

const chatCompletionsBodySchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(chatCompletionMessageSchema).min(1),
    n: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    store: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    user: z.string().optional(),
  })
  .passthrough();

const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const wecomCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  embed: z.coerce.boolean().optional(),
  channel: z.enum(["qr", "oauth"]).optional(),
});

const wecomCompleteQuerySchema = z.object({
  token: z.string().min(1),
});

const wecomPanelLoginSchema = z.object({
  code: z.string().min(1),
});

const gatewayUserCreateSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(6).max(200),
  role: z.enum(["admin", "user"]).default("user"),
});

const gatewayUserUpdateSchema = z.object({
  password: z.string().min(6).max(200).optional(),
  role: z.enum(["admin", "user"]).optional(),
  disabled: z.boolean().optional(),
});

const gatewayUserParamsSchema = z.object({
  id: z.string().min(1),
});

const settingsUpdateSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  networkProxy: z
    .object({
      enabled: z.boolean(),
      url: z.string().optional(),
      noProxy: z.string().optional(),
    })
    .optional(),
  autoSwitch: z
    .object({
      enabled: z.boolean().optional(),
      excludedProfileIds: z.array(z.string()).optional(),
    })
    .optional(),
  accountRotation: z
    .object({
      enabled: z.boolean().optional(),
      strategy: z.literal("round_robin").optional(),
    })
    .optional(),
  runtime: z
    .object({
      quotaSyncConcurrency: z.number().int().min(1).max(32).optional(),
      accountMaxConcurrency: z.number().int().min(1).max(32).optional(),
      codexRequestSerializationEnabled: z.boolean().optional(),
      codexRequestMinDelayMs: z.number().int().min(0).max(60_000).optional(),
      codexRequestJitterMs: z.number().int().min(0).max(60_000).optional(),
    })
    .optional(),
  image: z
    .object({
      freeAccountWebGenerationEnabled: z.boolean().optional(),
      limits: z
        .object({
          enabled: z.boolean().optional(),
          perUserDaily: z.number().int().min(0).max(100_000).optional(),
          perUserHourly: z.number().int().min(0).max(100_000).optional(),
          minIntervalSeconds: z.number().int().min(0).max(86_400).optional(),
          userOverrides: z
            .array(
              z.object({
                username: z.string().min(1).max(120),
                perUserDaily: z.number().int().min(0).max(100_000).optional(),
                perUserHourly: z.number().int().min(0).max(100_000).optional(),
                minIntervalSeconds: z.number().int().min(0).max(86_400).optional(),
              }),
            )
            .max(500)
            .optional(),
        })
        .optional(),
    })
    .optional(),
  wecom: z
    .object({
      enabled: z.boolean().optional(),
      corpId: z.string().optional(),
      agentId: z.string().optional(),
      secret: z.string().optional(),
    })
    .optional(),
  server: z
    .object({
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
});

const proxyTestSchema = z.object({
  networkProxy: z.object({
    enabled: z.boolean(),
    url: z.string().optional(),
    noProxy: z.string().optional(),
  }),
});

const profileActionSchema = z.object({
  profileId: z.string().min(1),
});

const profileRemoveBatchSchema = z.object({
  profileIds: z.array(z.string().min(1)).min(1),
});

const profileImportSchema = z.object({
  profile: z.unknown(),
});

const runtimeRefreshSchema = z.object({
  staleOnly: z.boolean().optional(),
});

const oauthManualSchema = z.object({
  loginId: z.string().min(1),
  input: z.string().min(1),
});

const oauthCancelSchema = z.object({
  loginId: z.string().min(1),
});

const profileExportSchema = z.object({
  profileId: z.string().min(1).optional(),
  profileIds: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
});

const codexApplySchema = z.object({
  profileId: z.string().min(1),
});

const codexProviderConfigSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});

const githubImageBedConfigSchema = z.object({
  token: z.string().min(1),
});

const githubImageBedUploadSchema = z.object({
  filename: z.string().min(1),
  dataUrl: z.string().min(1),
});

const githubImageBedHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const githubImageBedHistoryParamsSchema = z.object({
  id: z.string().min(1),
});

const generationHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  owner: z.string().min(1).max(120).optional(),
});

const requestLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  owner: z.string().min(1).max(120).optional(),
});

const imageGenerationsBodySchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    n: z.number().int().positive().optional(),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    size: z.string().min(1).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "webp", "jpeg"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z.enum(["b64_json", "url"]).optional(),
    user: z.string().optional(),
  })
  .passthrough();

const imageReferenceSchema = z.union([
  z.string().min(1),
  z
    .object({
      image_url: z.string().min(1).optional(),
      file_id: z.string().min(1).optional(),
    })
    .passthrough(),
]);

const imageEditsBodySchema = z
  .object({
    prompt: z.string().min(1),
    images: z.array(imageReferenceSchema).min(1).max(16).optional(),
    image: z.union([imageReferenceSchema, z.array(imageReferenceSchema).min(1).max(16)]).optional(),
    mask: imageReferenceSchema.optional(),
    model: z.string().optional(),
    n: z.number().int().positive().optional(),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    size: z.string().min(1).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "webp", "jpeg"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z.enum(["b64_json", "url"]).optional(),
    user: z.string().optional(),
  })
  .passthrough();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function sumTokenNumbers(value: Record<string, unknown> | null, keys: string[]): number | null {
  if (!value) {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const key of keys) {
    const item = tokenNumber(value[key]);
    if (item !== null) {
      total += item;
      seen = true;
    }
  }
  return seen ? total : null;
}

function normalizeTokenUsage(value: unknown): UsageTokenUsage | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const inputTokens = tokenNumber(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = tokenNumber(value.output_tokens ?? value.completion_tokens);
  const inputDetails = isObjectRecord(value.input_tokens_details) ? value.input_tokens_details : null;
  const promptDetails = isObjectRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null;
  const cacheCreation = isObjectRecord(value.cache_creation) ? value.cache_creation : null;
  const openAiCachedTokens = tokenNumber(inputDetails?.cached_tokens ?? promptDetails?.cached_tokens);
  const cacheReadTokens = openAiCachedTokens ?? tokenNumber(value.cache_read_input_tokens ?? value.cached_tokens);
  const cacheCreationTokens =
    tokenNumber(value.cache_creation_input_tokens ?? value.cache_creation_tokens) ??
    tokenNumber(inputDetails?.cache_creation_tokens ?? promptDetails?.cache_creation_tokens) ??
    sumTokenNumbers(cacheCreation, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);
  const inputIncludesCacheRead = openAiCachedTokens !== null;
  const inferredTotalTokens =
    inputTokens !== null || outputTokens !== null || cacheReadTokens !== null || cacheCreationTokens !== null
      ? (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (inputIncludesCacheRead ? 0 : (cacheReadTokens ?? 0)) +
        (cacheCreationTokens ?? 0)
      : null;
  const totalTokens = tokenNumber(value.total_tokens) ?? inferredTotalTokens;
  const uncachedInputTokens =
    inputTokens !== null
      ? inputIncludesCacheRead
        ? Math.max(0, inputTokens - (cacheReadTokens ?? 0))
        : inputTokens
      : null;
  if (inputTokens === null && outputTokens === null && totalTokens === null && cacheReadTokens === null && cacheCreationTokens === null) {
    return null;
  }
  return {
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens,
    cacheCreationTokens,
    cacheReadTokens,
  };
}

function extractTokenUsage(value: unknown, depth = 0): UsageTokenUsage | null {
  if (depth > 5 || !value) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = extractTokenUsage(item, depth + 1);
      if (usage) {
        return usage;
      }
    }
    return null;
  }
  if (!isObjectRecord(value)) {
    return null;
  }
  const direct = normalizeTokenUsage(value);
  if (direct) {
    return direct;
  }
  for (const key of ["usage", "response", "events"]) {
    const usage = extractTokenUsage(value[key], depth + 1);
    if (usage) {
      return usage;
    }
  }
  return null;
}

function imageUsageToTokenUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} | undefined): UsageTokenUsage | null {
  if (!usage) {
    return null;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function buildResponsesUsagePayload(usage: UsageTokenUsage | null): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = tokenNumber(usage.inputTokens) ?? 0;
  const outputTokens = tokenNumber(usage.outputTokens) ?? 0;
  const totalTokens = tokenNumber(usage.totalTokens) ?? inputTokens + outputTokens;
  const cacheReadTokens = tokenNumber(usage.cacheReadTokens);
  const cacheCreationTokens = tokenNumber(usage.cacheCreationTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(cacheReadTokens !== null ? { input_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
    ...(cacheCreationTokens !== null ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
  };
}

function buildChatCompletionsUsagePayload(usage: UsageTokenUsage | null): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = tokenNumber(usage.inputTokens) ?? 0;
  const completionTokens = tokenNumber(usage.outputTokens) ?? 0;
  const totalTokens = tokenNumber(usage.totalTokens) ?? promptTokens + completionTokens;
  const cacheReadTokens = tokenNumber(usage.cacheReadTokens);
  const cacheCreationTokens = tokenNumber(usage.cacheCreationTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(cacheReadTokens !== null ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
    ...(cacheCreationTokens !== null ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
  };
}

function extractUsageErrorType(details: Record<string, unknown> | undefined, statusCode: number): string | undefined {
  const error = isObjectRecord(details?.error) ? details.error : null;
  const upstreamErrorCode = error?.upstreamErrorCode;
  const upstreamStatus = error?.upstreamStatus;
  const type = error?.type;
  if (typeof upstreamErrorCode === "string" && upstreamErrorCode.trim()) {
    return upstreamErrorCode.trim();
  }
  if (typeof type === "string" && type.trim()) {
    return type.trim();
  }
  if (typeof upstreamStatus === "number") {
    return `HTTP ${upstreamStatus}`;
  }
  return statusCode >= 400 ? `HTTP ${statusCode}` : undefined;
}

function extractTextFromInputContent(content: unknown): string[] {
  if (typeof content === "string" && content.trim()) {
    return [content.trim()];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }

    const record = part as Record<string, unknown>;
    return typeof record.text === "string" && record.text.trim() ? [record.text.trim()] : [];
  });
}

function extractTextInput(input: unknown): string {
  if (typeof input === "undefined") {
    return "";
  }

  if (typeof input === "string") {
    return input;
  }

  const chunks: string[] = [];
  if (!Array.isArray(input)) {
    return "";
  }

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    chunks.push(...extractTextFromInputContent((item as Record<string, unknown>).content));
  }

  return chunks.join("\n").trim();
}

function extractImageUrlFromInputPart(part: unknown): string | null {
  if (!isObjectRecord(part)) {
    return null;
  }

  const imageUrl = part.image_url ?? part.imageUrl;
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    return imageUrl.trim();
  }
  if (isObjectRecord(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url.trim()) {
    return imageUrl.url.trim();
  }

  return null;
}

function extractImageInputs(input: unknown): Array<{ imageUrl: string }> {
  const images: Array<{ imageUrl: string }> = [];
  const addImage = (imageUrl: string | null): void => {
    if (imageUrl && !images.some((item) => item.imageUrl === imageUrl)) {
      images.push({ imageUrl });
    }
  };

  if (!Array.isArray(input)) {
    addImage(extractImageUrlFromInputPart(input));
    return images;
  }

  for (const item of input) {
    addImage(extractImageUrlFromInputPart(item));
    if (!isObjectRecord(item)) {
      continue;
    }
    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        addImage(extractImageUrlFromInputPart(part));
      }
    } else {
      addImage(extractImageUrlFromInputPart(content));
    }
  }

  return images;
}

function isFreePlan(profile: OAuthProfile): boolean {
  return profile.quota?.planType?.toLowerCase() === "free";
}

function normalizeResponseInput(input: unknown): unknown {
  if (typeof input === "undefined") {
    return undefined;
  }

  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
    ];
  }

  return input;
}

function normalizeChatRole(role?: string): string {
  if (role === "developer") {
    return "system";
  }

  return role ?? "user";
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "undefined" || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeChatContentPart(
  part: z.infer<typeof chatCompletionContentPartSchema>,
  textType: "input_text" | "output_text",
): Record<string, unknown> {
  if (part.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (!url) {
      throw new Error("chat.completions 消息里的 image_url 缺少 url。");
    }

    return {
      type: "input_image",
      image_url: url,
    };
  }

  if (part.type === "input_image") {
    return part;
  }

  const text = typeof part.text === "string" ? part.text : "";
  return {
    type: textType,
    text,
  };
}

function normalizeChatContent(
  content: z.infer<typeof chatCompletionMessageSchema>["content"],
  role?: string,
): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }

  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: textType, text: "" }];
  }

  return content.map((part) => normalizeChatContentPart(part, textType));
}

function normalizeChatMessages(
  messages: z.infer<typeof chatCompletionsBodySchema>["messages"],
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const record = message as Record<string, unknown>;

    if (message.role === "tool") {
      normalized.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : safeJsonStringify(message.content),
      });
      continue;
    }

    normalized.push({
      role: normalizeChatRole(message.role),
      content: normalizeChatContent(message.content, message.role),
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    });

    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    for (const toolCall of toolCalls) {
      const call = toolCall && typeof toolCall === "object" ? (toolCall as Record<string, unknown>) : {};
      const fn = call.function && typeof call.function === "object" ? (call.function as Record<string, unknown>) : {};
      const name = typeof fn.name === "string" ? fn.name : undefined;
      if (!name) {
        continue;
      }

      normalized.push({
        type: "function_call",
        call_id: typeof call.id === "string" ? call.id : `call_${normalized.length}`,
        name,
        arguments: safeJsonStringify(fn.arguments),
      });
    }
  }

  return normalized;
}

function normalizeChatTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools) {
    return undefined;
  }

  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") {
      return tool;
    }

    const record = tool as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
    if (record.type !== "function" || !fn) {
      return tool;
    }

    return {
      type: "function",
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    };
  });
}

function normalizeChatToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object") {
    return toolChoice;
  }

  const record = toolChoice as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
  if (record.type === "function" && fn && typeof fn.name === "string") {
    return {
      type: "function",
      name: fn.name,
    };
  }

  return toolChoice;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  if (value === "minimal") {
    return "low";
  }
  if (value === "xhigh") {
    return "high";
  }

  return undefined;
}

function normalizeChatReasoning(data: z.infer<typeof chatCompletionsBodySchema>): Record<string, unknown> | undefined {
  const record = data as Record<string, unknown>;
  const existing = record.reasoning;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }

  const effort = normalizeReasoningEffort(record.reasoning_effort);
  return effort ? { effort } : undefined;
}

function truncateForLog(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function extractChatMessageText(message: z.infer<typeof chatCompletionMessageSchema>): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .map((part) => (typeof part.text === "string" ? part.text : part.image_url ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function countRoles(messages: z.infer<typeof chatCompletionsBodySchema>["messages"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    const role = message.role ?? "user";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

function summarizeRecentMessages(
  messages: z.infer<typeof chatCompletionsBodySchema>["messages"],
): Array<Record<string, unknown>> {
  return messages.slice(-8).map((message) => ({
    role: message.role ?? "user",
    textPreview: truncateForLog(extractChatMessageText(message), 180),
    toolCallId: message.tool_call_id,
  }));
}

function summarizeToolNames(tools: unknown[] | undefined): string[] {
  if (!tools) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return "";
      }
      const record = tool as Record<string, unknown>;
      const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
      return typeof fn?.name === "string"
        ? fn.name
        : typeof record.name === "string"
          ? record.name
          : typeof record.type === "string"
            ? record.type
            : "";
    })
    .filter(Boolean);
}

function summarizeResponsesRequest(
  data: z.infer<typeof responsesBodySchema>,
  endpoint = "/v1/responses",
): Record<string, unknown> {
  const input = data.input;
  const toolNames = summarizeToolNames(Array.isArray(data.tools) ? data.tools : undefined);
  return {
    endpoint,
    model: data.model ?? "default",
    stream: data.stream ?? false,
    inputKind: typeof input === "string" ? "string" : Array.isArray(input) ? "array" : "override",
    inputItems: Array.isArray(input) ? input.length : undefined,
    inputTextPreview: typeof input === "string" ? truncateForLog(input) : "",
    instructionsLength: typeof data.instructions === "string" ? data.instructions.length : undefined,
    toolCount: Array.isArray(data.tools) ? data.tools.length : 0,
    toolNames: toolNames.slice(0, 50),
    toolNamesTruncated: toolNames.length > 50,
    toolChoice: typeof data.tool_choice === "undefined" ? "default" : typeof data.tool_choice,
    parallelToolCalls: data.parallel_tool_calls,
    hasReasoning: Boolean((data as Record<string, unknown>).reasoning),
    hasPreviousResponseId: Boolean(getPreviousResponseId(data)),
  };
}

function getPreviousResponseId(data: z.infer<typeof responsesBodySchema>): string | undefined {
  const direct = (data as Record<string, unknown>).previous_response_id;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const experimental = data.experimental_codex?.body?.previous_response_id;
  return typeof experimental === "string" && experimental.trim() ? experimental.trim() : undefined;
}

function removePreviousResponseId(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.previous_response_id;
  return next;
}

function createResponsesCodexBody(data: z.infer<typeof responsesBodySchema>): Record<string, unknown> {
  const experimentalBody = data.experimental_codex?.body ?? {};
  const body: Record<string, unknown> = {
    ...experimentalBody,
    ...(data as Record<string, unknown>),
  };
  delete body.experimental_codex;

  const normalizedInput = normalizeResponseInput(data.input);
  if (typeof normalizedInput !== "undefined") {
    body.input = normalizedInput;
  }

  return body;
}

function createCodexPassthroughBody(data: z.infer<typeof responsesBodySchema>, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(data as Record<string, unknown>),
    model,
  };
  delete body.experimental_codex;
  return body;
}

function getImageGenerationTool(body: Record<string, unknown>): Record<string, unknown> | null {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (isObjectRecord(tool) && tool.type === "image_generation") {
      return tool;
    }
  }
  return null;
}

function hasImageGenerationToolChoice(body: Record<string, unknown>): boolean {
  const choice = body.tool_choice;
  if (typeof choice === "string") {
    return choice === "image_generation";
  }
  return isObjectRecord(choice) && choice.type === "image_generation";
}

function normalizeImageOutputFormat(value: unknown): CodexImageGenerationRequest["outputFormat"] | undefined {
  return value === "png" || value === "webp" || value === "jpeg" ? value : undefined;
}

function extractCodexImageGenerationRequest(body: Record<string, unknown>): CodexImageGenerationRequest | null {
  const imageTool = getImageGenerationTool(body);
  if (!hasImageGenerationToolChoice(body)) {
    return null;
  }

  return {
    prompt: extractTextInput(body.input),
    inputImages: extractImageInputs(body.input),
    imageModel: typeof imageTool?.model === "string" && imageTool.model.trim() ? imageTool.model.trim() : "gpt-image-2",
    size: typeof imageTool?.size === "string" && imageTool.size.trim() ? imageTool.size.trim() : undefined,
    outputFormat: normalizeImageOutputFormat(imageTool?.output_format),
  };
}

async function writeResponsesSseBlock(reply: FastifyReply, block: string): Promise<number> {
  if (!reply.raw.write(block)) {
    await new Promise((resolve) => reply.raw.once("drain", resolve));
  }
  return Buffer.byteLength(block);
}

async function writeResponsesSseEvent(reply: FastifyReply, eventName: string, payload: Record<string, unknown>): Promise<number> {
  return writeResponsesSseBlock(reply, `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function sendSyntheticCodexImageSse(params: {
  reply: FastifyReply;
  result: ChatGPTWebImageResult;
  model: string;
  prompt: string;
  requestedSize?: string;
  requestedOutputFormat?: "png" | "webp" | "jpeg";
}): Promise<{ bytes: number; imageCount: number }> {
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const outputFormat = params.result.output_format ?? params.requestedOutputFormat ?? "png";
  const size = params.result.size ?? params.requestedSize;
  const output = params.result.data.map((image, index) => ({
    id: `ig_${randomUUID().replace(/-/g, "")}`,
    type: "image_generation_call",
    status: "completed",
    result: image.b64_json,
    revised_prompt: image.revised_prompt ?? params.prompt,
    output_format: outputFormat,
    ...(size ? { size } : {}),
  }));
  let bytes = 0;

  params.reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  params.reply.raw.flushHeaders?.();

  bytes += await writeResponsesSseEvent(params.reply, "response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: created,
      model: params.model,
      status: "in_progress",
      output: [],
    },
  });

  for (let index = 0; index < output.length; index += 1) {
    const item = output[index] as Record<string, unknown>;
    bytes += await writeResponsesSseEvent(params.reply, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item: {
        id: item.id,
        type: item.type,
        status: "in_progress",
      },
    });
    bytes += await writeResponsesSseEvent(params.reply, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  bytes += await writeResponsesSseEvent(params.reply, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: created,
      model: params.model,
      status: "completed",
      output,
      usage: null,
    },
  });
  bytes += await writeResponsesSseBlock(params.reply, "data: [DONE]\n\n");
  params.reply.raw.end();

  return {
    bytes,
    imageCount: output.length,
  };
}

function summarizeChatCompletionsRequest(data: z.infer<typeof chatCompletionsBodySchema>): Record<string, unknown> {
  const lastUserMessage = [...data.messages].reverse().find((message) => (message.role ?? "user") === "user");
  const toolNames = summarizeToolNames(data.tools);
  return {
    endpoint: "/v1/chat/completions",
    model: data.model ?? "default",
    stream: data.stream ?? false,
    messageCount: data.messages.length,
    roleCounts: countRoles(data.messages),
    recentMessages: summarizeRecentMessages(data.messages),
    lastUserTextPreview: lastUserMessage ? truncateForLog(extractChatMessageText(lastUserMessage)) : "",
    toolCount: data.tools?.length ?? 0,
    toolNames: toolNames.slice(0, 50),
    toolNamesTruncated: toolNames.length > 50,
    toolChoice: typeof data.tool_choice === "undefined" ? "default" : typeof data.tool_choice,
    parallelToolCalls: data.parallel_tool_calls,
    hasReasoning: Boolean((data as Record<string, unknown>).reasoning || (data as Record<string, unknown>).reasoning_effort),
    maxTokens: data.max_completion_tokens ?? data.max_tokens,
  };
}

function summarizeCodexChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const toolNames = summarizeToolNames(Array.isArray(body.tools) ? body.tools : undefined);
  return {
    keys: Object.keys(body).sort(),
    model: body.model ?? "default",
    stream: body.stream,
    store: body.store,
    hasPromptCacheKey: typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim().length > 0,
    inputItems: Array.isArray(body.input) ? body.input.length : undefined,
    tools: Array.isArray(body.tools) ? body.tools.length : undefined,
    toolNames: toolNames.slice(0, 50),
    toolNamesTruncated: toolNames.length > 50,
    toolChoice: typeof body.tool_choice === "undefined" ? "default" : typeof body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls,
    hasReasoning: Boolean(body.reasoning),
  };
}

async function buildOpenAIModelsResponse(ctx: ReturnType<typeof createGatewayContext>) {
  return {
    object: "list",
    data: (await ctx.modelService.listModels()).map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.provider,
    })),
  };
}

async function buildCodexModelsResponse(ctx: ReturnType<typeof createGatewayContext>) {
  const [models, catalog] = await Promise.all([
    ctx.modelService.listModels(),
    ctx.modelService.getCatalog(),
  ]);
  return {
    fetched_at: catalog.fetchedAt ?? new Date().toISOString(),
    models: models.map((model, index) => ({
      slug: model.id,
      display_name: model.name,
      description: model.name,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balanced speed and reasoning" },
        { effort: "high", description: "Deeper reasoning" },
        { effort: "xhigh", description: "Extra deep reasoning" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: index,
      input_modalities: model.input,
    })),
  };
}

function profileLogLabel(profile: OAuthProfile | null): string {
  return profile?.email || profile?.accountId || profile?.profileId || "-";
}

function requestSourceFromUserAgent(userAgent: unknown): string {
  if (typeof userAgent !== "string") {
    return "API";
  }

  const normalized = userAgent.toLowerCase();
  if (normalized.includes("codex")) {
    return "Codex";
  }
  if (normalized.includes("openclaw")) {
    return "OpenClaw";
  }
  return "API";
}

function createChatCompletionsCodexBody(
  data: z.infer<typeof chatCompletionsBodySchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    store: false,
    stream: true,
    input: normalizeChatMessages(data.messages),
  };

  if (data.model) {
    body.model = data.model;
  }
  if (typeof data.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = data.parallel_tool_calls;
  }
  if (data.tools) {
    body.tools = normalizeChatTools(data.tools);
  }
  if (typeof data.tool_choice !== "undefined") {
    body.tool_choice = normalizeChatToolChoice(data.tool_choice);
  }
  const reasoning = normalizeChatReasoning(data);
  if (reasoning) {
    body.reasoning = reasoning;
  }
  return body;
}

function summarizeImageRequestForLog(body: z.infer<typeof imageGenerationsBodySchema>): Record<string, unknown> {
  return {
    model: body.model ?? "default",
    promptLength: body.prompt.length,
    size: body.size ?? "default",
    quality: body.quality ?? "default",
    background: body.background ?? "default",
    output_format: body.output_format ?? "default",
    output_compression: typeof body.output_compression === "number" ? body.output_compression : undefined,
    moderation: body.moderation ?? "default",
    response_format: body.response_format ?? "default",
    user: body.user ?? undefined,
  };
}

function getImageEditReferences(data: z.infer<typeof imageEditsBodySchema>): Array<z.infer<typeof imageReferenceSchema>> {
  if (Array.isArray(data.images)) {
    return data.images;
  }

  if (Array.isArray(data.image)) {
    return data.image;
  }

  if (data.image) {
    return [data.image];
  }

  return [];
}

function normalizeJsonImageReference(reference: z.infer<typeof imageReferenceSchema>): { imageUrl?: string; fileId?: string } {
  if (typeof reference === "string") {
    return {
      imageUrl: normalizeJsonImageUrl(reference),
    };
  }

  return {
    imageUrl: reference.image_url ? normalizeJsonImageUrl(reference.image_url) : undefined,
    fileId: reference.file_id,
  };
}

function normalizeJsonImageUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed) && trimmed.length > 80) {
    return `data:image/png;base64,${trimmed}`;
  }

  return trimmed;
}

function summarizeImageEditRequestForLog(body: z.infer<typeof imageEditsBodySchema>): Record<string, unknown> {
  return {
    ...summarizeImageRequestForLog(body),
    imageCount: getImageEditReferences(body).length,
    hasMask: Boolean(body.mask),
  };
}

function ratioFromImageSize(size: string | undefined): string | undefined {
  if (!size) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    return undefined;
  }
  const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function getImageEditReferenceAssets(data: z.infer<typeof imageEditsBodySchema>): Array<{ name?: string; value: string }> {
  return getImageEditReferences(data)
    .map((reference, index) => {
      const normalized = normalizeJsonImageReference(reference);
      const value = normalized.imageUrl ?? normalized.fileId ?? "";
      return value ? { name: `reference-${index + 1}`, value } : null;
    })
    .filter(Boolean) as Array<{ name?: string; value: string }>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message) as Error & { statusCode?: number };
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function withDeferredTimeout<T>(
  factory: (startTimeout: () => void) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const startTimeout = () => {
    if (started) {
      return;
    }
    started = true;
    timer = setTimeout(() => {
      const error = new Error(message) as Error & { statusCode?: number };
      error.statusCode = 504;
      rejectTimeout?.(error);
    }, timeoutMs);
    timer.unref?.();
  };

  return Promise.race([factory(startTimeout), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function buildResponseApiBody(result: ChatResult, includeRaw?: boolean): Record<string, unknown> {
  const usage = buildResponsesUsagePayload(extractTokenUsage(result.raw));
  const responseBody: Record<string, unknown> = {
    object: "response",
    provider: result.provider,
    model: result.model,
    ...(usage ? { usage } : {}),
    output_text: result.text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: result.text,
          },
        ],
      },
    ],
  };

  if (result.artifacts.length > 0) {
    responseBody.artifacts = result.artifacts;
  }

  if (includeRaw) {
    responseBody.raw = result.raw;
  }

  return responseBody;
}

function buildChatCompletionsBody(result: ChatResult): Record<string, unknown> {
  const hasToolCalls = result.toolCalls.length > 0;
  const usage = buildChatCompletionsUsagePayload(extractTokenUsage(result.raw));
  const body: Record<string, unknown> = {
    id: `chatcmpl_${randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    ...(usage ? { usage } : {}),
    choices: [
      {
        index: 0,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: hasToolCalls ? result.text || null : result.text,
          ...(hasToolCalls ? { tool_calls: result.toolCalls } : {}),
        },
      },
    ],
  };

  if (result.artifacts.length > 0) {
    body.artifacts = result.artifacts;
  }

  return body;
}

function writeChatCompletionsSseEvent(reply: FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildChatCompletionChunk(params: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason?: "stop" | "tool_calls";
}): Record<string, unknown> {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };
}

function sendChatCompletionsStream(reply: FastifyReply, result: ChatResult, includeUsage = false): void {
  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  writeChatCompletionsSseEvent(reply, buildChatCompletionChunk({
    id,
    created,
    model: result.model,
    delta: { role: "assistant" },
  }));

  if (result.text) {
    writeChatCompletionsSseEvent(reply, buildChatCompletionChunk({
      id,
      created,
      model: result.model,
      delta: { content: result.text },
    }));
  }

  result.toolCalls.forEach((toolCall, index) => {
    writeChatCompletionsSseEvent(reply, buildChatCompletionChunk({
      id,
      created,
      model: result.model,
      delta: {
        tool_calls: [
          {
            index,
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        ],
      },
    }));
  });

  writeChatCompletionsSseEvent(reply, buildChatCompletionChunk({
    id,
    created,
    model: result.model,
    delta: {},
    finishReason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
  }));
  const usage = includeUsage ? buildChatCompletionsUsagePayload(extractTokenUsage(result.raw)) : undefined;
  if (usage) {
    writeChatCompletionsSseEvent(reply, {
      id,
      object: "chat.completion.chunk",
      created,
      model: result.model,
      choices: [],
      usage,
    });
  }
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

function validateImageRequest(data: z.infer<typeof imageGenerationsBodySchema>): string | null {
  if (data.response_format === "url") {
    return "当前网关仅支持 response_format=b64_json，暂不支持返回托管图片 URL。";
  }

  if (
    data.background === "transparent" &&
    typeof data.output_format === "string" &&
    !["png", "webp"].includes(data.output_format)
  ) {
    return "transparent 背景仅支持 output_format=png 或 webp。";
  }

  if (typeof data.output_compression === "number" && data.output_format === "png") {
    return "output_compression 仅支持 jpeg 或 webp 输出。";
  }

  return null;
}

function validateImageEditRequest(data: z.infer<typeof imageEditsBodySchema>): string | null {
  const generationValidationError = validateImageRequest(data);
  if (generationValidationError) {
    return generationValidationError;
  }

  if (data.mask) {
    return "当前网关的 JSON 版 images.edits 暂不支持 mask；请先使用参考图编辑。";
  }

  const references = getImageEditReferences(data);
  if (references.length === 0) {
    return "images.edits 请求缺少 images 或 image。";
  }

  const normalized = references.map((reference) => normalizeJsonImageReference(reference));
  if (normalized.some((reference) => reference.fileId)) {
    return "当前网关的 JSON 版 images.edits 暂不支持 file_id，请使用 image_url URL 或 base64 data URL。";
  }
  if (normalized.some((reference) => !reference.imageUrl)) {
    return "images.edits 的每个图片引用都需要提供 image_url。";
  }
  if (normalized.some((reference) => reference.imageUrl && !/^https?:\/\//i.test(reference.imageUrl) && !/^data:image\//i.test(reference.imageUrl))) {
    return "images.edits 的 image_url 需要是 http(s) URL、data:image/...;base64,...，或裸 base64 字符串。";
  }

  return null;
}

function maskSecret(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

const CODEX_APPLY_UNSUPPORTED_REASON = "该账号缺少真实 chatgpt_account_id，只能用于网关/API 转发，不能应用到本机 Codex。";

function resolveCodexAccountId(profile: Pick<OAuthProfile, "accountId" | "codexAccountId" | "accountIdSource">): string | undefined {
  return profile.codexAccountId ?? (!profile.accountIdSource ? profile.accountId : undefined);
}

function serializeProfile(profile: OAuthProfile | null): Record<string, unknown> | null {
  if (!profile) {
    return null;
  }

  const codexAccountId = resolveCodexAccountId(profile);
  const codexApplySupported = Boolean(codexAccountId);
  return {
    provider: profile.provider,
    profileId: profile.profileId,
    accountId: profile.accountId,
    codexAccountId,
    accountIdSource: profile.accountIdSource ?? (codexAccountId ? "chatgpt_account_id" : undefined),
    codexApplySupported,
    codexApplyReason: codexApplySupported ? undefined : CODEX_APPLY_UNSUPPORTED_REASON,
    email: profile.email,
    quota: profile.quota,
    authStatus: profile.authStatus,
    exportAudit: profile.exportAudit,
    expiresAt: profile.expires,
    accessTokenPreview: maskSecret(profile.access),
    refreshTokenPreview: profile.refresh ? maskSecret(profile.refresh) : "session-only",
  };
}

function serializeManagedProfile(profile: ProfileSummary): Record<string, unknown> {
  return {
    provider: profile.provider,
    profileId: profile.profileId,
    accountId: profile.accountId,
    codexAccountId: profile.codexAccountId,
    accountIdSource: profile.accountIdSource,
    codexApplySupported: profile.codexApplySupported,
    codexApplyReason: profile.codexApplyReason,
    email: profile.email,
    quota: profile.quota,
    authStatus: profile.authStatus,
    exportAudit: profile.exportAudit,
    expiresAt: profile.expiresAt,
    accessTokenPreview: profile.accessTokenPreview,
    refreshTokenPreview: profile.refreshTokenPreview,
    isActive: profile.isActive,
  };
}

function serializeSettings(settings: GatewaySettings, isAdmin: boolean): GatewaySettings {
  return {
    ...settings,
    wecom: {
      ...settings.wecom,
      secret: isAdmin ? settings.wecom.secret : "",
    },
  };
}

function resolveOrigin(request: FastifyRequest): string {
  const host = request.headers.host;
  if (host) {
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0]?.trim() || request.protocol;
    return `${protocol}://${host}`;
  }

  return "http://127.0.0.1:8787";
}

function sanitizeGatewayUsername(value: string, prefix = ""): string {
  const normalized = value.trim().replace(/[^\w.@:-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}${normalized || "user"}`.slice(0, 80);
}

async function requestWecomJson<T>(url: string): Promise<T> {
  const response = await requestText({
    method: "GET",
    url,
    timeoutMs: 20_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("企业微信接口返回不是有效 JSON。");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("企业微信接口返回格式错误。");
  }
  const record = parsed as Record<string, unknown>;
  const errcode = Number(record.errcode ?? 0);
  if (errcode !== 0) {
    const errmsg = typeof record.errmsg === "string" ? record.errmsg : "unknown error";
    throw new Error(`企业微信接口错误 ${errcode}: ${errmsg}`);
  }
  return parsed as T;
}

async function getWecomAccessToken(params: { corpId: string; secret: string }): Promise<string> {
  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  url.searchParams.set("corpid", params.corpId);
  url.searchParams.set("corpsecret", params.secret);
  const result = await requestWecomJson<{ access_token?: string }>(url.toString());
  if (!result.access_token) {
    throw new Error("企业微信未返回 access_token。");
  }
  return result.access_token;
}

async function getWecomUserId(params: { accessToken: string; code: string }): Promise<string> {
  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo");
  url.searchParams.set("access_token", params.accessToken);
  url.searchParams.set("code", params.code);
  const result = await requestWecomJson<{ UserId?: string; userid?: string; OpenId?: string; openid?: string }>(url.toString());
  const userId = result.UserId || result.userid;
  if (!userId) {
    throw new Error(result.OpenId || result.openid ? "该企业微信账号不是企业成员，无法登录。" : "企业微信未返回成员 UserId。");
  }
  return userId;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.")) {
    return true;
  }
  if (address.startsWith("192.168.")) {
    return true;
  }
  const match = address.match(/^172\.(\d+)\./);
  if (!match) {
    return false;
  }
  const second = Number.parseInt(match[1] ?? "", 10);
  return second >= 16 && second <= 31;
}

function getLanIpv4Addresses(): Array<{ address: string; label: string }> {
  const seen = new Set<string>();
  const addresses: Array<{ address: string; label: string; private: boolean }> = [];
  const interfaces = networkInterfaces();

  for (const [name, details] of Object.entries(interfaces)) {
    for (const detail of details ?? []) {
      const family = String(detail.family);
      const isIpv4 = family === "IPv4" || family === "4";
      if (!isIpv4 || detail.internal || seen.has(detail.address)) {
        continue;
      }
      if (detail.address === "0.0.0.0" || detail.address.startsWith("127.") || detail.address.startsWith("169.254.")) {
        continue;
      }
      seen.add(detail.address);
      addresses.push({
        address: detail.address,
        label: name,
        private: isPrivateIpv4(detail.address),
      });
    }
  }

  return addresses
    .sort((left, right) => Number(right.private) - Number(left.private) || left.address.localeCompare(right.address, "en"))
    .map(({ address, label }) => ({ address, label }));
}

function createShareAddress(protocol: string, host: string, port: number, label: string): GatewayShareAddress {
  const origin = `${protocol}://${host}:${port}`;
  return {
    host,
    label,
    adminUrl: `${origin}/`,
    baseUrl: `${origin}/v1`,
    codexBaseUrl: `${origin}/codex/v1`,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getErrorStatusCode(error: unknown): number {
  const normalized = normalizeError(error) as Error & { statusCode?: number };
  if (typeof normalized.statusCode === "number") {
    return normalized.statusCode;
  }

  const upstreamStatus = (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus;
  if (typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 600) {
    return upstreamStatus;
  }

  const message = normalized.message;
  if (
    message.includes("缺少") ||
    message.includes("格式错误") ||
    message.includes("未内置模型") ||
    message.includes("不支持") ||
    message.includes("没有提供")
  ) {
    return 400;
  }

  if (message.includes("还没有登录")) {
    return 401;
  }

  return 500;
}

function formatBytesAsMiB(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "未知";
  }

  return `${Math.round((bytes / BYTES_PER_MIB) * 10) / 10} MB`;
}

type SseStreamStats = {
  buffer: string;
  bytes: number;
  terminalEvent?: string;
  completed: boolean;
  responseIds: Set<string>;
  tokenUsage: UsageTokenUsage | null;
  parseErrorCount: number;
};

function createSseStreamStats(): SseStreamStats {
  return {
    buffer: "",
    bytes: 0,
    completed: false,
    responseIds: new Set<string>(),
    tokenUsage: null,
    parseErrorCount: 0,
  };
}

function extractSseResponseId(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const directId = value.id;
  if (typeof directId === "string" && directId.startsWith("resp_")) {
    return directId;
  }

  const response = value.response;
  if (isObjectRecord(response) && typeof response.id === "string" && response.id.startsWith("resp_")) {
    return response.id;
  }

  return undefined;
}

function isSseTerminalUsageEvent(eventType: string | undefined): boolean {
  return (
    eventType === "response.completed" ||
    eventType === "response.done" ||
    eventType === "response.failed" ||
    eventType === "response.incomplete"
  );
}

function trackSseChunk(stats: SseStreamStats, chunk: unknown): void {
  const text = typeof chunk === "string"
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString("utf8")
      : String(chunk);
  stats.bytes += Buffer.byteLength(text);
  stats.buffer += text.replace(/\r\n/g, "\n");

  let separatorIndex = stats.buffer.indexOf("\n\n");
  while (separatorIndex !== -1) {
    const block = stats.buffer.slice(0, separatorIndex);
    stats.buffer = stats.buffer.slice(separatorIndex + 2);
    const eventName = block
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");

    let eventType = eventName;
    if (data && data !== "[DONE]") {
      try {
        const parsed = JSON.parse(data) as { type?: unknown };
        if (typeof parsed.type === "string") {
          eventType = parsed.type;
        }
        const responseId = extractSseResponseId(parsed);
        if (responseId) {
          stats.responseIds.add(responseId);
        }
        const tokenUsage = isSseTerminalUsageEvent(eventType) ? extractTokenUsage(parsed) : null;
        if (tokenUsage) {
          stats.tokenUsage = tokenUsage;
        }
      } catch {
        stats.parseErrorCount += 1;
        // The tracker is diagnostic only; malformed chunks still pass through.
      }
    }

    if (eventType === "response.completed" || eventType === "response.done") {
      stats.completed = true;
      stats.terminalEvent = eventType;
    } else if (eventType === "response.failed" || eventType === "response.incomplete") {
      stats.terminalEvent = eventType;
    }

    separatorIndex = stats.buffer.indexOf("\n\n");
  }

  if (stats.buffer.length > 65536) {
    stats.buffer = stats.buffer.slice(-65536);
  }
}

function sseTokenUsageStatus(stats: SseStreamStats, statusCode: number): UsageTokenStatus {
  if (stats.tokenUsage) {
    return "captured";
  }
  if (statusCode < 200 || statusCode >= 400) {
    return "upstream_error";
  }
  if (stats.parseErrorCount > 0 && !stats.terminalEvent) {
    return "parse_failed";
  }
  if (!stats.terminalEvent) {
    return "missing_terminal";
  }
  if (isSseTerminalUsageEvent(stats.terminalEvent)) {
    return "terminal_without_usage";
  }
  return "not_returned";
}

export function createApp(params?: {
  corsOrigin?: true | string | RegExp | Array<string | RegExp>;
  bodyLimit?: number;
  onRestart?: () => void | Promise<void>;
  onRestartCodex?: () => void | Promise<void>;
}) {
  const security = createSecurityConfig();
  const defaultBodyLimit = params?.bodyLimit ?? DEFAULT_ROUTE_BODY_LIMIT_BYTES;
  const codexCompactBodyLimit = Math.max(defaultBodyLimit, CODEX_COMPACT_BODY_LIMIT_BYTES);
  const app = Fastify({
    logger: false,
    bodyLimit: defaultBodyLimit,
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    /^application\/(?:[\w!#$&^.+-]+\+)?json(?:\s*;.*)?$/i,
    { parseAs: "buffer" },
    (request, body, done) => {
      parseJsonRequestBody(request, Buffer.isBuffer(body) ? body : Buffer.from(body))
        .then((parsed) => done(null, parsed))
        .catch((error) => done(error as Error));
    },
  );
  const ctx = createGatewayContext();
  const gatewayRequestLogs: GatewayRequestLog[] = [];
  const codexResponseProfileBindings = new Map<string, { profileId: string; accountId: string; seenAt: number }>();
  let pendingOAuthLogin: { id: string; session: OpenAICodexRemoteLoginSession; createdAt: number } | null = null;
  let bootstrapReady: Promise<void> | null = null;
  const pendingWecomEmbedStates = new Map<string, number>();
  const pendingWecomOAuthStates = new Map<string, number>();
  const pendingWecomCompleteTokens = new Map<string, { username: string; role: GatewayUserRole; expiresAt: number }>();

  function ensureSecurityConfigured(): boolean {
    return Boolean(security.adminUser && security.adminPasswordHash && security.sessionSecret !== "change-me");
  }

  function ensureBootstrapUsers(): Promise<void> {
    if (!bootstrapReady) {
      bootstrapReady = (async () => {
        await ctx.gatewayDatabaseService.init();
        if (security.adminUser && security.adminPasswordHash) {
          await ctx.gatewayDatabaseService.ensureBootstrapAdmin(security.adminUser, security.adminPasswordHash);
        }
      })();
    }
    return bootstrapReady;
  }

  async function getSessionFromRequest(request: FastifyRequest): Promise<AdminSession | null> {
    const tokenSession = getAdminSessionFromRequest(security, request);
    if (!tokenSession) {
      return null;
    }
    await ensureBootstrapUsers();
    const user = await ctx.gatewayDatabaseService.getUserByUsername(tokenSession.user);
    if (!user || user.disabled) {
      return null;
    }
    return {
      user: user.username,
      role: user.role,
      expiresAt: tokenSession.expiresAt,
    };
  }

  async function getRequestOwner(request: FastifyRequest): Promise<string | undefined> {
    return requestOwnerFromSession(await getSessionFromRequest(request));
  }

  function resolveDataOwnerFilter(session: AdminSession | null, requestedOwner?: string): string | undefined {
    const currentOwner = requestOwnerFromSession(session);
    if (!isAdminSession(session)) {
      return currentOwner;
    }
    if (requestedOwner === "all") {
      return undefined;
    }
    return requestedOwner?.trim() || currentOwner;
  }

  function resolveImageLimits(settings: GatewaySettings, owner: string): {
    perUserDaily: number;
    perUserHourly: number;
    minIntervalSeconds: number;
    hasActiveOverride: boolean;
  } {
    const limits = settings.image.limits;
    const override = limits.userOverrides.find((item) => item.username === owner);
    const hasActiveOverride = Boolean(
      override &&
      ((override.perUserDaily ?? 0) > 0 || (override.perUserHourly ?? 0) > 0 || (override.minIntervalSeconds ?? 0) > 0),
    );
    const inheritedDaily = limits.enabled ? limits.perUserDaily : 0;
    const inheritedHourly = limits.enabled ? limits.perUserHourly : 0;
    const inheritedMinIntervalSeconds = limits.enabled ? limits.minIntervalSeconds : 0;
    return {
      perUserDaily: override?.perUserDaily ?? inheritedDaily,
      perUserHourly: override?.perUserHourly ?? inheritedHourly,
      minIntervalSeconds: override?.minIntervalSeconds ?? inheritedMinIntervalSeconds,
      hasActiveOverride,
    };
  }

  async function checkImageGenerationLimit(owner: string | undefined, settings: GatewaySettings): Promise<ImageLimitCheckResult> {
    const limits = settings.image.limits;
    if (!owner) {
      return { allowed: true };
    }

    const effective = resolveImageLimits(settings, owner);
    if (!limits.enabled && !effective.hasActiveOverride) {
      return { allowed: true };
    }

    const now = Date.now();
    const dayStart = now - 24 * 60 * 60 * 1000;
    const hourStart = now - 60 * 60 * 1000;
    const intervalStart = now - Math.max(effective.minIntervalSeconds, 1) * 1000;
    const emptyUsage = { sinceCount: 0, lastCreatedAt: undefined };
    const [dailyUsage, hourlyUsage, intervalUsage] = await Promise.all([
      effective.perUserDaily > 0 ? ctx.gatewayDatabaseService.getGenerationLimitUsage(owner, dayStart) : Promise.resolve(emptyUsage),
      effective.perUserHourly > 0 ? ctx.gatewayDatabaseService.getGenerationLimitUsage(owner, hourStart) : Promise.resolve(emptyUsage),
      effective.minIntervalSeconds > 0 ? ctx.gatewayDatabaseService.getGenerationLimitUsage(owner, intervalStart) : Promise.resolve(emptyUsage),
    ]);
    const lastCreatedAt = intervalUsage.lastCreatedAt ?? hourlyUsage.lastCreatedAt ?? dailyUsage.lastCreatedAt;
    const usage = {
      owner,
      dailyCount: dailyUsage.sinceCount,
      hourlyCount: hourlyUsage.sinceCount,
      perUserDaily: effective.perUserDaily,
      perUserHourly: effective.perUserHourly,
      minIntervalSeconds: effective.minIntervalSeconds,
      lastCreatedAt,
    };

    if (effective.perUserDaily > 0 && dailyUsage.sinceCount >= effective.perUserDaily) {
      return {
        allowed: false,
        reason: "daily",
        message: `今日生图额度已用完（${dailyUsage.sinceCount}/${effective.perUserDaily}），请稍后再试。`,
        retryAfterSeconds: 60 * 60,
        usage,
      };
    }

    if (effective.perUserHourly > 0 && hourlyUsage.sinceCount >= effective.perUserHourly) {
      return {
        allowed: false,
        reason: "hourly",
        message: `近 1 小时生图次数已达上限（${hourlyUsage.sinceCount}/${effective.perUserHourly}），请稍后再试。`,
        retryAfterSeconds: 5 * 60,
        usage,
      };
    }

    if (effective.minIntervalSeconds > 0 && lastCreatedAt) {
      const elapsedSeconds = Math.floor((now - lastCreatedAt) / 1000);
      const retryAfterSeconds = Math.max(1, effective.minIntervalSeconds - elapsedSeconds);
      if (retryAfterSeconds > 0) {
        return {
          allowed: false,
          reason: "interval",
          message: `生图请求过于频繁，请 ${retryAfterSeconds} 秒后再试。`,
          retryAfterSeconds,
          usage,
        };
      }
    }

    return {
      allowed: true,
      usage,
    };
  }

  function sendImageLimitResponse(
    reply: FastifyReply,
    limit: ImageLimitCheckResult,
    params: {
      owner?: string;
      method: string;
      endpoint: string;
      model: string;
      startedAt: number;
      source: string;
      requestId: string;
      remoteAddress: string;
      userAgent?: string;
      requestSummary: Record<string, unknown>;
    },
  ): { error: { type: string; message: string; code: string; details?: ImageLimitCheckResult["usage"] } } {
    const retryAfterSeconds = limit.retryAfterSeconds ?? 60;
    reply.code(429);
    reply.header("Retry-After", String(retryAfterSeconds));
    pushGatewayRequestLog({
      owner: params.owner,
      method: params.method,
      endpoint: params.endpoint,
      account: "-",
      model: params.model,
      statusCode: 429,
      durationMs: performance.now() - params.startedAt,
      source: params.source,
      details: {
        requestId: params.requestId,
        remoteAddress: params.remoteAddress,
        userAgent: params.userAgent,
        request: params.requestSummary,
        error: {
          type: "image_limit_exceeded",
          code: limit.reason,
          message: limit.message,
          retryAfterSeconds,
          usage: limit.usage,
        },
      },
    });
    return {
      error: {
        type: "rate_limit_exceeded",
        code: "image_limit_exceeded",
        message: limit.message ?? "生图限额已达上限，请稍后再试。",
        details: limit.usage,
      },
    };
  }

  function cleanupPendingWecomEmbedStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of pendingWecomEmbedStates) {
      if (expiresAt <= now) {
        pendingWecomEmbedStates.delete(state);
      }
    }
    for (const [state, expiresAt] of pendingWecomOAuthStates) {
      if (expiresAt <= now) {
        pendingWecomOAuthStates.delete(state);
      }
    }
    for (const [token, value] of pendingWecomCompleteTokens) {
      if (value.expiresAt <= now) {
        pendingWecomCompleteTokens.delete(token);
      }
    }
  }

  function rememberWecomEmbedState(state: string): void {
    cleanupPendingWecomEmbedStates();
    pendingWecomEmbedStates.set(state, Date.now() + WECOM_EMBED_LOGIN_STATE_TTL_MS);
  }

  function consumeWecomEmbedState(state: string): boolean {
    cleanupPendingWecomEmbedStates();
    const expiresAt = pendingWecomEmbedStates.get(state);
    if (!expiresAt || expiresAt <= Date.now()) {
      pendingWecomEmbedStates.delete(state);
      return false;
    }
    pendingWecomEmbedStates.delete(state);
    return true;
  }

  function rememberWecomOAuthState(state: string): void {
    cleanupPendingWecomEmbedStates();
    pendingWecomOAuthStates.set(state, Date.now() + WECOM_LOGIN_STATE_TTL_MS);
  }

  function consumeWecomOAuthState(state: string): boolean {
    cleanupPendingWecomEmbedStates();
    const expiresAt = pendingWecomOAuthStates.get(state);
    if (!expiresAt || expiresAt <= Date.now()) {
      pendingWecomOAuthStates.delete(state);
      return false;
    }
    pendingWecomOAuthStates.delete(state);
    return true;
  }

  function rememberWecomCompleteToken(username: string, role: GatewayUserRole): string {
    cleanupPendingWecomEmbedStates();
    const token = randomBytes(24).toString("base64url");
    pendingWecomCompleteTokens.set(token, {
      username,
      role,
      expiresAt: Date.now() + WECOM_EMBED_COMPLETE_TTL_MS,
    });
    return token;
  }

  function consumeWecomCompleteToken(token: string): { username: string; role: GatewayUserRole } | null {
    cleanupPendingWecomEmbedStates();
    const value = pendingWecomCompleteTokens.get(token);
    if (!value || value.expiresAt <= Date.now()) {
      pendingWecomCompleteTokens.delete(token);
      return null;
    }
    pendingWecomCompleteTokens.delete(token);
    return {
      username: value.username,
      role: value.role,
    };
  }

  async function buildWecomLoginUrl(request: FastifyRequest, embed = false): Promise<{ authUrl: string; state: string }> {
    if (!ensureSecurityConfigured()) {
      const error = new Error("Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    await ensureBootstrapUsers();
    const settings = await ctx.configService.getSettings();
    if (!settings.wecom.enabled || !settings.wecom.corpId || !settings.wecom.agentId || !settings.wecom.secret) {
      const error = new Error("企业微信扫码登录未配置或未启用。") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const state = randomBytes(18).toString("base64url");
    if (embed) {
      rememberWecomEmbedState(state);
    }
    const redirectUrl = new URL(`${resolveOrigin(request)}/_gateway/auth/wecom/callback`);
    if (embed) {
      redirectUrl.searchParams.set("embed", "1");
    }
    const authUrl = new URL("https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
    authUrl.searchParams.set("appid", settings.wecom.corpId);
    authUrl.searchParams.set("agentid", settings.wecom.agentId);
    authUrl.searchParams.set("redirect_uri", redirectUrl.toString());
    authUrl.searchParams.set("state", state);

    return {
      authUrl: authUrl.toString(),
      state,
    };
  }

  async function buildWecomOAuthUrl(request: FastifyRequest): Promise<{ authUrl: string; state: string }> {
    if (!ensureSecurityConfigured()) {
      const error = new Error("Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    await ensureBootstrapUsers();
    const settings = await ctx.configService.getSettings();
    if (!settings.wecom.enabled || !settings.wecom.corpId || !settings.wecom.agentId || !settings.wecom.secret) {
      const error = new Error("企业微信 OAuth 登录未配置或未启用。") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const state = randomBytes(18).toString("base64url");
    rememberWecomOAuthState(state);
    const redirectUrl = new URL(`${resolveOrigin(request)}/_gateway/auth/wecom/callback`);
    redirectUrl.searchParams.set("channel", "oauth");

    const authUrl = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    authUrl.searchParams.set("appid", settings.wecom.corpId);
    authUrl.searchParams.set("redirect_uri", redirectUrl.toString());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "snsapi_base");
    authUrl.searchParams.set("state", state);
    return {
      authUrl: `${authUrl.toString()}#wechat_redirect`,
      state,
    };
  }

  async function loginWecomCode(code: string): Promise<{ username: string; role: GatewayUserRole }> {
    const settings = await ctx.configService.getSettings();
    if (!settings.wecom.enabled || !settings.wecom.corpId || !settings.wecom.agentId || !settings.wecom.secret) {
      const error = new Error("企业微信扫码登录未配置或未启用。") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const accessToken = await getWecomAccessToken({
      corpId: settings.wecom.corpId,
      secret: settings.wecom.secret,
    });
    const userId = await getWecomUserId({
      accessToken,
      code,
    });
    const username = sanitizeGatewayUsername(userId, "wxwork:");
    let user = await ctx.gatewayDatabaseService.getUserByUsername(username);
    if (!user) {
      const randomPasswordHash = hashSecret(`wecom:${userId}:${randomUUID()}:${Date.now()}`);
      await ctx.gatewayDatabaseService.createUser({
        username,
        passwordHash: randomPasswordHash,
        role: "user",
      });
      user = await ctx.gatewayDatabaseService.getUserByUsername(username);
    }
    if (!user || user.disabled) {
      const error = new Error("当前企业微信用户已被禁用或无法创建。") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    return {
      username: user.username,
      role: user.role,
    };
  }

  function clearPendingOAuthLogin(loginId?: string): void {
    if (!pendingOAuthLogin || (loginId && pendingOAuthLogin.id !== loginId)) {
      return;
    }

    pendingOAuthLogin = null;
  }

  async function saveCompletedOAuthLogin(profile: OAuthProfile): Promise<void> {
    await ctx.authService.saveLoggedInProfile(profile);
    await ctx.authService.syncActiveProfileQuota("openai-codex", {
      suppressErrors: true,
    });
  }

  function rememberCodexResponseProfile(responseId: string, profile: OAuthProfile): void {
    codexResponseProfileBindings.set(responseId, {
      profileId: profile.profileId,
      accountId: profile.accountId,
      seenAt: Date.now(),
    });

    if (codexResponseProfileBindings.size <= MAX_CODEX_RESPONSE_PROFILE_BINDINGS) {
      return;
    }

    const overflow = codexResponseProfileBindings.size - MAX_CODEX_RESPONSE_PROFILE_BINDINGS;
    const oldest = Array.from(codexResponseProfileBindings.entries())
      .sort((left, right) => left[1].seenAt - right[1].seenAt)
      .slice(0, overflow);
    for (const [key] of oldest) {
      codexResponseProfileBindings.delete(key);
    }
  }

  function pushGatewayRequestLog(log: Omit<GatewayRequestLog, "id" | "time"> & { id?: string; time?: number; usage?: GatewayRequestUsageMeta }): void {
    const entry: GatewayRequestLog = {
      id: log.id ?? randomUUID(),
      owner: log.owner,
      time: log.time ?? Date.now(),
      method: log.method,
      endpoint: log.endpoint,
      account: log.account,
      model: log.model,
      statusCode: log.statusCode,
      durationMs: log.durationMs,
      source: log.source,
      details: log.details,
    };
    const existingIndex = gatewayRequestLogs.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) {
      gatewayRequestLogs.splice(existingIndex, 1, entry);
    } else {
      gatewayRequestLogs.unshift(entry);
    }
    if (gatewayRequestLogs.length > MAX_GATEWAY_REQUEST_LOGS) {
      gatewayRequestLogs.length = MAX_GATEWAY_REQUEST_LOGS;
    }
    ctx.gatewayDatabaseService.saveRequestLog(entry).catch((error) => {
      console.warn("[gateway:request-log] failed to persist request log", {
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (entry.statusCode === 102) {
      return;
    }

    const profile = log.usage?.profile ?? undefined;
    const usageEvent: UsageRecordEvent = {
      id: entry.id,
      timestamp: entry.time,
      method: entry.method,
      endpoint: entry.endpoint,
      model: entry.model,
      source: entry.source,
      statusCode: entry.statusCode,
      durationMs: entry.durationMs,
      success: entry.statusCode >= 200 && entry.statusCode < 400,
      profileId: profile?.profileId,
      accountId: profile?.accountId,
      accountLabel: entry.account,
      planType: profile?.quota?.planType,
      tokenUsage: log.usage?.tokenUsage,
      tokenUsageStatus: log.usage?.tokenUsageStatus,
      imageCount: log.usage?.imageCount,
      imageRoute: log.usage?.imageRoute ?? "none",
      errorType: log.usage?.errorType ?? extractUsageErrorType(log.details, entry.statusCode),
    };
    ctx.usageService.record(usageEvent).catch((error) => {
      console.warn("[gateway:usage] 统计写入失败", error);
    });
  }

  void app.register(cors, {
    origin: params?.corsOrigin ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (isPublicPath(request.method, request.url)) {
      return;
    }

    if (!ensureSecurityConfigured()) {
      reply.code(403);
      return reply.send({
        error: {
          type: "forbidden",
          message: "Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.",
        },
      });
    }
    await ensureBootstrapUsers();
    const session = await getSessionFromRequest(request);

    if (isApiPath(request.url)) {
      const pathOnly = request.url.split("?")[0] ?? "/";
      if (
        isAdminSession(session) ||
        (session && (
          pathOnly === "/v1/images/generations" ||
          pathOnly === "/v1/images/edits" ||
          pathOnly === "/v1/chat/completions"
        ))
      ) {
        return;
      }

      if (!security.apiKeyHash) {
        reply.code(403);
        return reply.send({
          error: {
            type: "forbidden",
            message: "API access is disabled. Set AZT_API_KEY to enable OpenAI-compatible endpoints.",
          },
        });
      }

      if (!secureEqualHash(security.apiKeyHash, getBearerToken(request))) {
        reply.code(401);
        reply.header("WWW-Authenticate", "Bearer");
        return reply.send({
          error: {
            type: "unauthorized",
            message: "Missing or invalid API key.",
          },
        });
      }
      return;
    }

    if (isAdminPath(request.url)) {
      if (!session) {
        reply.code(401);
        return reply.send({
          error: {
            type: "unauthorized",
            message: "Login required.",
          },
        });
      }
      if (!isAdminSession(session) && !isUserGatewayPath(request.method, request.url)) {
        reply.code(403);
        return reply.send({
          error: {
            type: "forbidden",
            message: "当前用户没有权限访问该功能。",
          },
        });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    const statusCode = getErrorStatusCode(normalized);
    const isBodyTooLarge = statusCode === 413;
    const message = isBodyTooLarge
      ? `请求体过大，当前网关默认上限 ${formatBytesAsMiB(defaultBodyLimit)}，Codex compact 上限 ${formatBytesAsMiB(codexCompactBodyLimit)}。如仍不够，请用 AZT_BODY_LIMIT_MB 调大后重启网关。`
      : normalized.message;
    console.error("[gateway:error]", {
      method: request.method,
      url: request.url,
      statusCode,
      message,
      code: (normalized as Error & { code?: unknown }).code,
      upstreamRequestId: (normalized as Error & { requestId?: unknown }).requestId,
      stack: normalized.stack,
    });
    reply.code(statusCode);
    return {
      error: {
        type: "gateway_error",
        message,
      },
    };
  });

  app.get("/_gateway/admin/request-logs", async (request) => {
    const parsed = requestLogsQuerySchema.safeParse(request.query);
    const limit = parsed.success ? parsed.data.limit ?? MAX_PERSISTED_REQUEST_LOGS : MAX_PERSISTED_REQUEST_LOGS;
    const session = await getSessionFromRequest(request);
    const owner = resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    const persisted = await ctx.gatewayDatabaseService.listRequestLogs(limit, owner);
    return {
      data: persisted.length > 0
        ? persisted
        : gatewayRequestLogs.filter((item) => !owner || item.owner === owner).slice(0, limit),
    };
  });

  app.get("/_gateway/admin/usage", async () => ctx.usageService.getSummary());

  app.post("/_gateway/admin/usage/reset", async () => ctx.usageService.backupAndReset());

  app.get("/_gateway/generations/history", async (request) => {
    const parsed = generationHistoryQuerySchema.safeParse(request.query);
    const limit = parsed.success ? parsed.data.limit ?? 100 : 100;
    const session = await getSessionFromRequest(request);
    const owner = resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    return {
      items: await ctx.gatewayDatabaseService.listGenerationHistory(limit, owner),
    };
  });

  app.delete("/_gateway/generations/history", async (request) => {
    const parsed = generationHistoryQuerySchema.safeParse(request.query);
    const session = await getSessionFromRequest(request);
    const owner = resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    await ctx.gatewayDatabaseService.clearGenerationHistory(owner);
    return { items: [] };
  });

  app.get("/_gateway/generations/images/*", async (request, reply) => {
    const session = await getSessionFromRequest(request);
    const wildcard = (request.params as { "*": string })["*"] ?? "";
    const normalized = path.normalize(wildcard).replace(/^(\.\.(\/|\\|$))+/, "");
    const root = getGenerationAssetsDir();
    const filePath = path.resolve(root, normalized);
    const rootPath = path.resolve(root);
    if (!filePath.startsWith(`${rootPath}${path.sep}`)) {
      reply.code(403);
      return { error: { type: "forbidden", message: "禁止访问该文件。" } };
    }
    const generationId = normalized.split(path.sep)[0] || normalized.split("/")[0];
    if (!isAdminSession(session) && generationId) {
      const owner = await ctx.gatewayDatabaseService.getGenerationOwner(generationId);
      if (!owner || owner !== requestOwnerFromSession(session)) {
        reply.code(403);
        return { error: { type: "forbidden", message: "禁止访问该图片。" } };
      }
    }
    try {
      const data = await fs.readFile(filePath);
      reply.header("Content-Type", getContentType(filePath));
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(data);
    } catch {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
  });

  async function buildAdminConfig(request: FastifyRequest) {
    const session = await getSessionFromRequest(request);
    const isAdmin = isAdminSession(session);
    const [status, models, modelCatalog, versionStatus, settings, profile, profiles, codexStatus, usage] = await Promise.all([
      ctx.authService.getStatus(),
      ctx.modelService.listModels(),
      ctx.modelService.getCatalog(),
      ctx.versionService.getVersionStatus(),
      ctx.configService.getSettings(),
      ctx.authService.getActiveProfile(),
      ctx.authService.listProfiles(),
      ctx.authService.getCodexStatus(),
      ctx.usageService.getSummary(),
    ]);
    const origin = resolveOrigin(request);

    return {
      auth: session ? { user: session.user, role: session.role } : null,
      status,
      settings: serializeSettings(settings, isAdmin),
      models,
      modelCatalog,
      versionStatus: isAdmin ? versionStatus : { ...versionStatus, latestVersion: undefined },
      profile: serializeProfile(profile),
      profiles: isAdmin ? profiles.map((item) => serializeManagedProfile(item)) : [],
      codex: isAdmin
        ? codexStatus
        : {
            exists: false,
            path: "",
            gatewayProvider: {
              path: "",
              providerId: "openai",
              exists: false,
              active: false,
            },
          },
      usage: isAdmin ? usage : undefined,
      adminUrl: `${origin}/`,
      baseUrl: `${origin}/v1`,
      codexBaseUrl: `${origin}/codex/v1`,
      restartSupported: isAdmin && Boolean(params?.onRestart),
      codexRestartSupported: isAdmin && Boolean(params?.onRestartCodex),
      supportedEndpoints: [
        {
          method: "GET",
          path: "/v1/models",
          description: "OpenAI models 列表兼容接口。",
        },
        {
          method: "POST",
          path: "/v1/responses",
          description: "OpenAI responses 兼容接口。",
        },
        {
          method: "POST",
          path: "/codex/v1/responses",
          description: "Codex custom provider 专用 Responses SSE 透传接口。",
        },
        {
          method: "POST",
          path: "/codex/v1/responses/compact",
          description: "Codex custom provider 专用 Responses compact SSE 透传接口。",
        },
        {
          method: "POST",
          path: "/v1/chat/completions",
          description: "OpenAI chat.completions 兼容接口。",
        },
        {
          method: "POST",
          path: "/v1/images/generations",
          description: "OpenAI images.generations 兼容接口。",
        },
        {
          method: "POST",
          path: "/v1/images/edits",
          description: "OpenAI images.edits JSON 兼容接口。",
        },
      ],
    };
  }

  app.get("/", async (request, reply) => {
    const query = request.query as { skip_auto_wecom?: string } | undefined;
    if (query?.skip_auto_wecom !== "1" && isWecomUserAgent(request.headers["user-agent"])) {
      const session = ensureSecurityConfigured() ? await getSessionFromRequest(request) : null;
      if (!session) {
        try {
          const login = await buildWecomOAuthUrl(request);
          reply.header("Set-Cookie", buildWecomStateCookie(login.state));
          return reply.redirect(login.authUrl);
        } catch {
          // Fall back to the normal login page when OAuth is unavailable.
        }
      }
    }

    try {
      reply.header("Content-Type", "text/html; charset=utf-8");
      return fs.readFile(adminUiIndexPath, "utf8");
    } catch {
      reply.code(503);
      return {
        error: {
          type: "admin_ui_missing",
          message: "React 管理页未构建，请先运行 npm run build:ui。",
        },
      };
    }
  });

  app.get("/assets/*", async (request, reply) => {
    const assetPath = (request.params as { "*": string })["*"];
    const asset = await readAdminUiAsset(path.join("assets", assetPath));
    if (!asset) {
      reply.code(404);
      return {
        error: {
          type: "not_found",
          message: "asset not found",
        },
      };
    }

    reply.header("Content-Type", getContentType(asset.filePath));
    return asset.body;
  });

  app.get("/:rootAsset", async (request, reply) => {
    const rootAsset = (request.params as { rootAsset: string }).rootAsset;
    if (!rootAsset.includes(".") || rootAsset.includes("/") || rootAsset.includes("\\")) {
      reply.code(404);
      return {
        error: {
          type: "not_found",
          message: "asset not found",
        },
      };
    }

    const asset = await readAdminUiAsset(rootAsset);
    if (!asset) {
      reply.code(404);
      return {
        error: {
          type: "not_found",
          message: "asset not found",
        },
      };
    }

    reply.header("Content-Type", getContentType(asset.filePath));
    return asset.body;
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.code(204);
    return "";
  });

  app.get("/_gateway/health", async () => ({ ok: true }));

  app.get("/_gateway/auth/status", async (request) => {
    const configured = ensureSecurityConfigured();
    if (configured) {
      await ensureBootstrapUsers();
    }
    const session = configured ? await getSessionFromRequest(request) : null;
    const settings = configured ? await ctx.configService.getSettings() : null;
    return {
      configured,
      authenticated: Boolean(session),
      user: session?.user ?? null,
      role: session?.role ?? null,
      wecomLoginEnabled: Boolean(settings?.wecom.enabled && settings.wecom.corpId && settings.wecom.agentId && settings.wecom.secret),
    };
  });

  app.post("/_gateway/auth/login", async (request, reply) => {
    if (!ensureSecurityConfigured()) {
      reply.code(403);
      return {
        error: {
          type: "forbidden",
          message: "Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.",
        },
      };
    }
    await ensureBootstrapUsers();

    const parsed = adminLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const user = await ctx.gatewayDatabaseService.getUserByUsername(parsed.data.username);
    if (!user || user.disabled || !secureEqualHash(user.passwordHash, parsed.data.password)) {
      reply.code(401);
      return {
        error: {
          type: "unauthorized",
          message: "用户名或密码错误。",
        },
      };
    }

    reply.header("Set-Cookie", buildSessionCookie(createAdminSessionToken(security, user.username, user.role)));
    return {
      ok: true,
      user: user.username,
      role: user.role,
    };
  });

  app.get("/_gateway/auth/wecom/start", async (request, reply) => {
    try {
      const login = await buildWecomLoginUrl(request);
      reply.header("Set-Cookie", buildWecomStateCookie(login.state));
      return reply.redirect(login.authUrl);
    } catch (error) {
      reply.code((error as { statusCode?: number }).statusCode ?? 500);
      return {
        error: {
          type: (error as { statusCode?: number }).statusCode === 403 ? "forbidden" : "wecom_login_error",
          message: error instanceof Error ? error.message : "企业微信登录初始化失败。",
        },
      };
    }
  });

  app.get("/_gateway/auth/wecom/url", async (request, reply) => {
    try {
      const login = await buildWecomLoginUrl(request, true);
      reply.header("Set-Cookie", buildWecomStateCookie(login.state));
      return {
        authUrl: login.authUrl,
      };
    } catch (error) {
      reply.code((error as { statusCode?: number }).statusCode ?? 500);
      return {
        error: {
          type: (error as { statusCode?: number }).statusCode === 403 ? "forbidden" : "wecom_login_error",
          message: error instanceof Error ? error.message : "企业微信登录初始化失败。",
        },
      };
    }
  });

  app.get("/_gateway/auth/wecom/panel-config", async (request, reply) => {
    if (!ensureSecurityConfigured()) {
      reply.code(403);
      return {
        error: {
          type: "forbidden",
          message: "Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.",
        },
      };
    }
    await ensureBootstrapUsers();
    const settings = await ctx.configService.getSettings();
    if (!settings.wecom.enabled || !settings.wecom.corpId || !settings.wecom.agentId || !settings.wecom.secret) {
      reply.code(400);
      return {
        error: {
          type: "wecom_not_configured",
          message: "企业微信网页快捷登录未配置或未启用。",
        },
      };
    }

    const state = randomBytes(18).toString("base64url");
    rememberWecomOAuthState(state);
    reply.header("Set-Cookie", buildWecomStateCookie(state));
    return {
      appid: settings.wecom.corpId,
      agentid: settings.wecom.agentId,
      redirectUri: `${resolveOrigin(request)}/_gateway/auth/wecom/callback?channel=oauth`,
      state,
    };
  });

  app.post("/_gateway/auth/wecom/panel-login", async (request, reply) => {
    if (!ensureSecurityConfigured()) {
      reply.code(403);
      return {
        error: {
          type: "forbidden",
          message: "Admin access is disabled. Set AZT_ADMIN_USER, AZT_ADMIN_PASSWORD and AZT_SESSION_SECRET.",
        },
      };
    }
    await ensureBootstrapUsers();
    const parsed = wecomPanelLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    try {
      const user = await loginWecomCode(parsed.data.code);
      reply.header("Set-Cookie", [
        buildSessionCookie(createAdminSessionToken(security, user.username, user.role)),
        buildExpiredWecomStateCookie(),
      ]);
      return {
        ok: true,
        user: user.username,
        role: user.role,
      };
    } catch (error) {
      reply.code((error as { statusCode?: number }).statusCode ?? 502);
      return {
        error: {
          type: "wecom_login_error",
          message: error instanceof Error ? error.message : "企业微信登录失败。",
        },
      };
    }
  });

  app.get("/_gateway/auth/wecom/oauth/start", async (request, reply) => {
    try {
      const login = await buildWecomOAuthUrl(request);
      reply.header("Set-Cookie", buildWecomStateCookie(login.state));
      return reply.redirect(login.authUrl);
    } catch (error) {
      reply.code((error as { statusCode?: number }).statusCode ?? 500);
      return error instanceof Error ? error.message : "企业微信 OAuth 登录初始化失败。";
    }
  });

  app.get("/_gateway/auth/wecom/complete", async (request, reply) => {
    const parsed = wecomCompleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return "企业微信登录完成参数错误。";
    }
    const complete = consumeWecomCompleteToken(parsed.data.token);
    if (!complete) {
      reply.code(400);
      return "企业微信登录完成凭证已失效，请返回登录页重试。";
    }
    reply.header("Set-Cookie", [
      buildSessionCookie(createAdminSessionToken(security, complete.username, complete.role)),
      buildExpiredWecomStateCookie(),
    ]);
    return reply.redirect("/");
  });

  app.get("/_gateway/auth/wecom/callback", async (request, reply) => {
    if (!ensureSecurityConfigured()) {
      reply.code(403);
      return "Admin access is disabled.";
    }
    await ensureBootstrapUsers();
    const parsed = wecomCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return "企业微信回调参数错误。";
    }
    const cookies = parseCookies(request.headers.cookie);
    const channel: WecomLoginChannel = parsed.data.channel === "oauth" ? "oauth" : "qr";
    const validCookieState = cookies[WECOM_LOGIN_STATE_COOKIE] && cookies[WECOM_LOGIN_STATE_COOKIE] === parsed.data.state;
    const validEmbedState = parsed.data.embed ? consumeWecomEmbedState(parsed.data.state) : false;
    const validOAuthState = channel === "oauth" ? consumeWecomOAuthState(parsed.data.state) : false;
    if (!validCookieState && !validEmbedState && !validOAuthState) {
      reply.code(400);
      return "企业微信登录状态已失效，请返回登录页重试。";
    }

    try {
      const user = await loginWecomCode(parsed.data.code);
      if (parsed.data.embed) {
        const token = rememberWecomCompleteToken(user.username, user.role);
        const completeUrl = `/_gateway/auth/wecom/complete?token=${encodeURIComponent(token)}`;
        reply.header("Content-Type", "text/html; charset=utf-8");
        return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>企业微信登录成功</title>
</head>
<body>
  <script>
    var completeUrl = ${JSON.stringify(completeUrl)};
    window.parent && window.parent.postMessage({ type: "azt-wecom-login-success", completeUrl: completeUrl }, window.location.origin);
    window.setTimeout(function () {
      window.top.location.href = completeUrl;
    }, 300);
  </script>
  <p>企业微信登录成功，正在进入管理台。</p>
</body>
</html>`;
      }
      reply.header("Set-Cookie", [
        buildSessionCookie(createAdminSessionToken(security, user.username, user.role)),
        buildExpiredWecomStateCookie(),
      ]);
      return reply.redirect("/");
    } catch (error) {
      reply.code(502);
      return error instanceof Error ? error.message : "企业微信登录失败。";
    }
  });

  app.post("/_gateway/auth/logout", async (_request, reply) => {
    reply.header("Set-Cookie", buildExpiredSessionCookie());
    return { ok: true };
  });

  app.get("/_gateway/admin/users", async () => ({
    users: await ctx.gatewayDatabaseService.listUsers(),
  }));

  app.post("/_gateway/admin/users", async (request, reply) => {
    const parsed = gatewayUserCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }
    try {
      const user = await ctx.gatewayDatabaseService.createUser({
        username: parsed.data.username,
        passwordHash: hashSecret(parsed.data.password),
        role: parsed.data.role,
      });
      return {
        user,
        users: await ctx.gatewayDatabaseService.listUsers(),
      };
    } catch (error) {
      reply.code(409);
      return {
        error: {
          type: "user_conflict",
          message: error instanceof Error && error.message ? error.message : "用户创建失败，用户名可能已存在。",
        },
      };
    }
  });

  app.put("/_gateway/admin/users/:id", async (request, reply) => {
    const params = gatewayUserParamsSchema.safeParse(request.params);
    const parsed = gatewayUserUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      reply.code(400);
      const validationMessage = !params.success
        ? params.error.issues[0]?.message
        : !parsed.success
          ? parsed.error.issues[0]?.message
          : undefined;
      return {
        error: {
          type: "validation_error",
          message: validationMessage ?? "请求体格式错误",
        },
      };
    }

    if ((parsed.data.disabled === true || parsed.data.role === "user") && await ctx.gatewayDatabaseService.countActiveAdmins(params.data.id) <= 0) {
      reply.code(400);
      return {
        error: {
          type: "last_admin",
          message: "至少需要保留一个启用的管理员。",
        },
      };
    }

    const user = await ctx.gatewayDatabaseService.updateUser(params.data.id, {
      passwordHash: parsed.data.password ? hashSecret(parsed.data.password) : undefined,
      role: parsed.data.role,
      disabled: parsed.data.disabled,
    });
    if (!user) {
      reply.code(404);
      return {
        error: {
          type: "not_found",
          message: "用户不存在。",
        },
      };
    }
    return {
      user,
      users: await ctx.gatewayDatabaseService.listUsers(),
    };
  });

  app.delete("/_gateway/admin/users/:id", async (request, reply) => {
    const params = gatewayUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: params.error.issues[0]?.message ?? "请求参数错误",
        },
      };
    }
    if (await ctx.gatewayDatabaseService.countActiveAdmins(params.data.id) <= 0) {
      reply.code(400);
      return {
        error: {
          type: "last_admin",
          message: "至少需要保留一个启用的管理员。",
        },
      };
    }
    const deleted = await ctx.gatewayDatabaseService.deleteUser(params.data.id);
    if (!deleted) {
      reply.code(404);
      return {
        error: {
          type: "not_found",
          message: "用户不存在。",
        },
      };
    }
    return {
      ok: true,
      users: await ctx.gatewayDatabaseService.listUsers(),
    };
  });

  app.get("/_gateway/status", async () => ctx.authService.getStatus());

  app.get("/_gateway/models", async () => ({
    data: await ctx.modelService.listModels(),
    catalog: await ctx.modelService.getCatalog(),
  }));

  app.post("/_gateway/models/refresh", async () => {
    const result = await ctx.modelService.refreshModels();
    return {
      data: result.models,
      catalog: result.catalog,
    };
  });

  app.post("/_gateway/admin/runtime-refresh", async (request, reply) => {
    const parsed = runtimeRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const [quotaSync] = await Promise.all([
      ctx.authService.syncAllProfileQuotas("openai-codex", {
        suppressErrors: true,
        staleAfterMs: parsed.data.staleOnly ? 30 * 60 * 1000 : undefined,
      }),
      ctx.versionService.getVersionStatus({
        force: true,
      }),
    ]);

    return {
      ...(await buildAdminConfig(request)),
      quotaSync,
    };
  });

  app.get("/_gateway/admin/config", async (request) => buildAdminConfig(request));

  app.get("/_gateway/admin/share", async (request) => {
    const status = await ctx.authService.getStatus();
    const protocol = request.protocol === "https" ? "https" : "http";
    const port = request.raw.socket.localPort || status.serverPort;
    const serverHost = status.serverHost || "0.0.0.0";
    const lanReachable = serverHost === "0.0.0.0" || serverHost === "::" || !isLoopbackHost(serverHost);
    const addresses = getLanIpv4Addresses().map((item) => createShareAddress(protocol, item.address, port, item.label));
    const requestHost = request.headers.host?.replace(/:\d+$/u, "");

    if (requestHost && !isLoopbackHost(requestHost) && !addresses.some((item) => item.host === requestHost)) {
      addresses.unshift(createShareAddress(protocol, requestHost, port, "当前访问地址"));
    }

    return {
      primary: lanReachable ? addresses[0] ?? null : null,
      addresses,
      local: createShareAddress(protocol, "127.0.0.1", port, "本机"),
      serverHost,
      serverPort: port,
      lanReachable,
    };
  });

  app.post("/_gateway/admin/login", async (request) => {
    clearPendingOAuthLogin();
    const session = await startOpenAICodexRemoteLogin();
    const loginId = randomUUID();
    pendingOAuthLogin = {
      id: loginId,
      session,
      createdAt: Date.now(),
    };

    return {
      login: {
        status: "manual_required",
        loginId,
        authorizeUrl: session.authorizeUrl,
        message: "请打开授权链接完成 ChatGPT/Codex 登录。浏览器跳到 localhost:1455/auth/callback 后，把地址栏完整链接粘贴回来保存账号。",
      },
      config: await buildAdminConfig(request),
    };
  });

  app.post("/_gateway/admin/login/manual", async (request, reply) => {
    const parsed = oauthManualSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    if (!pendingOAuthLogin || pendingOAuthLogin.id !== parsed.data.loginId) {
      reply.code(404);
      return {
        error: {
          type: "oauth_login_not_found",
          message: "没有找到等待中的 OAuth 登录，请重新点击登录。",
        },
      };
    }

    try {
      const profile = await pendingOAuthLogin.session.completeWithInput(parsed.data.input);
      await saveCompletedOAuthLogin(profile);
      return buildAdminConfig(request);
    } finally {
      clearPendingOAuthLogin(parsed.data.loginId);
    }
  });

  app.post("/_gateway/admin/login/cancel", async (request) => {
    const parsed = oauthCancelSchema.safeParse(request.body);
    if (parsed.success) {
      clearPendingOAuthLogin(parsed.data.loginId);
    }
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/logout", async (request) => {
    await ctx.authService.logoutAll();
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/profiles/activate", async (request, reply) => {
    const parsed = profileActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    await ctx.authService.activateProfile(parsed.data.profileId);
    await ctx.authService.syncActiveProfileQuota("openai-codex", {
      suppressErrors: true,
      skipAutoSwitch: true,
    });
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/profiles/sync-quota", async (request, reply) => {
    const parsed = profileActionSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    if (parsed.data.profileId) {
      await ctx.authService.syncProfileQuota(parsed.data.profileId, "openai-codex");
    } else {
      await ctx.authService.syncActiveProfileQuota("openai-codex");
    }
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/profiles/remove", async (request, reply) => {
    const parsed = profileActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    await ctx.authService.removeProfile(parsed.data.profileId);
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/profiles/remove-batch", async (request, reply) => {
    const parsed = profileRemoveBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const removedProfileCount = await ctx.authService.removeProfiles(parsed.data.profileIds);
    return {
      ...(await buildAdminConfig(request)),
      removedProfileCount,
    };
  });

  app.post("/_gateway/admin/profiles/import", async (request, reply) => {
    const parsed = profileImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const importedProfiles = await ctx.authService.importProfiles(parsed.data.profile);
    await ctx.authService.syncActiveProfileQuota("openai-codex", {
      suppressErrors: true,
    });
    return {
      ...(await buildAdminConfig(request)),
      importedProfileCount: importedProfiles.length,
    };
  });

  app.post("/_gateway/admin/profiles/import/validate", async (request, reply) => {
    const parsed = profileImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const profiles = ctx.authService.validateProfilesImport(parsed.data.profile);
    return {
      valid: true,
      profileCount: profiles.length,
    };
  });

  app.get("/_gateway/admin/profiles/import-template", async () => ({
    profile: ctx.authService.getProfileImportTemplate(),
  }));

  app.post("/_gateway/admin/profiles/export", async (request, reply) => {
    const parsed = profileExportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    if (parsed.data.all || parsed.data.profileIds) {
      return {
        profile: await ctx.authService.exportProfiles(parsed.data.profileIds, "openai-codex", parsed.data.all ? "all" : "batch"),
        config: await buildAdminConfig(request),
      };
    }

    return {
      profile: await ctx.authService.exportProfile(parsed.data.profileId),
      config: await buildAdminConfig(request),
    };
  });

  app.post("/_gateway/admin/codex/apply", async (request, reply) => {
    const parsed = codexApplySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    return {
      codex: await ctx.authService.applyProfileToCodex(parsed.data.profileId),
      config: await buildAdminConfig(request),
    };
  });

  app.post("/_gateway/admin/codex/configure-provider", async (request, reply) => {
    const parsed = codexProviderConfigSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const origin = resolveOrigin(request);
    const baseUrl = parsed.data.baseUrl ?? `${origin}/codex/v1`;
    return {
      codexProvider: await ctx.authService.applyGatewayToCodexProvider({
        baseUrl,
        providerId: parsed.data.providerId,
      }),
      config: await buildAdminConfig(request),
    };
  });

  app.post("/_gateway/admin/codex/remove-provider", async (request, reply) => {
    const parsed = codexProviderConfigSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    return {
      codexProvider: await ctx.authService.removeGatewayFromCodexProvider({
        providerId: parsed.data.providerId,
      }),
      config: await buildAdminConfig(request),
    };
  });

  app.put("/_gateway/admin/settings", async (request, reply) => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    await ctx.configService.updateSettings(parsed.data);
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/restart", async (_request, reply) => {
    if (!params?.onRestart) {
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "当前环境不支持重启。",
        },
      };
    }

    setTimeout(() => {
      void Promise.resolve(params.onRestart?.()).catch((error) => {
        console.error("[gateway:restart]", error);
      });
    }, 100);

    return {
      ok: true,
      restarting: true,
    };
  });

  app.post("/_gateway/admin/desktop/restart-codex", async (_request, reply) => {
    if (!params?.onRestartCodex) {
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "当前环境不支持重启 Codex。",
        },
      };
    }

    await params.onRestartCodex();
    return {
      ok: true,
      restarted: true,
    };
  });

  app.post("/_gateway/admin/settings/proxy-test", async (request, reply) => {
    const parsed = proxyTestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const proxy = {
      enabled: parsed.data.networkProxy.enabled,
      url: parsed.data.networkProxy.url?.trim() ?? "",
      noProxy: parsed.data.networkProxy.noProxy?.trim() || "localhost,127.0.0.1,::1",
    };

    if (proxy.enabled && !proxy.url) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: "启用代理时必须填写代理地址。",
        },
      };
    }

    const startedAt = performance.now();
    try {
      const response = await requestText({
        method: "GET",
        url: "https://chatgpt.com/",
        timeoutMs: 8000,
        proxyOverride: proxy,
      });
      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        target: "https://chatgpt.com/",
        transport: response.transport,
      };
    } catch (error) {
      reply.code(502);
      return {
        error: {
          type: "proxy_test_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  app.get("/_gateway/admin/network-detect", async () => {
    const settings = await ctx.configService.getSettings();
    return ctx.networkDetectService.collectReport(settings.networkProxy);
  });

  app.get("/_gateway/image-bed/config", async () => ctx.githubImageBedService.getConfig());

  app.post("/_gateway/image-bed/validate", async () => ctx.githubImageBedService.testConnection());

  app.get("/_gateway/image-bed/history", async (request, reply) => {
    const parsed = githubImageBedHistoryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求参数格式错误",
        },
      };
    }

    return ctx.githubImageBedService.listHistory(parsed.data.limit ?? 50);
  });

  app.put("/_gateway/image-bed/config", async (request, reply) => {
    const parsed = githubImageBedConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    return ctx.githubImageBedService.saveToken(parsed.data.token);
  });

  app.delete("/_gateway/image-bed/config", async () => ctx.githubImageBedService.clearToken());

  app.post("/_gateway/image-bed/upload", async (request, reply) => {
    const parsed = githubImageBedUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const uploaded = await ctx.githubImageBedService.uploadImage(parsed.data);
    await ctx.githubImageBedService.rememberUpload(uploaded);
    return uploaded;
  });

  app.delete("/_gateway/image-bed/history/:id", async (request, reply) => {
    const parsed = githubImageBedHistoryParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求参数格式错误",
        },
      };
    }

    return ctx.githubImageBedService.deleteHistoryItem(parsed.data.id);
  });

  app.delete("/_gateway/image-bed/history", async () => ctx.githubImageBedService.clearHistory());

  app.get("/v1/models", async () => buildOpenAIModelsResponse(ctx));

  app.get("/codex/v1/models", async () => buildCodexModelsResponse(ctx));

  app.get("/codex/v1/responses", async (_request, reply) => {
    reply.code(426);
    return {
      error: {
        type: "websocket_unsupported",
        message: "AI Zero Token 当前通过 HTTP SSE 转发 Codex Responses 请求。",
      },
    };
  });

  async function handleCodexResponsesPassthrough(
    request: FastifyRequest,
    reply: FastifyReply,
    data: z.infer<typeof responsesBodySchema>,
    startedAt: number,
    upstreamEndpoint: "responses" | "responses/compact" = "responses",
  ) {
    const abortController = new AbortController();
    let streamFinished = false;
    let headersCommitted = false;
    let clientDisconnected = false;
    let clientDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let profile: OAuthProfile | null = null;
    let retryCount = 0;
    let failureRecorded = false;
    let codexImageRoute: UsageImageRoute = "none";
    const originalPreviousResponseId = getPreviousResponseId(data);
    let adventureFallbackUsed = false;
    let adventureFallbackReason: string | undefined;
    reply.raw.on("close", () => {
      if (!streamFinished) {
        clientDisconnected = true;
        if (!headersCommitted) {
          abortController.abort();
          return;
        }
        clientDrainTimer = setTimeout(() => {
          abortController.abort();
        }, CODEX_STREAM_DRAIN_AFTER_CLIENT_CLOSE_MS);
        clientDrainTimer.unref?.();
      }
    });

    try {
      const model = await ctx.modelService.resolveModel("openai-codex", data.model, {
        allowUnknown: data.experimental_codex?.allow_unknown_model,
      });
      let codexBody = createCodexPassthroughBody(data, model);
      let activePreviousResponseId = originalPreviousResponseId;
      let keepProfileSticky = Boolean(activePreviousResponseId);
      let stickyProfileId = activePreviousResponseId ? codexResponseProfileBindings.get(activePreviousResponseId)?.profileId : undefined;
      const useAdventureFallback = async (error: unknown, quota: import("../core/types.js").CodexQuotaSnapshot | undefined): Promise<boolean> => {
        if (!keepProfileSticky || abortController.signal.aborted) {
          return false;
        }

        const failedProfileId = profile?.profileId ?? stickyProfileId;
        if (failedProfileId) {
          await ctx.authService.recordProfileRequestFailure(failedProfileId, error, quota, "openai-codex", {
            skipAutoSwitch: true,
          });
        }

        codexBody = removePreviousResponseId(codexBody);
        activePreviousResponseId = undefined;
        keepProfileSticky = false;
        stickyProfileId = undefined;
        adventureFallbackUsed = true;
        adventureFallbackReason = error instanceof Error ? error.message : String(error);
        retryCount += 1;
        profile = null;
        failureRecorded = false;
        console.warn("[gateway:codex:stream] sticky continuation failed; dropping previous_response_id and retrying as new session", {
          requestId: request.id,
          model,
          retryCount,
          previousResponseId: "[present]",
          failedAccount: failedProfileId,
          errorCode: (error as { code?: unknown }).code,
          upstreamStatus: (error as { upstreamStatus?: unknown }).upstreamStatus,
          upstreamRequestId: (error as { requestId?: unknown }).requestId,
          message: adventureFallbackReason,
        });
        return true;
      };
      const imageRequest = upstreamEndpoint === "responses" ? extractCodexImageGenerationRequest(codexBody) : null;
      if (imageRequest) {
        codexImageRoute = "codex-tool";
        const settings = await ctx.configService.getSettings();
        if (settings.image.freeAccountWebGenerationEnabled) {
          profile = await ctx.authService.requireUsableProfile("openai-codex", {
            skipAutoSwitch: keepProfileSticky,
            skipRequestRotation: retryCount > 0,
          });
        }
        if (profile && isFreePlan(profile)) {
          if (!imageRequest.prompt) {
            throw new Error("Codex 生图请求缺少文本 prompt。");
          }
          console.info("[gateway:codex:image] using ChatGPT web image route for Free profile", {
            requestId: request.id,
            account: profileLogLabel(profile),
            model,
            imageModel: imageRequest.imageModel,
            promptLength: imageRequest.prompt.length,
            inputImageCount: imageRequest.inputImages.length,
            size: imageRequest.size ?? "default",
          });
          const imageResult = await generateChatGPTWebImage({
            profile,
            prompt: imageRequest.prompt,
            model: imageRequest.imageModel,
            inputImages: imageRequest.inputImages,
            size: imageRequest.size,
            responseFormat: "b64_json",
          });
          await ctx.authService.recordProfileRequestSuccess(profile.profileId, undefined, "openai-codex", {
            skipAutoSwitch: true,
          });
          headersCommitted = true;
          const syntheticStats = await sendSyntheticCodexImageSse({
            reply,
            result: imageResult,
            model,
            prompt: imageRequest.prompt,
            requestedSize: imageRequest.size,
            requestedOutputFormat: imageRequest.outputFormat,
          });
          streamFinished = true;
          pushGatewayRequestLog({
            method: request.method,
            endpoint: request.url,
            account: profileLogLabel(profile),
            model,
            statusCode: 200,
            durationMs: performance.now() - startedAt,
            source: "Codex",
            details: {
              requestId: request.id,
              remoteAddress: request.ip,
              userAgent: request.headers["user-agent"],
              request: summarizeResponsesRequest(data, request.url),
              response: {
                stream: true,
                passthrough: false,
                upstreamEndpoint,
                route: "chatgpt-web-image",
                imageModel: imageRequest.imageModel,
                imageCount: syntheticStats.imageCount,
                bytes: syntheticStats.bytes,
              },
            },
            usage: {
              profile,
              imageCount: syntheticStats.imageCount,
              imageRoute: "chatgpt-web",
            },
          });
          return reply;
        }
      }
      let upstream: Awaited<ReturnType<typeof streamOpenAICodex>> | null = null;
      const maxProfileAttempts = 5;
      const maxTransientStreamRetries = 1;
      let transientStreamRetryCount = 0;

      for (let attempt = 0; attempt < maxProfileAttempts; attempt += 1) {
        try {
          profile = stickyProfileId
            ? await ctx.authService.requireUsableProfileById(stickyProfileId, "openai-codex")
            : await ctx.authService.requireUsableProfile("openai-codex", {
                skipAutoSwitch: keepProfileSticky,
                skipRequestRotation: attempt > 0,
              });
          const selectedProfile = profile;
          upstream = await ctx.requestThrottleService.runForProfile(
            selectedProfile,
            () => streamOpenAICodex({
              profile: selectedProfile,
              model,
              bodyOverride: codexBody,
              endpoint: upstreamEndpoint,
              passthroughBody: true,
              signal: abortController.signal,
            }),
            {
              requestId: request.id,
              route: `codex/${upstreamEndpoint}`,
              model,
            },
          );
          break;
        } catch (error) {
          const quota = (error as { quota?: import("../core/types.js").CodexQuotaSnapshot }).quota;
          if (
            keepProfileSticky &&
            attempt < maxProfileAttempts - 1 &&
            await useAdventureFallback(error, quota)
          ) {
            continue;
          }
          if (
            !keepProfileSticky &&
            isTransientHttpError(error) &&
            transientStreamRetryCount < maxTransientStreamRetries &&
            attempt < maxProfileAttempts - 1 &&
            !abortController.signal.aborted
          ) {
            transientStreamRetryCount += 1;
            retryCount += 1;
            console.warn("[gateway:codex:stream] transient curl stream failure before headers; retrying request", {
              requestId: request.id,
              account: profileLogLabel(profile),
              model,
              retryCount,
              errorCode: (error as { code?: unknown }).code,
              upstreamRequestId: (error as { requestId?: unknown }).requestId,
              message: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!profile) {
            throw error;
          }
          const switchedProfile = await ctx.authService.recordProfileRequestFailure(profile.profileId, error, quota, "openai-codex", {
            skipAutoSwitch: keepProfileSticky,
          });
          failureRecorded = true;
          if (
            !keepProfileSticky &&
            attempt < maxProfileAttempts - 1 &&
            ctx.authService.isRotationTrigger(error, quota) &&
            switchedProfile &&
            switchedProfile.profileId !== profile.profileId &&
            !abortController.signal.aborted
          ) {
            retryCount += 1;
            failureRecorded = false;
            continue;
          }
          throw error;
        }
      }

      if (!upstream || !profile) {
        throw new Error("Codex stream 未能建立。");
      }

      await ctx.authService.recordProfileRequestSuccess(profile.profileId, upstream.quota, "openai-codex", {
        skipAutoSwitch: keepProfileSticky,
      });

      const headers: Record<string, string> = {
        "Content-Type": upstream.headers["content-type"] ?? "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };
      if (adventureFallbackUsed) {
        headers["X-AZT-Codex-Continuation-Mode"] = "adventure-fallback";
      }
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (key.startsWith("x-codex-") || key === "x-request-id") {
          headers[key] = value;
        }
      }

      reply.raw.writeHead(upstream.status, headers);
      headersCommitted = true;
      reply.raw.flushHeaders?.();

      const streamStats = createSseStreamStats();
      const writeChunkToClient = async (chunk: unknown): Promise<void> => {
        if (clientDisconnected || reply.raw.destroyed || reply.raw.writableEnded) {
          clientDisconnected = true;
          return;
        }
        try {
          if (!reply.raw.write(chunk)) {
            await new Promise<void>((resolve) => {
              const cleanup = () => {
                reply.raw.off("drain", cleanup);
                reply.raw.off("close", cleanup);
                resolve();
              };
              reply.raw.once("drain", cleanup);
              reply.raw.once("close", cleanup);
            });
          }
        } catch {
          clientDisconnected = true;
        }
      };
      for await (const chunk of Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0])) {
        trackSseChunk(streamStats, chunk);
        await writeChunkToClient(chunk);
      }
      streamFinished = true;
      if (clientDrainTimer) {
        clearTimeout(clientDrainTimer);
        clientDrainTimer = null;
      }
      if (!clientDisconnected && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
      for (const responseId of streamStats.responseIds) {
        rememberCodexResponseProfile(responseId, profile);
      }
      if (!streamStats.completed) {
        console.warn("[gateway:codex:stream] upstream stream ended without response.completed", {
          requestId: request.id,
          upstreamRequestId: upstream.requestId,
          account: profileLogLabel(profile),
          model,
          bytes: streamStats.bytes,
          terminalEvent: streamStats.terminalEvent,
        });
      }

      pushGatewayRequestLog({
        id: request.id,
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(profile),
        model,
        statusCode: upstream.status,
        durationMs: performance.now() - startedAt,
        source: "Codex",
        details: {
          requestId: request.id,
          upstreamRequestId: upstream.requestId,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeResponsesRequest(data, request.url),
          response: {
            stream: true,
            passthrough: true,
            upstreamEndpoint,
            retryCount,
            profileSticky: keepProfileSticky,
            previousResponseId: originalPreviousResponseId ? "[present]" : undefined,
            previousResponseDropped: adventureFallbackUsed,
            adventureFallbackReason: adventureFallbackUsed ? truncateForLog(adventureFallbackReason ?? "") : undefined,
            stickyProfileResolved: Boolean(stickyProfileId),
            responseIdsTracked: streamStats.responseIds.size,
            completed: streamStats.completed,
            terminalEvent: streamStats.terminalEvent,
            bytes: streamStats.bytes,
            usageCaptured: Boolean(streamStats.tokenUsage),
            tokenUsageStatus: sseTokenUsageStatus(streamStats, upstream.status),
            parseErrorCount: streamStats.parseErrorCount,
            clientDisconnected,
          },
        },
        usage: {
          profile,
          tokenUsage: streamStats.tokenUsage,
          tokenUsageStatus: sseTokenUsageStatus(streamStats, upstream.status),
          imageRoute: codexImageRoute,
        },
      });
      return reply;
    } catch (error) {
      if (clientDrainTimer) {
        clearTimeout(clientDrainTimer);
        clientDrainTimer = null;
      }
      const quota = (error as { quota?: import("../core/types.js").CodexQuotaSnapshot }).quota;
      if (profile && !failureRecorded) {
        await ctx.authService.recordProfileRequestFailure(profile.profileId, error, quota, "openai-codex", {
          skipAutoSwitch: Boolean(originalPreviousResponseId) && !adventureFallbackUsed,
        });
      }
      const normalized = normalizeError(error);
      const statusCode = getErrorStatusCode(normalized);
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(profile),
        model: data.model ?? "default",
        statusCode,
        durationMs: performance.now() - startedAt,
        source: "Codex",
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeResponsesRequest(data, request.url),
          response: {
            upstreamEndpoint,
            retryCount,
            profileSticky: Boolean(originalPreviousResponseId) && !adventureFallbackUsed,
            previousResponseId: originalPreviousResponseId ? "[present]" : undefined,
            previousResponseDropped: adventureFallbackUsed,
            adventureFallbackReason: adventureFallbackUsed ? truncateForLog(adventureFallbackReason ?? "") : undefined,
            stickyProfileResolved: Boolean(originalPreviousResponseId && codexResponseProfileBindings.has(originalPreviousResponseId)),
          },
          error: {
            message: normalized.message,
            code: (normalized as Error & { code?: unknown }).code,
            upstreamRequestId: (normalized as Error & { requestId?: unknown }).requestId,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile,
          imageRoute: codexImageRoute,
        },
      });
      if (headersCommitted) {
        streamFinished = true;
        reply.raw.end();
        return reply;
      }
      throw error;
    }
  }

  app.post("/codex/v1/responses", async (request, reply) => {
    const startedAt = performance.now();
    const parsed = responsesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: "Codex",
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    return handleCodexResponsesPassthrough(request, reply, parsed.data, startedAt);
  });

  app.post("/codex/v1/responses/compact", { bodyLimit: codexCompactBodyLimit }, async (request, reply) => {
    const startedAt = performance.now();
    const parsed = responsesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: "Codex",
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    return handleCodexResponsesPassthrough(request, reply, parsed.data, startedAt, "responses/compact");
  });

  app.post("/v1/responses", async (request, reply) => {
    const startedAt = performance.now();
    const parsed = responsesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const wantsEventStream = typeof request.headers.accept === "string" && request.headers.accept.toLowerCase().includes("text/event-stream");
    const input = extractTextInput(parsed.data.input);

    const hasInput =
      typeof parsed.data.input !== "undefined" ||
      typeof parsed.data.experimental_codex?.body?.input !== "undefined";
    if (!hasInput) {
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "default",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeResponsesRequest(parsed.data),
          error: {
            type: "validation_error",
            message: "没有提供 input，也没有在 experimental_codex.body 里透传 input",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: "没有提供 input，也没有在 experimental_codex.body 里透传 input",
        },
      };
    }

    if (parsed.data.stream || wantsEventStream) {
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "default",
        statusCode: 501,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeResponsesRequest(parsed.data),
          error: {
            type: "not_supported",
            message: "普通 Responses stream 尚未实现；Codex custom provider 请求会走专用透传路径。",
          },
        },
      });
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "普通 Responses stream 尚未实现；Codex custom provider 请求会走专用透传路径。",
        },
      };
    }

    const codexBody = createResponsesCodexBody(parsed.data);
    let result: ChatResult;
    try {
      result = await ctx.chatService.chat({
        model: parsed.data.model,
        input: input || undefined,
        system: parsed.data.instructions,
        experimental: {
          codexBody,
          allowUnknownModel: parsed.data.experimental_codex?.allow_unknown_model,
        },
      });
    } catch (error) {
      const normalized = normalizeError(error);
      const statusCode = getErrorStatusCode(normalized);
      const activeProfile = await ctx.authService.getActiveProfile();
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(activeProfile),
        model: parsed.data.model ?? "default",
        statusCode,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeResponsesRequest(parsed.data),
          codex: summarizeCodexChatBody(codexBody),
          error: {
            message: normalized.message,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile: activeProfile,
        },
      });
      throw error;
    }

    const activeProfile = result.profile ?? await ctx.authService.getActiveProfile();
    pushGatewayRequestLog({
      id: request.id,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: result.model,
      statusCode: 200,
      durationMs: performance.now() - startedAt,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: summarizeResponsesRequest(parsed.data),
        codex: summarizeCodexChatBody(codexBody),
        response: {
          textPreview: truncateForLog(result.text),
          textLength: result.text.length,
          artifactCount: result.artifacts.length,
          retryCount: result.retryCount ?? 0,
        },
      },
      usage: {
        profile: activeProfile,
        tokenUsage: extractTokenUsage(result.raw),
      },
    });

    return buildResponseApiBody(result, parsed.data.experimental_codex?.include_raw);
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const startedAt = performance.now();
    const requestOwner = await getRequestOwner(request);
    const parsed = chatCompletionsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      pushGatewayRequestLog({
        id: request.id,
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: "API",
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    if (typeof parsed.data.n === "number" && parsed.data.n > 1) {
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "default",
        statusCode: 501,
        durationMs: performance.now() - startedAt,
        source: "API",
        details: {
          requestId: request.id,
          request: summarizeChatCompletionsRequest(parsed.data),
          error: {
            type: "not_supported",
            message: "当前网关暂不支持一次返回多个 choices（n > 1）",
          },
        },
      });
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "当前网关暂不支持一次返回多个 choices（n > 1）",
        },
      };
    }

    const codexBody = createChatCompletionsCodexBody(parsed.data);
    console.info("[gateway:chat:request]", {
      requestId: request.id,
      remoteAddress: request.ip,
      userAgent: request.headers["user-agent"],
      ...summarizeChatCompletionsRequest(parsed.data),
      codex: summarizeCodexChatBody(codexBody),
    });
    const fallbackInput = parsed.data.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join("\n"),
      )
      .filter(Boolean)
      .join("\n")
      .trim();

    let result: ChatResult;
    try {
      result = await ctx.chatService.chat({
        model: parsed.data.model,
        input: fallbackInput || undefined,
        experimental: {
          codexBody,
        },
      });
    } catch (error) {
      const normalized = normalizeError(error);
      const statusCode = getErrorStatusCode(normalized);
      const activeProfile = await ctx.authService.getActiveProfile();
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(activeProfile),
        model: parsed.data.model ?? "default",
        statusCode,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeChatCompletionsRequest(parsed.data),
          codex: summarizeCodexChatBody(codexBody),
          error: {
            message: normalized.message,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile: activeProfile,
        },
      });
      throw error;
    }

    const activeProfile = result.profile ?? await ctx.authService.getActiveProfile();
    pushGatewayRequestLog({
      id: request.id,
      owner: requestOwner,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: result.model,
      statusCode: 200,
      durationMs: performance.now() - startedAt,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: summarizeChatCompletionsRequest(parsed.data),
        codex: summarizeCodexChatBody(codexBody),
        response: {
          textPreview: truncateForLog(result.text),
          textLength: result.text.length,
          toolCallCount: result.toolCalls.length,
          toolCalls: result.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            argumentsPreview: truncateForLog(toolCall.function.arguments),
          })),
          artifactCount: result.artifacts.length,
          stream: parsed.data.stream ?? false,
          retryCount: result.retryCount ?? 0,
        },
      },
      usage: {
        profile: activeProfile,
        tokenUsage: extractTokenUsage(result.raw),
      },
    });
    console.info("[gateway:chat:response]", {
      requestId: request.id,
      model: result.model,
      stream: parsed.data.stream ?? false,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      textLength: result.text.length,
      toolCallCount: result.toolCalls.length,
      artifactCount: result.artifacts.length,
    });

    if (parsed.data.stream) {
      const rawStreamOptions = (parsed.data as Record<string, unknown>).stream_options;
      const streamOptions = isObjectRecord(rawStreamOptions)
        ? rawStreamOptions
        : null;
      sendChatCompletionsStream(reply, result, streamOptions?.include_usage === true);
      return reply;
    }

    return buildChatCompletionsBody(result);
  });

  app.post("/v1/images/generations", async (request, reply) => {
    const startedAt = performance.now();
    const requestOwner = await getRequestOwner(request);
    const parsed = imageGenerationsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      console.error("[gateway:image] validation failure", {
        method: request.method,
        url: request.url,
        issue: parsed.error.issues[0]?.message ?? "请求体格式错误",
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const validationError = validateImageRequest(parsed.data);
    if (validationError) {
      console.error("[gateway:image] validation failure", {
        method: request.method,
        url: request.url,
        summary: summarizeImageRequestForLog(parsed.data),
        issue: validationError,
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "gpt-image-2",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeImageRequestForLog(parsed.data),
          error: {
            type: "validation_error",
            message: validationError,
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: validationError,
        },
      };
    }

    if (typeof parsed.data.n === "number" && parsed.data.n > 1) {
      console.error("[gateway:image] not supported", {
        method: request.method,
        url: request.url,
        summary: summarizeImageRequestForLog(parsed.data),
        issue: "当前网关暂不支持 images.generations 一次返回多张图（n > 1）",
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "gpt-image-2",
        statusCode: 501,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeImageRequestForLog(parsed.data),
          error: {
            type: "not_supported",
            message: "当前网关暂不支持 images.generations 一次返回多张图（n > 1）",
          },
        },
      });
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "当前网关暂不支持 images.generations 一次返回多张图（n > 1）",
        },
      };
    }

    const requestSummary = summarizeImageRequestForLog(parsed.data);
    console.info("[gateway:image] request accepted", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
    });

    const activeProfile = await ctx.authService.getActiveProfile();
    const settings = await ctx.configService.getSettings();
    const imageRoute: UsageImageRoute = activeProfile && isFreePlan(activeProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : "codex-tool";
    const limit = await checkImageGenerationLimit(requestOwner, settings);
    if (!limit.allowed) {
      return sendImageLimitResponse(reply, limit, {
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        model: parsed.data.model ?? "gpt-image-2",
        startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        requestSummary,
      });
    }
    const generationId = request.id;
    const generationCreatedAt = Date.now();
    let generationStartedAt: number | undefined;
    pushGatewayRequestLog({
      id: generationId,
      owner: requestOwner,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? "gpt-image-2",
      statusCode: 102,
      durationMs: 0,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: requestSummary,
        state: "queued",
      },
    });
    ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      status: "queued",
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? "gpt-image-2",
      prompt: parsed.data.prompt,
      ratio: ratioFromImageSize(parsed.data.size),
      size: parsed.data.size,
      quality: parsed.data.quality,
      outputFormat: parsed.data.output_format,
      durationMs: 0,
      request: {
        ...requestSummary,
        prompt: parsed.data.prompt,
      },
    }).catch((persistError) => {
      console.warn("[gateway:image] failed to persist queued generation", {
        requestId: request.id,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
    });
    let response: Awaited<ReturnType<typeof ctx.imageService.generate>>;
    try {
      response = await withDeferredTimeout(
        (startTimeout) => ctx.imageService.generate({
          prompt: parsed.data.prompt,
          model: parsed.data.model,
          n: parsed.data.n,
          size: parsed.data.size,
          quality: parsed.data.quality,
          background: parsed.data.background,
          outputFormat: parsed.data.output_format,
          outputCompression: parsed.data.output_compression,
          moderation: parsed.data.moderation,
        }, {
          requestId: request.id,
          onQueued: () => ctx.gatewayDatabaseService.saveGeneration({
            id: generationId,
            owner: requestOwner,
            createdAt: generationCreatedAt,
            status: "queued",
            endpoint: request.url,
            account: profileLogLabel(activeProfile),
            model: parsed.data.model ?? "gpt-image-2",
            prompt: parsed.data.prompt,
            ratio: ratioFromImageSize(parsed.data.size),
            size: parsed.data.size,
            quality: parsed.data.quality,
            outputFormat: parsed.data.output_format,
            durationMs: 0,
            request: {
              ...requestSummary,
              prompt: parsed.data.prompt,
            },
          }),
          onStart: (profile) => {
            startTimeout();
            generationStartedAt ??= Date.now();
            return ctx.gatewayDatabaseService.saveGeneration({
              id: generationId,
              owner: requestOwner,
              createdAt: generationCreatedAt,
              startedAt: generationStartedAt,
              status: "running",
              endpoint: request.url,
              account: profileLogLabel(profile),
              model: parsed.data.model ?? "gpt-image-2",
              prompt: parsed.data.prompt,
              ratio: ratioFromImageSize(parsed.data.size),
              size: parsed.data.size,
              quality: parsed.data.quality,
              outputFormat: parsed.data.output_format,
              durationMs: 0,
              request: {
                ...requestSummary,
                prompt: parsed.data.prompt,
              },
            });
          },
        }),
        IMAGE_GENERATION_TIMEOUT_MS,
        `图片生成超过 ${Math.floor(IMAGE_GENERATION_TIMEOUT_MS / 1000)} 秒仍未完成，已超时。`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      const statusCode = getErrorStatusCode(normalized);
      const durationMs = performance.now() - startedAt;
      const failedProfile = (error as { _gatewayProfile?: OAuthProfile })._gatewayProfile ?? activeProfile;
      const failedImageRoute: UsageImageRoute = failedProfile && isFreePlan(failedProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : imageRoute;
      ctx.gatewayDatabaseService.saveGeneration({
        id: generationId,
        owner: requestOwner,
        createdAt: generationCreatedAt,
        startedAt: generationStartedAt,
        status: "failed",
        endpoint: request.url,
        account: profileLogLabel(failedProfile),
        model: parsed.data.model ?? "gpt-image-2",
        prompt: parsed.data.prompt,
        ratio: ratioFromImageSize(parsed.data.size),
        size: parsed.data.size,
        quality: parsed.data.quality,
        outputFormat: parsed.data.output_format,
        durationMs,
        request: {
          ...requestSummary,
          prompt: parsed.data.prompt,
        },
        error: normalized.message,
      }).catch((persistError) => {
        console.warn("[gateway:image] failed to persist generation failure", {
          requestId: request.id,
          message: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(failedProfile),
        model: parsed.data.model ?? "gpt-image-2",
        statusCode,
        durationMs,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: requestSummary,
          error: {
            message: normalized.message,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile: failedProfile,
          imageRoute: failedImageRoute,
        },
      });
      throw error;
    }

    const responseProfile = response._gatewayProfile ?? activeProfile;
    const responseImageRoute: UsageImageRoute = responseProfile && isFreePlan(responseProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : "codex-tool";
    const { _gatewayProfile: _generationProfile, ...publicResponse } = response;
    const durationMs = performance.now() - startedAt;
    console.info("[gateway:image] response ready", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
      created: publicResponse.created,
      imageCount: publicResponse.data.length,
      output_format: publicResponse.output_format,
      quality: publicResponse.quality,
      size: publicResponse.size,
    });
    pushGatewayRequestLog({
      owner: requestOwner,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(responseProfile),
      model: parsed.data.model ?? "gpt-image-2",
      statusCode: 200,
      durationMs,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: requestSummary,
        response: {
          imageCount: publicResponse.data.length,
          outputFormat: publicResponse.output_format,
          quality: publicResponse.quality,
          size: publicResponse.size,
        },
      },
      usage: {
        profile: responseProfile,
        tokenUsage: imageUsageToTokenUsage(publicResponse.usage),
        imageCount: publicResponse.data.length,
        imageRoute: responseImageRoute,
      },
    });
    const savedGeneration = await ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      startedAt: generationStartedAt,
      status: "success",
      endpoint: request.url,
      account: profileLogLabel(responseProfile),
      model: parsed.data.model ?? "gpt-image-2",
      prompt: parsed.data.prompt,
      ratio: ratioFromImageSize(publicResponse.size ?? parsed.data.size),
      size: publicResponse.size ?? parsed.data.size,
      quality: publicResponse.quality ?? parsed.data.quality,
      outputFormat: publicResponse.output_format ?? parsed.data.output_format,
      durationMs,
      request: {
        ...requestSummary,
        prompt: parsed.data.prompt,
      },
      response: publicResponse,
    }).catch((persistError) => {
      console.warn("[gateway:image] failed to persist generation", {
        requestId: request.id,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
      return null;
    });

    return savedGeneration ? { ...publicResponse, _gateway_images: toGatewayImageAssets(savedGeneration.images) } : publicResponse;
  });

  app.post("/v1/images/edits", async (request, reply) => {
    const startedAt = performance.now();
    const requestOwner = await getRequestOwner(request);
    const contentType = request.headers["content-type"] ?? "";
    if (!String(contentType).toLowerCase().includes("application/json")) {
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 415,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "unsupported_media_type",
            message: "当前网关仅支持 JSON 版 images.edits；请使用 application/json，并通过 images[].image_url 传 URL 或 base64 data URL。",
          },
        },
      });
      reply.code(415);
      return {
        error: {
          type: "unsupported_media_type",
          message: "当前网关仅支持 JSON 版 images.edits；请使用 application/json，并通过 images[].image_url 传 URL 或 base64 data URL。",
        },
      };
    }

    const parsed = imageEditsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      console.error("[gateway:image:edit] validation failure", {
        method: request.method,
        url: request.url,
        issue: parsed.error.issues[0]?.message ?? "请求体格式错误",
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: {
            type: "validation_error",
            message: parsed.error.issues[0]?.message ?? "请求体格式错误",
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "请求体格式错误",
        },
      };
    }

    const validationError = validateImageEditRequest(parsed.data);
    if (validationError) {
      console.error("[gateway:image:edit] validation failure", {
        method: request.method,
        url: request.url,
        summary: summarizeImageEditRequestForLog(parsed.data),
        issue: validationError,
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "gpt-image-2",
        statusCode: 400,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeImageEditRequestForLog(parsed.data),
          error: {
            type: "validation_error",
            message: validationError,
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: validationError,
        },
      };
    }

    if (typeof parsed.data.n === "number" && parsed.data.n > 1) {
      console.error("[gateway:image:edit] not supported", {
        method: request.method,
        url: request.url,
        summary: summarizeImageEditRequestForLog(parsed.data),
        issue: "当前网关暂不支持 images.edits 一次返回多张图（n > 1）",
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? "gpt-image-2",
        statusCode: 501,
        durationMs: performance.now() - startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: summarizeImageEditRequestForLog(parsed.data),
          error: {
            type: "not_supported",
            message: "当前网关暂不支持 images.edits 一次返回多张图（n > 1）",
          },
        },
      });
      reply.code(501);
      return {
        error: {
          type: "not_supported",
          message: "当前网关暂不支持 images.edits 一次返回多张图（n > 1）",
        },
      };
    }

    const imageReferences = getImageEditReferences(parsed.data)
      .map((reference) => normalizeJsonImageReference(reference))
      .map((reference) => ({
        imageUrl: reference.imageUrl ?? "",
      }));
    const requestSummary = summarizeImageEditRequestForLog(parsed.data);
    console.info("[gateway:image:edit] request accepted", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
    });

    const activeProfile = await ctx.authService.getActiveProfile();
    const settings = await ctx.configService.getSettings();
    const imageRoute: UsageImageRoute = activeProfile && isFreePlan(activeProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : "codex-tool";
    const limit = await checkImageGenerationLimit(requestOwner, settings);
    if (!limit.allowed) {
      return sendImageLimitResponse(reply, limit, {
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        model: parsed.data.model ?? "gpt-image-2",
        startedAt,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        requestSummary,
      });
    }
    const generationId = request.id;
    const generationCreatedAt = Date.now();
    let generationStartedAt: number | undefined;
    pushGatewayRequestLog({
      id: generationId,
      owner: requestOwner,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? "gpt-image-2",
      statusCode: 102,
      durationMs: 0,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: requestSummary,
        state: "queued",
      },
    });
    ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      status: "queued",
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? "gpt-image-2",
      prompt: parsed.data.prompt,
      ratio: ratioFromImageSize(parsed.data.size),
      size: parsed.data.size,
      quality: parsed.data.quality,
      outputFormat: parsed.data.output_format,
      durationMs: 0,
      request: {
        ...requestSummary,
        prompt: parsed.data.prompt,
      },
      referenceImages: getImageEditReferenceAssets(parsed.data),
    }).catch((persistError) => {
      console.warn("[gateway:image:edit] failed to persist queued generation", {
        requestId: request.id,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
    });
    let response: Awaited<ReturnType<typeof ctx.imageService.generate>>;
    try {
      response = await withDeferredTimeout(
        (startTimeout) => ctx.imageService.generate({
          prompt: parsed.data.prompt,
          inputImages: imageReferences,
          model: parsed.data.model,
          n: parsed.data.n,
          size: parsed.data.size,
          quality: parsed.data.quality,
          background: parsed.data.background,
          outputFormat: parsed.data.output_format,
          outputCompression: parsed.data.output_compression,
          moderation: parsed.data.moderation,
        }, {
          requestId: request.id,
          onQueued: () => ctx.gatewayDatabaseService.saveGeneration({
            id: generationId,
            owner: requestOwner,
            createdAt: generationCreatedAt,
            status: "queued",
            endpoint: request.url,
            account: profileLogLabel(activeProfile),
            model: parsed.data.model ?? "gpt-image-2",
            prompt: parsed.data.prompt,
            ratio: ratioFromImageSize(parsed.data.size),
            size: parsed.data.size,
            quality: parsed.data.quality,
            outputFormat: parsed.data.output_format,
            durationMs: 0,
            request: {
              ...requestSummary,
              prompt: parsed.data.prompt,
            },
            referenceImages: getImageEditReferenceAssets(parsed.data),
          }),
          onStart: (profile) => {
            startTimeout();
            generationStartedAt ??= Date.now();
            return ctx.gatewayDatabaseService.saveGeneration({
              id: generationId,
              owner: requestOwner,
              createdAt: generationCreatedAt,
              startedAt: generationStartedAt,
              status: "running",
              endpoint: request.url,
              account: profileLogLabel(profile),
              model: parsed.data.model ?? "gpt-image-2",
              prompt: parsed.data.prompt,
              ratio: ratioFromImageSize(parsed.data.size),
              size: parsed.data.size,
              quality: parsed.data.quality,
              outputFormat: parsed.data.output_format,
              durationMs: 0,
              request: {
                ...requestSummary,
                prompt: parsed.data.prompt,
              },
              referenceImages: getImageEditReferenceAssets(parsed.data),
            });
          },
        }),
        IMAGE_GENERATION_TIMEOUT_MS,
        `图片生成超过 ${Math.floor(IMAGE_GENERATION_TIMEOUT_MS / 1000)} 秒仍未完成，已超时。`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      const statusCode = getErrorStatusCode(normalized);
      const durationMs = performance.now() - startedAt;
      const failedProfile = (error as { _gatewayProfile?: OAuthProfile })._gatewayProfile ?? activeProfile;
      const failedImageRoute: UsageImageRoute = failedProfile && isFreePlan(failedProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : imageRoute;
      ctx.gatewayDatabaseService.saveGeneration({
        id: generationId,
        owner: requestOwner,
        createdAt: generationCreatedAt,
        startedAt: generationStartedAt,
        status: "failed",
        endpoint: request.url,
        account: profileLogLabel(failedProfile),
        model: parsed.data.model ?? "gpt-image-2",
        prompt: parsed.data.prompt,
        ratio: ratioFromImageSize(parsed.data.size),
        size: parsed.data.size,
        quality: parsed.data.quality,
        outputFormat: parsed.data.output_format,
        durationMs,
        request: {
          ...requestSummary,
          prompt: parsed.data.prompt,
        },
        error: normalized.message,
        referenceImages: getImageEditReferenceAssets(parsed.data),
      }).catch((persistError) => {
        console.warn("[gateway:image:edit] failed to persist generation failure", {
          requestId: request.id,
          message: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: profileLogLabel(failedProfile),
        model: parsed.data.model ?? "gpt-image-2",
        statusCode,
        durationMs,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          request: requestSummary,
          error: {
            message: normalized.message,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile: failedProfile,
          imageRoute: failedImageRoute,
        },
      });
      throw error;
    }

    const responseProfile = response._gatewayProfile ?? activeProfile;
    const responseImageRoute: UsageImageRoute = responseProfile && isFreePlan(responseProfile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : "codex-tool";
    const { _gatewayProfile: _editProfile, ...publicResponse } = response;
    const durationMs = performance.now() - startedAt;
    console.info("[gateway:image:edit] response ready", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
      created: publicResponse.created,
      imageCount: publicResponse.data.length,
      output_format: publicResponse.output_format,
      quality: publicResponse.quality,
      size: publicResponse.size,
    });
    pushGatewayRequestLog({
      owner: requestOwner,
      method: request.method,
      endpoint: request.url,
      account: profileLogLabel(responseProfile),
      model: parsed.data.model ?? "gpt-image-2",
      statusCode: 200,
      durationMs,
      source: requestSourceFromUserAgent(request.headers["user-agent"]),
      details: {
        requestId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
        request: requestSummary,
        response: {
          imageCount: publicResponse.data.length,
          outputFormat: publicResponse.output_format,
          quality: publicResponse.quality,
          size: publicResponse.size,
        },
      },
      usage: {
        profile: responseProfile,
        tokenUsage: imageUsageToTokenUsage(publicResponse.usage),
        imageCount: publicResponse.data.length,
        imageRoute: responseImageRoute,
      },
    });
    const savedGeneration = await ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      startedAt: generationStartedAt,
      status: "success",
      endpoint: request.url,
      account: profileLogLabel(responseProfile),
      model: parsed.data.model ?? "gpt-image-2",
      prompt: parsed.data.prompt,
      ratio: ratioFromImageSize(publicResponse.size ?? parsed.data.size),
      size: publicResponse.size ?? parsed.data.size,
      quality: publicResponse.quality ?? parsed.data.quality,
      outputFormat: publicResponse.output_format ?? parsed.data.output_format,
      durationMs,
      request: {
        ...requestSummary,
        prompt: parsed.data.prompt,
      },
      response: publicResponse,
      referenceImages: getImageEditReferenceAssets(parsed.data),
    }).catch((persistError) => {
      console.warn("[gateway:image:edit] failed to persist generation", {
        requestId: request.id,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
      return null;
    });

    return savedGeneration ? { ...publicResponse, _gateway_images: toGatewayImageAssets(savedGeneration.images) } : publicResponse;
  });

  return app;
}
