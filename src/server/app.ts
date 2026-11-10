import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  brotliDecompress,
  gunzip,
  gzip,
  inflate,
  zstdDecompress,
} from "node:zlib";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { Zip, ZipPassThrough } from "fflate";
import sharp from "sharp";
import { z } from "zod";
import { createGatewayContext } from "../core/context.js";
import { DEFAULT_IMAGE_MODEL } from "../core/models/image-models.js";
import type { ChatResult, GatewaySettings, OAuthProfile, ProfileSummary } from "../core/types.js";
import { isTransientHttpError, requestText } from "../core/providers/http-client.js";
import {
  createCodexInBandFailureError,
  extractCodexInBandFailure,
  extractCodexTextDeltaFromSsePayload,
  streamOpenAICodex,
  type CodexInBandFailure,
} from "../core/providers/openai-codex/chat.js";
import { generateChatGPTWebImage, type ChatGPTWebImageResult } from "../core/providers/openai-codex/chatgpt-web-image.js";
import {
  startOpenAICodexRemoteLogin,
  type OpenAICodexRemoteLoginSession,
} from "../core/providers/openai-codex/oauth.js";
import {
  isLlmApiChannelModel,
  listLlmApiChannelModels,
  requestLlmChatCompletion,
  resolveLlmApiChannel,
  streamLlmChatCompletion,
  type LlmApiChannelConfig,
  type LlmChatContentPart,
  type LlmChatMessage,
} from "../core/services/llm-api-channel-service.js";
import type { UsageImageRoute, UsageRecordEvent, UsageTokenStatus, UsageTokenUsage } from "../core/services/usage-service.js";
import {
  WECOM_CALLBACK_PATH,
  buildWecomPassiveReplyXml,
  buildWecomVerifyEcho,
  isWecomCallbackConfigured,
  parseWecomIncomingMessage,
  runWecomCallbackSelfTest,
  type WecomCallbackSettings,
  type WecomIncomingMessage,
} from "../core/services/wecom-callback.js";
import {
  checkWecomPushCredentials,
  notifyWecomImageResult,
  sendWecomImageMessage,
  sendWecomTestMessage,
  sendWecomTextMessage,
  type WecomPushConfig,
} from "../core/services/wecom-message-service.js";
import type { ChatAttachment, ChatConversationDetail, ChatMessage, GatewayUserRole, GenerationHistoryItem } from "../core/services/gateway-database-service.js";
import { getBrandingAssetsDir, getChatAttachmentAssetsDir, getGenerationAssetsDir } from "../core/store/state-paths.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const adminUiDistDir = path.join(packageRoot, "admin-ui", "dist");
const adminUiIndexPath = path.join(adminUiDistDir, "index.html");
const BYTES_PER_MIB = 1024 * 1024;
const MAX_GATEWAY_REQUEST_LOGS = 100;
const MAX_PERSISTED_REQUEST_LOGS = 200;
const MAX_CODEX_RESPONSE_PROFILE_BINDINGS = 5000;
const CHAT_COMPLETIONS_RETIRED_MESSAGE = "chat.completions 接口已下线，请改用 /v1/responses（Codex 透传：/codex/v1/responses）。";
// Workbench replies are user-facing prose, so their request-log preview keeps
// more text than the 300-character default used for API response summaries.
const CHAT_LOG_TEXT_PREVIEW_CHARS = 2000;
const CODEX_STREAM_DRAIN_AFTER_CLIENT_CLOSE_MS = 30_000;
const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ROUTE_BODY_LIMIT_BYTES = 128 * BYTES_PER_MIB;
const CODEX_COMPACT_BODY_LIMIT_BYTES = 256 * BYTES_PER_MIB;
const MAX_CHAT_ATTACHMENTS = 20;
const MAX_CHAT_IMAGE_ATTACHMENT_BYTES = 30 * BYTES_PER_MIB;
const MAX_CHAT_FILE_ATTACHMENT_BYTES = 30 * BYTES_PER_MIB;
const MAX_CHAT_BINARY_ATTACHMENTS_BYTES = 80 * BYTES_PER_MIB;
const MAX_CHAT_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_CHAT_TEXT_ATTACHMENT_CHARS = 512 * 1024;
const MAX_CHAT_MESSAGE_CHARS = 100_000;
const MAX_BRANDING_ASSET_BYTES = 512 * 1024;
const ADMIN_SESSION_COOKIE = "azt_admin_session";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const WECOM_LOGIN_STATE_COOKIE = "azt_wecom_login_state";
const WECOM_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const WECOM_EMBED_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const WECOM_EMBED_COMPLETE_TTL_MS = 60 * 1000;
const GENERATION_IMAGE_ACCEL_PREFIX = process.env.AI_ZERO_TOKEN_GENERATION_IMAGE_ACCEL_PREFIX?.trim() || "";
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
const zstdDecompressAsync = typeof zstdDecompress === "function" ? promisify(zstdDecompress) : null;

/** 内部 app.inject 请求标记：生图完成后不再重复走企微推送（调用方自己推送）。 */
const WECOM_INTERNAL_HEADER = "x-azt-wecom-internal";
const WECOM_CALLBACK_MSG_ID_TTL_MS = 10 * 60 * 1000;
const WECOM_CALLBACK_MSG_ID_SWEEP_MS = 60 * 1000;
const WECOM_CHAT_MAX_PENDING_JOBS = 2;
const WECOM_CHAT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const WECOM_CLASSIFIER_TIMEOUT_MS = 3 * 60 * 1000;
const WECOM_IMAGE_SUBMIT_TIMEOUT_MS = 60 * 1000;
const WECOM_IMAGE_POLL_INTERVAL_MS = 2000;
// 生图 API 渠道单张图实测可能要 4~7 分钟，轮询上限必须比它宽，
// 否则会在任务成功前误报「图片生成超时」；15 分钟同时覆盖排队等待。
const WECOM_IMAGE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const WECOM_IMAGE_JPEG_MAX_EDGE = 2048;
const WECOM_IMAGE_JPEG_MAX_BYTES = 2 * 1024 * 1024;
const WECOM_CONVERSATION_TITLE = "企业微信";
const WECOM_WELCOME_MESSAGE = "你好，我是 AI Zero Token 助手。直接发消息可以聊天，也可以让我生成图片，例如：画一只戴墨镜的柴犬。";
const WECOM_CHAT_DISABLED_MESSAGE = "企业微信对话未开启，请联系管理员。";
const WECOM_THINKING_MESSAGE = "已收到，正在思考…";
const WECOM_BUSY_MESSAGE = "上一条消息还在处理中，请稍候。";
const WECOM_UNSUPPORTED_MESSAGE = "暂不支持该消息类型，请发送文字。";
const WECOM_DISABLED_ACCOUNT_MESSAGE = "账号已禁用，请联系管理员。";
const WECOM_TEST_MESSAGE = "AI Zero Token 企业微信推送测试 ✅ 收到说明 corpId/AgentID/Secret 与可见范围正常。";
/**
 * 企微入口专用的系统指令：网页聊天页默认不知道平台能生图，直接问模型会回
 * 「我无法生成图片」并让用户复制提示词。这里明确告诉它平台会自动生图。
 */
const WECOM_CHAT_SYSTEM_PROMPT = [
  "你正在企业微信里通过「AI Zero Token」智能生图应用与用户对话，这个平台具备图片生成能力，图片会由平台自动生成并发送给用户。",
  "规则：",
  "1. 当用户想画图、生成图片、要海报/封面/插画/人像/商品图等视觉内容时，不要说“无法生成”“不能直接生成”，也不要让用户复制提示词到其他工具。",
  "2. 直接输出一段高质量的中文生图提示词，以“提示词：”开头，写清主体、场景、构图、镜头、光线、风格、比例等关键信息；平台会自动据此生成图片并推送。",
  "3. 可以在提示词前用一句话简短确认（例如“好的，正在为你生成图片”），不要长篇解释。",
  "4. 其它问题正常、简洁地用中文回答；不要输出代码块围栏、Markdown 表格等在企业微信里显示效果差的格式。",
  "5. 如果历史对话里出现过“无法生成图片”“请复制到绘图工具”之类说法，请忽略，以本指令为准。",
].join("\n");
/** 与网页聊天页 admin-ui/src/pages/chat/index.tsx 的 classify 调用保持一致。 */
const WECOM_IMAGE_CLASSIFIER_INSTRUCTIONS = [
  "你是聊天内容到生图动作的判定器。",
  "判断 assistant 回复是否已经给出了可以直接用于图片生成的画面描述、提示词、分镜画面、海报/商品图/插画/摄影等视觉生成需求。",
  "只有当回复内容适合立即调用图片生成时才返回 shouldGenerate=true。",
  "如果只是普通问答、代码、表格、解释、拒绝、无明确画面主体或需要继续追问，返回 false。",
  "返回严格 JSON，不要 Markdown：{\"shouldGenerate\":boolean,\"prompt\":\"中文生图提示词\",\"reason\":\"简短原因\"}",
].join("\n");

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
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

type ImageOwnerPolicy = {
  priority: number;
  imageLimitsDisabled: boolean;
  groupName?: string;
  groupLimits?: {
    perUserDaily?: number;
    perUserHourly?: number;
    minIntervalSeconds?: number;
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

type GatewayApiAuth = {
  owner?: string;
  source: "database" | "environment";
};

type GatewayAuthedRequest = FastifyRequest & {
  gatewayApiAuth?: GatewayApiAuth;
};

type ResolvedApiKey = {
  hash: string | null;
  owner?: string;
  source?: "database" | "environment";
};

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

async function resolveApiKeyAuth(ctx: ReturnType<typeof createGatewayContext>, security: SecurityConfig, bearerToken: string | null): Promise<ResolvedApiKey> {
  if (bearerToken) {
    const bearerHash = hashSecret(bearerToken);
    const user = await ctx.gatewayDatabaseService.getUserByApiKeyHash(bearerHash).catch(() => null);
    if (user) {
      return {
        hash: bearerHash,
        owner: user.username,
        source: "database",
      };
    }
  }
  try {
    const settings = await ctx.configService.getSettings();
    if (settings.security.apiKeyHash) {
      return {
        hash: settings.security.apiKeyHash,
        source: "database",
      };
    }
    return {
      hash: security.apiKeyHash,
      owner: security.adminUser || undefined,
      source: security.apiKeyHash ? "environment" : undefined,
    };
  } catch {
    return {
      hash: security.apiKeyHash,
      owner: security.adminUser || undefined,
      source: security.apiKeyHash ? "environment" : undefined,
    };
  }
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
    pathOnly === WECOM_CALLBACK_PATH ||
    pathOnly.startsWith("/_gateway/branding-assets/") ||
    pathOnly.startsWith("/s/") ||
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
  if (pathOnly === "/_gateway/chats" || pathOnly.startsWith("/_gateway/chats/")) {
    return true;
  }
  if ((method === "GET" || method === "DELETE") && pathOnly === "/_gateway/generations/history") {
    return true;
  }
  if (method === "GET" && pathOnly === "/_gateway/generations/report") {
    return true;
  }
  if (method === "GET" && pathOnly.startsWith("/_gateway/generations/history/")) {
    return true;
  }
  if (method === "PUT" && pathOnly === "/_gateway/admin/settings") {
    return true;
  }
  if (method === "GET" && pathOnly.startsWith("/_gateway/generations/images/")) {
    return true;
  }
  if (method === "GET" && pathOnly.startsWith("/_gateway/chat-attachments/")) {
    return true;
  }
  return false;
}

function isApiPath(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "/";
  return pathOnly.startsWith("/v1/") ||
    pathOnly.startsWith("/codex/v1/") ||
    pathOnly.startsWith("/_gateway/generations/history/") ||
    pathOnly.startsWith("/_gateway/generations/images/") ||
    pathOnly.startsWith("/_gateway/chat-attachments/");
}

function acceptsGzip(request: FastifyRequest): boolean {
  const encoding = request.headers["accept-encoding"];
  return typeof encoding === "string" && /\bgzip\b/i.test(encoding);
}

function shouldCompressReply(reply: FastifyReply, payload: unknown): payload is string | Buffer {
  if (!(typeof payload === "string" || Buffer.isBuffer(payload))) {
    return false;
  }
  if (reply.getHeader("content-encoding")) {
    return false;
  }
  const contentType = String(reply.getHeader("content-type") ?? "");
  if (!/application\/json|text\/|javascript|svg/i.test(contentType)) {
    return false;
  }
  const size = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
  return size >= 1024;
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

function resolveGenerationImageFile(imagePath: string): { filePath: string; generationId: string } | null {
  const normalized = path.normalize(imagePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = getGenerationAssetsDir();
  const filePath = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (!filePath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }
  return {
    filePath,
    generationId: normalized.split(path.sep)[0] || normalized.split("/")[0] || "",
  };
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatShareTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

const SHARE_PAGE_STYLE = `
  :root { color-scheme: light dark; --card-bg: #fff; --border-color: #e5e6eb; --muted: #8a9099; --link: #3370ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: #f4f5f7; color: #1f2329; }
  main { max-width: 880px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .hint { font-size: 12px; color: var(--muted); }
  .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 14px; padding: 18px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
  .images { display: grid; gap: 12px; }
  figure { margin: 0; }
  img { width: 100%; height: auto; display: block; border-radius: 10px; background: #f2f3f5; -webkit-touch-callout: default; -webkit-user-select: auto; user-select: auto; }
  .image-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
  .image-actions a, .image-actions button { font: inherit; font-size: 13px; color: var(--link); background: none; border: 0; padding: 4px 2px; cursor: pointer; text-decoration: none; -webkit-tap-highlight-color: transparent; }
  .note { margin: 12px 0 0; font-size: 13px; color: var(--muted); }
  .touch-hint { display: none; }
  @media (hover: none) { .touch-hint { display: block; } }
  img.is-save-target { animation: save-pulse 1.2s ease-out 2; outline: 3px solid rgba(51, 112, 255, 0.55); outline-offset: 3px; }
  @keyframes save-pulse { 0% { outline-offset: 3px; } 50% { outline-offset: 8px; } 100% { outline-offset: 3px; } }
  .prompt-block { margin-top: 16px; border-top: 1px solid var(--border-color); padding-top: 14px; }
  .prompt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .prompt-title { font-size: 13px; font-weight: 600; color: #4e5969; }
  .prompt-copy { font: inherit; font-size: 13px; color: var(--link); background: #f2f6ff; border: 0; border-radius: 999px; padding: 4px 12px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .prompt-copy:active { opacity: 0.7; }
  .prompt-wrap { position: relative; }
  .prompt { margin: 0; font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .prompt-wrap.is-collapsed .prompt { max-height: 32em; overflow: hidden; }
  .prompt-wrap.is-collapsed::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 48px; background: linear-gradient(to bottom, rgba(255, 255, 255, 0), var(--card-bg)); pointer-events: none; }
  .prompt-toggle { display: inline-block; margin-top: 6px; font: inherit; font-size: 13px; color: var(--link); background: none; border: 0; padding: 4px 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .meta { margin: 16px 0 0; font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px 16px; }
  @media (prefers-color-scheme: dark) {
    :root { --card-bg: #1f2023; --border-color: #2f3136; --muted: #9aa0a6; }
    body { background: #17181a; color: #e8eaed; }
    .card { background: var(--card-bg); }
    img { background: #26282c; }
    .prompt-title { color: #c9cdd4; }
    .prompt-copy { background: rgba(51, 112, 255, 0.16); }
    .prompt-wrap.is-collapsed::after { background: linear-gradient(to bottom, rgba(31, 32, 35, 0), var(--card-bg)); }
  }
`;

function renderImageSharePage(params: {
  item: GenerationHistoryItem;
  token: string;
}): string {
  const { item, token } = params;
  const images = item.images
    .map((image, index) => {
      const src = `/s/${encodeURIComponent(token)}/image/${index}`;
      const width = image.width ? ` width="${image.width}"` : "";
      const height = image.height ? ` height="${image.height}"` : "";
      const name = escapeHtmlText(image.filename || `ai-image-${index + 1}.png`);
      return `<figure><img loading="lazy" src="${src}" alt="生成图片 ${index + 1}"${width}${height} decoding="async" /><div class="image-actions"><button type="button" data-save="${escapeHtmlText(src)}" data-name="${name}">保存图片</button></div></figure>`;
    })
    .join("");
  const meta = [
    item.model,
    item.size,
    item.outputFormat ? item.outputFormat.toUpperCase() : "",
    formatShareTimestamp(item.createdAt),
  ].filter((text): text is string => Boolean(text)).map((text) => `<span>${escapeHtmlText(text)}</span>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>图片分享 · AI Zero Token</title>
<style>${SHARE_PAGE_STYLE}</style>
<noscript><style>.prompt-wrap.is-collapsed .prompt { max-height: none; overflow: visible; } .prompt-wrap.is-collapsed::after { display: none; } .prompt-toggle { display: none; }</style></noscript>
</head>
<body>
<main>
  <header><h1>图片分享</h1><span class="hint">免登录查看</span></header>
  <section class="card">
    <div class="images">${images}</div>
    <p class="note touch-hint">手机上长按图片即可保存到相册</p>
    <p class="note" id="share-note" hidden></p>
    <div class="prompt-block">
      <div class="prompt-head">
        <span class="prompt-title">提示词</span>
        <button type="button" class="prompt-copy" data-copy-prompt>复制提示词</button>
      </div>
      <div class="prompt-wrap is-collapsed" id="prompt-wrap">
        <p class="prompt" id="prompt-text">${escapeHtmlText(item.prompt)}</p>
      </div>
      <button type="button" class="prompt-toggle" data-toggle-prompt aria-expanded="false" aria-controls="prompt-text" hidden>展开全部</button>
    </div>
    <p class="meta">${meta}</p>
  </section>
</main>
<script>
(function () {
  var note = document.getElementById("share-note");
  var timer = 0;
  function showNote(text) {
    if (!note) return;
    note.textContent = text;
    note.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { note.hidden = true; }, 4000);
  }

  // 提示词：默认只显示 20 行，超出时才出现展开按钮；复制按钮复制完整提示词。
  var promptWrap = document.getElementById("prompt-wrap");
  var promptText = document.getElementById("prompt-text");
  var toggleButton = document.querySelector("[data-toggle-prompt]");
  var copyButton = document.querySelector("[data-copy-prompt]");
  var copyTimer = 0;
  var expanded = false;

  function promptLineHeight() {
    if (!promptText) return 24;
    var style = window.getComputedStyle(promptText);
    var lineHeight = parseFloat(style.lineHeight);
    if (lineHeight && !isNaN(lineHeight)) return lineHeight;
    return (parseFloat(style.fontSize) || 15) * 1.6;
  }

  function updatePromptUi() {
    if (!promptWrap || !promptText || !toggleButton) return;
    var overflowing = promptText.scrollHeight > promptLineHeight() * 20 + 1;
    if (!overflowing) expanded = false;
    toggleButton.hidden = !overflowing;
    if (overflowing && !expanded) {
      promptWrap.classList.add("is-collapsed");
    } else {
      promptWrap.classList.remove("is-collapsed");
    }
    toggleButton.textContent = expanded ? "收起提示词" : "展开全部";
    toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function copyText(text, onSuccess, onFailure) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(onSuccess, function () { legacyCopy(text, onSuccess, onFailure); });
      return;
    }
    legacyCopy(text, onSuccess, onFailure);
  }

  function legacyCopy(text, onSuccess, onFailure) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    area.remove();
    if (copied) onSuccess(); else onFailure();
  }

  if (copyButton) {
    copyButton.addEventListener("click", function () {
      if (!promptText) return;
      copyText(promptText.textContent || "", function () {
        copyButton.textContent = "已复制";
        window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(function () { copyButton.textContent = "复制提示词"; }, 2000);
        showNote("提示词已复制");
      }, function () {
        showNote("复制失败，请长按文字手动复制");
      });
    });
  }

  if (toggleButton) {
    toggleButton.addEventListener("click", function () {
      expanded = !expanded;
      updatePromptUi();
      if (!expanded && promptWrap) {
        promptWrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  updatePromptUi();
  window.addEventListener("resize", updatePromptUi);

  var isWechat = /MicroMessenger|wxwork/i.test(navigator.userAgent);
  document.addEventListener("click", function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest("[data-save]") : null;
    if (!button) return;
    event.preventDefault();
    var src = button.getAttribute("data-save");
    var name = button.getAttribute("data-name") || "ai-image.png";
    if (!src) return;
    function highlight() {
      var img = button.closest("figure") && button.closest("figure").querySelector("img");
      if (img) {
        img.classList.remove("is-save-target");
        void img.offsetWidth;
        img.classList.add("is-save-target");
        img.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      showNote("长按图片即可保存到相册");
    }
    if (isWechat) {
      // 微信 / 企微内核不支持网页下载，点击 download 会直接跳转到图片页，只能长按保存。
      highlight();
      return;
    }
    fetch(src, { credentials: "same-origin" }).then(function (response) {
      if (!response.ok) throw new Error("image request failed");
      return response.blob();
    }).then(function (blob) {
      var file = new File([blob], name, { type: blob.type || "image/png" });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: name });
      }
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      showNote("图片已开始下载");
      return null;
    }).catch(function () {
      showNote("保存失败，请长按图片保存");
    });
  });
})();
</script>
</body>
</html>`;
}

function renderImageShareMissingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>分享链接不可用</title>
<style>${SHARE_PAGE_STYLE}</style>
</head>
<body>
<main><section class="card"><p class="prompt">这个分享链接不存在或已失效。</p></section></main>
</body>
</html>`;
}

function generationImageAccelRedirect(filePath: string): string | null {
  if (!GENERATION_IMAGE_ACCEL_PREFIX) {
    return null;
  }
  const rootPath = path.resolve(getGenerationAssetsDir());
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }
  const relativePath = path.relative(rootPath, resolvedFilePath).split(path.sep).map(encodeURIComponent).join("/");
  return `${GENERATION_IMAGE_ACCEL_PREFIX.replace(/\/+$/, "")}/${relativePath}`;
}

function resolveChatAttachmentFile(imagePath: string): { filePath: string; conversationId: string } | null {
  const normalized = path.normalize(imagePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = getChatAttachmentAssetsDir();
  const filePath = path.resolve(root, normalized);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return {
    filePath,
    conversationId: normalized.split(path.sep)[0] || normalized.split("/")[0] || "",
  };
}

async function chatAttachmentDataUrl(attachment: ChatAttachment): Promise<string | undefined> {
  if (attachment.dataUrl) {
    return attachment.dataUrl;
  }
  if (!attachment.path) {
    return undefined;
  }
  const file = resolveChatAttachmentFile(attachment.path);
  if (!file) {
    return undefined;
  }
  try {
    const data = await fs.readFile(file.filePath);
    return `data:${attachment.mimeType || getContentType(file.filePath)};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

type ChatExportAttachmentSource =
  | { type: "buffer"; data: Buffer }
  | { type: "file"; filePath: string };

type ChatExportAttachment = {
  messageId: string;
  attachmentId: string;
  originalName: string;
  archivePath: string;
  kind: ChatAttachment["kind"];
  mimeType: string;
  declaredSize: number;
  actualSize?: number;
  status: "included" | "missing" | "partial";
  reason?: string;
  source?: ChatExportAttachmentSource;
};

type ChatExportPlan = {
  exportedAt: string;
  attachments: ChatExportAttachment[];
};

function sanitizeChatExportFileName(value: string, fallback: string): string {
  const normalized = path.basename(value.replace(/[\\/]+/g, "_")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  const safe = normalized.replace(/[. ]+$/g, "") || fallback;
  if (safe.length <= 180) {
    return safe;
  }
  const extension = path.extname(safe).slice(0, 20);
  return `${safe.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

function uniqueChatExportPath(basePath: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath);
    return basePath;
  }
  const extension = path.posix.extname(basePath);
  const stem = basePath.slice(0, basePath.length - extension.length);
  let index = 2;
  while (usedPaths.has(`${stem}-${index}${extension}`)) {
    index += 1;
  }
  const candidate = `${stem}-${index}${extension}`;
  usedPaths.add(candidate);
  return candidate;
}

async function prepareChatExport(conversation: ChatConversationDetail): Promise<ChatExportPlan> {
  const usedPaths = new Set<string>();
  const attachments: ChatExportAttachment[] = [];

  for (let messageIndex = 0; messageIndex < conversation.messages.length; messageIndex += 1) {
    const message = conversation.messages[messageIndex];
    const folder = `attachments/${String(messageIndex + 1).padStart(3, "0")}-${message.role}`;
    for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex += 1) {
      const attachment = message.attachments[attachmentIndex];
      const fallbackName = `attachment-${attachmentIndex + 1}${attachment.kind === "text" ? ".txt" : ".bin"}`;
      const archivePath = uniqueChatExportPath(
        `${folder}/${sanitizeChatExportFileName(attachment.name, fallbackName)}`,
        usedPaths,
      );
      const item: ChatExportAttachment = {
        messageId: message.id,
        attachmentId: attachment.id,
        originalName: attachment.name || fallbackName,
        archivePath,
        kind: attachment.kind,
        mimeType: attachment.mimeType || "application/octet-stream",
        declaredSize: attachment.size,
        status: "included",
      };

      if (attachment.kind === "text") {
        if (typeof attachment.text === "string") {
          const data = Buffer.from(attachment.text, "utf8");
          item.source = { type: "buffer", data };
          item.actualSize = data.byteLength;
        } else {
          item.status = "missing";
          item.reason = "历史记录中未保存文本附件内容。";
        }
      } else if (attachment.path) {
        const file = resolveChatAttachmentFile(attachment.path);
        if (!file || file.conversationId !== conversation.id) {
          item.status = "missing";
          item.reason = "附件路径无效。";
        } else {
          try {
            const stats = await fs.stat(file.filePath);
            if (!stats.isFile()) {
              throw new Error("附件不是普通文件。");
            }
            item.source = { type: "file", filePath: file.filePath };
            item.actualSize = stats.size;
          } catch (error) {
            item.status = "missing";
            item.reason = error instanceof Error ? error.message : "附件文件不存在。";
          }
        }
      } else if (attachment.dataUrl) {
        const parsed = parseDataUrl(attachment.dataUrl);
        if (parsed) {
          item.source = { type: "buffer", data: parsed.data };
          item.actualSize = parsed.data.byteLength;
        } else {
          item.status = "missing";
          item.reason = "附件数据格式无效。";
        }
      } else {
        item.status = "missing";
        item.reason = "历史记录中未保存附件文件。";
      }
      attachments.push(item);
    }
  }

  return { exportedAt: new Date().toISOString(), attachments };
}

function chatExportMarkdown(conversation: ChatConversationDetail, plan: ChatExportPlan): string {
  const attachmentByMessage = new Map<string, ChatExportAttachment[]>();
  for (const attachment of plan.attachments) {
    const items = attachmentByMessage.get(attachment.messageId) ?? [];
    items.push(attachment);
    attachmentByMessage.set(attachment.messageId, items);
  }
  const lines = [
    `# ${conversation.title}`,
    "",
    `- 会话 ID: \`${conversation.id}\``,
    `- 模型: ${conversation.model || "-"}`,
    `- 创建时间: ${new Date(conversation.createdAt).toISOString()}`,
    `- 导出时间: ${plan.exportedAt}`,
    `- 消息数量: ${conversation.messages.length}`,
    "",
  ];

  conversation.messages.forEach((message, index) => {
    lines.push(`## ${index + 1}. ${message.role === "assistant" ? "助手" : "用户"}`);
    lines.push("");
    lines.push(`- 时间: ${new Date(message.createdAt).toISOString()}`);
    lines.push(`- 状态: ${message.status}`);
    if (message.model) {
      lines.push(`- 模型: ${message.model}`);
    }
    if (message.error) {
      lines.push(`- 错误: ${message.error}`);
    }
    const messageAttachments = attachmentByMessage.get(message.id) ?? [];
    if (messageAttachments.length > 0) {
      lines.push("- 附件:");
      for (const attachment of messageAttachments) {
        const label = attachment.originalName.replace(/[\[\]]/g, "\\$&");
        const target = attachment.archivePath.split("/").map(encodeURIComponent).join("/");
        lines.push(attachment.status === "included"
          ? `  - [${label}](${target})`
          : `  - ${label}（未导出: ${attachment.reason || "文件不可用"}）`);
      }
    }
    lines.push("");
    lines.push(message.content || "_（无文本内容）_");
    lines.push("");
    lines.push("---", "");
  });
  return `${lines.join("\n")}\n`;
}

function chatExportJson(conversation: ChatConversationDetail, plan: ChatExportPlan): Record<string, unknown> {
  return {
    exportVersion: 1,
    exportedAt: plan.exportedAt,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    },
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      model: message.model,
      error: message.error,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      attachments: plan.attachments
        .filter((attachment) => attachment.messageId === message.id)
        .map(({ source: _source, ...attachment }) => attachment),
    })),
  };
}

function createChatExportZipStream(conversation: ChatConversationDetail, plan: ChatExportPlan): Readable {
  const output = new PassThrough();
  let drainPromise: Promise<void> | null = null;
  const zip = new Zip((error, data, final) => {
    if (error) {
      output.destroy(error);
      return;
    }
    if (final) {
      output.end(Buffer.from(data));
      return;
    }
    if (data.byteLength > 0 && !output.write(Buffer.from(data)) && !drainPromise) {
      drainPromise = new Promise((resolve) => {
        const done = () => {
          output.off("drain", done);
          output.off("close", done);
          resolve();
        };
        output.once("drain", done);
        output.once("close", done);
      });
    }
  });

  async function waitForDrain(): Promise<void> {
    if (drainPromise) {
      await drainPromise;
      drainPromise = null;
    }
    if (output.destroyed) {
      throw new Error("导出连接已关闭。");
    }
  }

  async function addBuffer(filename: string, data: Buffer): Promise<void> {
    const entry = new ZipPassThrough(filename);
    zip.add(entry);
    entry.push(data, true);
    await waitForDrain();
  }

  async function addFile(item: ChatExportAttachment, filePath: string): Promise<void> {
    const entry = new ZipPassThrough(item.archivePath);
    zip.add(entry);
    try {
      for await (const chunk of createReadStream(filePath)) {
        entry.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false);
        await waitForDrain();
      }
      entry.push(new Uint8Array(), true);
      await waitForDrain();
    } catch (error) {
      entry.push(new Uint8Array(), true);
      item.status = "partial";
      item.reason = error instanceof Error ? error.message : "读取附件失败。";
    }
  }

  output.once("close", () => {
    if (!output.readableEnded) {
      zip.terminate();
    }
  });

  void (async () => {
    try {
      await addBuffer("conversation.md", Buffer.from(chatExportMarkdown(conversation, plan), "utf8"));
      for (const attachment of plan.attachments) {
        if (!attachment.source || attachment.status !== "included") {
          continue;
        }
        if (attachment.source.type === "buffer") {
          await addBuffer(attachment.archivePath, attachment.source.data);
        } else {
          await addFile(attachment, attachment.source.filePath);
        }
      }
      await addBuffer("conversation.json", Buffer.from(`${JSON.stringify(chatExportJson(conversation, plan), null, 2)}\n`, "utf8"));
      await addBuffer("manifest.json", Buffer.from(`${JSON.stringify({
        exportVersion: 1,
        exportedAt: plan.exportedAt,
        conversationId: conversation.id,
        attachmentCount: plan.attachments.length,
        includedAttachmentCount: plan.attachments.filter((item) => item.status === "included").length,
        attachments: plan.attachments.map(({ source: _source, ...attachment }) => attachment),
      }, null, 2)}\n`, "utf8"));
      zip.end();
    } catch (error) {
      zip.terminate();
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return output;
}

function chatExportDownloadName(conversation: ChatConversationDetail): string {
  const title = sanitizeChatExportFileName(conversation.title, "conversation").replace(/\.zip$/i, "").slice(0, 80);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${title}-${date}.zip`;
}

function encodeContentDispositionFileName(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
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

function normalizeEncodedAdminHashRoute(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }

  if (!/^#\/?[a-z0-9][a-z0-9-]*$/i.test(decoded)) {
    return null;
  }
  return `/#${decoded.replace(/^#\/?/, "")}`;
}

function sanitizeAssetFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "branding-asset";
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl.trim());
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1].toLowerCase(),
    data: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
  };
}

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function normalizeBrandingAssetMime(filename: string, mimeType: string): string {
  if (mimeType) {
    return mimeType;
  }
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".ico") {
    return "image/x-icon";
  }
  return "";
}

function brandingAssetExtension(kind: "app-icon" | "favicon", filename: string, mimeType: string): ".svg" | ".ico" | null {
  const extension = path.extname(filename).toLowerCase();
  const normalizedMimeType = normalizeBrandingAssetMime(filename, mimeType);
  if (kind === "app-icon" && extension === ".svg" && normalizedMimeType === "image/svg+xml") {
    return ".svg";
  }
  if (
    kind === "favicon" &&
    extension === ".ico" &&
    (normalizedMimeType === "image/x-icon" || normalizedMimeType === "image/vnd.microsoft.icon" || normalizedMimeType === "image/ico" || normalizedMimeType === "application/octet-stream")
  ) {
    return ".ico";
  }
  return null;
}

async function saveBrandingAsset(params: { kind: "app-icon" | "favicon"; filename: string; dataUrl: string }): Promise<{ url: string; filename: string; mimeType: string; size: number }> {
  const parsed = parseDataUrl(params.dataUrl);
  if (!parsed || parsed.data.length === 0) {
    throw createHttpError("上传文件格式无效，请选择 SVG 或 ICO 文件。", 400);
  }
  if (parsed.data.length > MAX_BRANDING_ASSET_BYTES) {
    throw createHttpError(`上传文件过大，请控制在 ${Math.round(MAX_BRANDING_ASSET_BYTES / 1024)} KB 内。`, 413);
  }

  const extension = brandingAssetExtension(params.kind, params.filename, parsed.mimeType);
  if (!extension) {
    throw createHttpError(params.kind === "app-icon" ? "设置图标只支持 SVG 文件。" : "网站 favicon 只支持 ICO 文件。", 400);
  }

  const directory = path.join(getBrandingAssetsDir(), params.kind);
  await fs.mkdir(directory, { recursive: true });
  const safeName = sanitizeAssetFilename(params.filename).replace(/\.[^.]+$/u, "");
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}${extension}`;
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, parsed.data);
  return {
    url: `/_gateway/branding-assets/${params.kind}/${encodeURIComponent(filename)}`,
    filename,
    mimeType: extension === ".svg" ? "image/svg+xml" : "image/x-icon",
    size: parsed.data.length,
  };
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

const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Query strings are always strings here, so "false" must not coerce to true. */
const booleanQueryParam = z.preprocess((value) => {
  if (typeof value === "string") {
    return !["false", "0", "no", "off", ""].includes(value.trim().toLowerCase());
  }
  return value;
}, z.boolean().optional());

const wecomCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  embed: booleanQueryParam,
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
  groupId: z.string().trim().min(1).optional(),
});

const gatewayUserUpdateSchema = z.object({
  password: z.string().min(6).max(200).optional(),
  role: z.enum(["admin", "user"]).optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  disabled: z.boolean().optional(),
});

const wecomContactImportSchema = z.object({
  groupId: z.string().trim().min(1).nullable().optional(),
  contacts: z
    .array(z.object({
      userId: z.string().trim().min(1).max(120),
      displayName: z.string().trim().min(1).max(120),
    }))
    .min(1)
    .max(5000),
});

const brandingAssetUploadSchema = z.object({
  kind: z.enum(["app-icon", "favicon"]),
  filename: z.string().trim().min(1).max(160),
  dataUrl: z.string().min(1),
});

const gatewayUserParamsSchema = z.object({
  id: z.string().min(1),
});

const gatewayUserGroupCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
  imageLimitsDisabled: z.boolean().default(false),
  perUserDaily: z.number().int().min(0).max(100_000).nullable().optional(),
  perUserHourly: z.number().int().min(0).max(100_000).nullable().optional(),
  minIntervalSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
});

const gatewayUserGroupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).optional(),
  imageLimitsDisabled: z.boolean().optional(),
  perUserDaily: z.number().int().min(0).max(100_000).nullable().optional(),
  perUserHourly: z.number().int().min(0).max(100_000).nullable().optional(),
  minIntervalSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
});

const gatewayUserGroupParamsSchema = z.object({
  id: z.string().min(1),
});

const settingsUpdateSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  modelRouting: z
    .object({
      chatModel: z.string().trim().min(1).optional(),
      imageClassifierModel: z.string().trim().min(1).optional(),
      imageGenerationModel: z.string().trim().min(1).optional(),
      imageOrchestratorModel: z.string().trim().min(1).optional(),
      promptOptimizerModel: z.string().trim().min(1).optional(),
    })
    .optional(),
  branding: z
    .object({
      title: z.string().trim().min(1).max(80).optional(),
      appIconUrl: z.string().trim().max(500).optional(),
      faviconUrl: z.string().trim().max(500).optional(),
    })
    .optional(),
  security: z
    .object({
      apiKey: z.string().trim().min(12).max(200).optional(),
      clearApiKey: z.boolean().optional(),
    })
    .optional(),
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
      generationTimeoutMs: z.number().int().min(60_000).max(30 * 60 * 1000).optional(),
      promptOptimizerSystemPrompt: z.string().trim().min(1).max(8000).optional(),
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
      apiChannel: z
        .object({
          enabled: z.boolean().optional(),
          mode: z.enum(["primary", "fallback"]).optional(),
          baseUrl: z.string().max(500).optional(),
          apiKey: z.string().max(500).optional(),
          model: z.string().trim().max(120).optional(),
        })
        .optional(),
    })
    .optional(),
  llm: z
    .object({
      apiChannel: z
        .object({
          enabled: z.boolean().optional(),
          mode: z.enum(["primary", "fallback"]).optional(),
          baseUrl: z.string().max(500).optional(),
          apiKey: z.string().max(500).optional(),
          model: z.string().trim().max(200).optional(),
          models: z.array(z.string().trim().max(200)).max(200).optional(),
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
      notifyImageResult: z.boolean().optional(),
      callbackToken: z.string().max(64).optional(),
      callbackAesKey: z.string().max(64).optional(),
      chatEnabled: z.boolean().optional(),
    })
    .optional(),
  server: z
    .object({
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
});

const wecomTestMessageSchema = z.object({
  userId: z.string().trim().min(1).max(64),
});

const llmChannelTestSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  model: z.string().trim().max(200).optional(),
});

const llmChannelModelsSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
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
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  owner: z.string().min(1).max(120).optional(),
  query: z.string().trim().max(500).optional(),
  status: z.enum(["queued", "running", "success", "failed", "interrupted"]).optional(),
  startTime: z.coerce.number().int().nonnegative().optional(),
  endTime: z.coerce.number().int().nonnegative().optional(),
  light: booleanQueryParam,
});

const generationReportQuerySchema = z.object({
  owner: z.string().min(1).max(120).optional(),
  startTime: z.coerce.number().int().nonnegative().optional(),
  endTime: z.coerce.number().int().nonnegative().optional(),
});

const chatListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const chatDetailQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).max(200).optional(),
  beforeMessageId: z.string().min(1).optional(),
});

const chatConversationBodySchema = z.object({
  title: z.string().max(80).optional(),
  model: z.string().min(1).optional(),
});

const chatConversationPatchSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  model: z.string().min(1).optional(),
});

function estimateBase64Bytes(value: string): number {
  const base64 = value.trim().split(",", 2)[1] ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function normalizeGenerationTimeRange(startTime?: number, endTime?: number): { startTime?: number; endTime?: number } {
  const normalize = (value: number | undefined): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    const truncated = Math.trunc(value);
    return Number.isSafeInteger(truncated) ? truncated : undefined;
  };
  const normalizedStart = normalize(startTime);
  const normalizedEnd = normalize(endTime);
  if (normalizedStart !== undefined && normalizedEnd !== undefined && normalizedStart > normalizedEnd) {
    return { startTime: normalizedEnd, endTime: normalizedStart };
  }
  return { startTime: normalizedStart, endTime: normalizedEnd };
}

const chatFileMimeTypesByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const chatAttachmentSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    kind: z.enum(["image", "text", "file"]),
    name: z.string().trim().min(1).max(220),
    mimeType: z.string().trim().min(1).max(160),
    size: z.number().int().min(0).max(MAX_CHAT_IMAGE_ATTACHMENT_BYTES),
    dataUrl: z.string().optional(),
    text: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "image") {
      if (!value.mimeType.startsWith("image/")) {
        ctx.addIssue({ code: "custom", message: "图片附件的 MIME 类型必须是 image/*。" });
      }
      if (!value.dataUrl || !/^data:image\/[^;,]+;base64,/i.test(value.dataUrl.trim())) {
        ctx.addIssue({ code: "custom", message: "图片附件必须提供 base64 data URL。" });
      }
      if (value.size > MAX_CHAT_IMAGE_ATTACHMENT_BYTES || (value.dataUrl && estimateBase64Bytes(value.dataUrl) > MAX_CHAT_IMAGE_ATTACHMENT_BYTES)) {
        ctx.addIssue({ code: "custom", message: "单个图片附件不能超过 30 MiB。" });
      }
      return;
    }

    if (value.kind === "file") {
      const expectedMimeType = chatFileMimeTypesByExtension[path.extname(value.name).toLowerCase()];
      if (!expectedMimeType) {
        ctx.addIssue({ code: "custom", message: "原生文件附件只支持 PDF、DOCX、PPTX 和 XLSX。" });
        return;
      }
      if (value.mimeType !== expectedMimeType) {
        ctx.addIssue({ code: "custom", message: "文件附件的 MIME 类型与扩展名不匹配。" });
      }
      if (!value.dataUrl || !value.dataUrl.startsWith(`data:${expectedMimeType};base64,`)) {
        ctx.addIssue({ code: "custom", message: "文件附件必须提供匹配格式的 base64 data URL。" });
      }
      if (value.size > MAX_CHAT_FILE_ATTACHMENT_BYTES || (value.dataUrl && estimateBase64Bytes(value.dataUrl) > MAX_CHAT_FILE_ATTACHMENT_BYTES)) {
        ctx.addIssue({ code: "custom", message: "单个文件附件不能超过 30 MiB。" });
      }
      return;
    }

    if (value.size > MAX_CHAT_TEXT_ATTACHMENT_BYTES || (typeof value.text === "string" && Buffer.byteLength(value.text, "utf8") > MAX_CHAT_TEXT_ATTACHMENT_BYTES)) {
      ctx.addIssue({ code: "custom", message: "单个文本附件不能超过 512 KiB。" });
    }
    if (typeof value.text !== "string" || value.text.length === 0) {
      ctx.addIssue({ code: "custom", message: "文本附件必须提供文件内容。" });
    } else if (value.text.length > MAX_CHAT_TEXT_ATTACHMENT_CHARS) {
      ctx.addIssue({ code: "custom", message: "单个文本附件内容不能超过 512 KiB。" });
    }
  });

const chatAttachmentsSchema = z
  .array(chatAttachmentSchema)
  .max(MAX_CHAT_ATTACHMENTS)
  .superRefine((attachments, ctx) => {
    const totalBytes = attachments.reduce((total, attachment) => {
      if (attachment.kind !== "image" && attachment.kind !== "file") {
        return total;
      }
      const encodedBytes = attachment.dataUrl ? estimateBase64Bytes(attachment.dataUrl) : 0;
      return total + Math.max(attachment.size, encodedBytes);
    }, 0);
    if (totalBytes > MAX_CHAT_BINARY_ATTACHMENTS_BYTES) {
      ctx.addIssue({ code: "custom", message: "每条消息的图片和原生文件附件合计不能超过 80 MiB。" });
    }
  });

const chatMessageStreamBodySchema = z.object({
  content: z.string().trim().max(MAX_CHAT_MESSAGE_CHARS),
  model: z.string().min(1).optional(),
  attachments: chatAttachmentsSchema.optional(),
  /** 可选的系统指令：企业微信等非网页入口用它告诉模型当前平台支持生图。 */
  system: z.string().trim().max(8000).optional(),
}).refine((value) => value.content.length > 0 || (value.attachments?.length ?? 0) > 0, {
  message: "消息内容或附件至少需要提供一个。",
});

const chatMessageRetryStreamBodySchema = z.object({
  model: z.string().min(1).optional(),
});

const chatMessageRewriteStreamBodySchema = z.object({
  content: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
  model: z.string().min(1).optional(),
});

const chatMessageImageGenerationBodySchema = z.object({
  historyId: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
});

const requestLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  owner: z.string().min(1).max(120).optional(),
});

const gatewayUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const imageGenerationsBodySchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    n: z.number().int().positive().max(10).optional(),
    quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    size: z.string().min(1).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "webp", "jpeg"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z.enum(["b64_json", "url"]).optional(),
    user: z.string().optional(),
    _gateway_background: z.boolean().optional(),
    _gateway_webhook_url: z.string().trim().url().max(1000).optional(),
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
    n: z.number().int().positive().max(10).optional(),
    quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    size: z.string().min(1).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "webp", "jpeg"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z.enum(["b64_json", "url"]).optional(),
    user: z.string().optional(),
    _gateway_background: z.boolean().optional(),
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

/**
 * 生图请求实际会走哪条上游路径。API 渠道为主渠道时优先记 api-channel，
 * 成功响应还会用返回值里的 _gatewayImageRoute 覆盖（比如渠道失败回退到 Codex 的情况）。
 */
function resolveUsageImageRoute(settings: GatewaySettings, profile: OAuthProfile | null | undefined): UsageImageRoute {
  const channel = settings.image.apiChannel;
  if (channel?.enabled && channel.mode === "primary") {
    return "api-channel";
  }
  return profile && isFreePlan(profile) && settings.image.freeAccountWebGenerationEnabled ? "chatgpt-web" : "codex-tool";
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

function truncateForLog(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
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
    imageModel: typeof imageTool?.model === "string" && imageTool.model.trim() ? imageTool.model.trim() : DEFAULT_IMAGE_MODEL,
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
    data: (await ctx.modelService.listAvailableModels()).map((model) => ({
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

function buildGatewayChatText(message: ChatMessage): string {
  const textAttachments = message.attachments.filter((item) => item.kind === "text" && typeof item.text === "string");
  if (textAttachments.length === 0) {
    return message.content;
  }

  const sections = [message.content.trim()].filter(Boolean);
  for (const attachment of textAttachments) {
    sections.push([
      `附件: ${attachment.name}`,
      `类型: ${attachment.mimeType || "text/plain"}`,
      `大小: ${attachment.size} bytes`,
      "",
      attachment.text ?? "",
    ].join("\n"));
  }
  return sections.join("\n\n---\n\n");
}

async function createGatewayChatContentParts(message: ChatMessage): Promise<Array<Record<string, unknown>>> {
  if (message.role === "assistant") {
    return [
      {
        type: "output_text",
        text: message.content,
      },
    ];
  }

  const parts: Array<Record<string, unknown>> = [];
  const text = buildGatewayChatText(message).trim();
  if (text) {
    parts.push({ type: "input_text", text });
  }

  const binaryAttachments = message.attachments.filter((item) => (item.kind === "image" || item.kind === "file") && (item.dataUrl || item.path));
  if (!text && binaryAttachments.length > 0) {
    parts.push({ type: "input_text", text: "请根据附件内容回复。" });
  }
  for (const attachment of binaryAttachments) {
    const dataUrl = await chatAttachmentDataUrl(attachment);
    if (!dataUrl) {
      continue;
    }
    if (attachment.kind === "image") {
      parts.push({
        type: "input_image",
        image_url: dataUrl,
      });
    } else {
      parts.push({
        type: "input_file",
        filename: attachment.name,
        file_data: dataUrl,
      });
    }
  }

  if (parts.length === 0) {
    parts.push({ type: "input_text", text: "" });
  }
  return parts;
}

async function createGatewayChatCodexBody(params: {
  model: string;
  messages: ChatMessage[];
  system?: string;
}): Promise<Record<string, unknown>> {
  return {
    model: params.model,
    store: false,
    stream: true,
    instructions: params.system?.trim() ?? "",
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    input: await Promise.all(params.messages.map(async (message) => ({
      role: message.role,
      content: await createGatewayChatContentParts(message),
    }))),
  };
}

/** 文件附件统一用 OpenAI 兼容的 file 内容块（base64 data URL）转发，由上游模型解析。 */
async function buildLlmFileAttachmentParts(attachment: ChatAttachment): Promise<LlmChatContentPart[]> {
  const dataUrl = await chatAttachmentDataUrl(attachment);
  if (!dataUrl) {
    return [];
  }
  return [{
    type: "file",
    file: {
      filename: attachment.name,
      file_data: dataUrl,
    },
  }];
}

async function buildLlmChatMessages(messages: ChatMessage[], system?: string): Promise<LlmChatMessage[]> {
  const result: LlmChatMessage[] = [];
  if (system?.trim()) {
    result.push({ role: "system", content: system.trim() });
  }
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    if (message.role === "assistant") {
      const content = message.content.trim();
      if (content) {
        result.push({ role: "assistant", content });
      }
      continue;
    }

    // 用户消息：文本附件展开成文本，图片附件以 image_url（base64 data URL）发送，
    // PDF/DOCX/PPTX/XLSX 文件附件以 OpenAI 兼容的 file 内容块原样转发。
    const text = buildGatewayChatText(message).trim();
    const imageAttachments = message.attachments.filter(
      (attachment) => attachment.kind === "image" && (attachment.dataUrl || attachment.path),
    );
    const parts: LlmChatContentPart[] = [];
    if (text) {
      parts.push({ type: "text", text });
    }
    for (const attachment of imageAttachments) {
      const dataUrl = await chatAttachmentDataUrl(attachment);
      if (!dataUrl) {
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }
    const fileAttachments = message.attachments.filter(
      (attachment) => attachment.kind === "file" && (attachment.dataUrl || attachment.path),
    );
    for (const attachment of fileAttachments) {
      parts.push(...await buildLlmFileAttachmentParts(attachment));
    }
    if (parts.length === 0) {
      continue;
    }
    if (!parts.some((part) => part.type === "text")) {
      parts.unshift({ type: "text", text: "请根据附件内容回复。" });
    }
    result.push({ role: "user", content: parts });
  }
  return result;
}

function chatMessageTitle(content: string, attachments: ChatAttachment[]): string {
  const text = content.trim().replace(/\s+/g, " ");
  if (text) {
    return text.slice(0, 30);
  }
  const firstAttachment = attachments[0];
  if (!firstAttachment) {
    return "新对话";
  }
  return `附件：${firstAttachment.name}`.slice(0, 30);
}

function writeGatewayChatSse(reply: FastifyReply, event: string, payload: Record<string, unknown>): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return;
  }
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function extractGatewayChatDeltasFromBufferedText(
  bufferedText: string,
  flush = false,
): { deltas: string[]; rest: string; failure?: CodexInBandFailure } {
  const deltas: string[] = [];
  let failure: CodexInBandFailure | undefined;
  // Upstream SSE may use CRLF separators; normalize before splitting so
  // complete events are not left buffered until the stream ends.
  const normalizedText = bufferedText.replace(/\r\n/g, "\n");
  const parts = normalizedText.split("\n\n");
  const rest = flush ? "" : parts.pop() ?? "";
  for (const block of parts) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (flush) {
        console.info("[gateway:chat:sse-final]", JSON.stringify(parsed).slice(0, 20000));
      }
      failure = extractCodexInBandFailure(parsed) ?? failure;
      const delta = extractCodexTextDeltaFromSsePayload(parsed);
      if (delta) {
        deltas.push(delta);
      }
    } catch {
      // Ignore partial or malformed SSE blocks; the next chunk may contain a complete event.
    }
  }
  return { deltas, rest, failure };
}

function summarizeImageRequestForLog(body: z.infer<typeof imageGenerationsBodySchema>): Record<string, unknown> {
  return {
    model: body.model ?? "default",
    n: body.n ?? 1,
    promptLength: body.prompt.length,
    size: body.size ?? "default",
    quality: body.quality ?? "default",
    background: body.background ?? "default",
    output_format: body.output_format ?? "default",
    output_compression: typeof body.output_compression === "number" ? body.output_compression : undefined,
    moderation: body.moderation ?? "default",
    response_format: body.response_format ?? "default",
    user: body.user ?? undefined,
    gateway_background: body._gateway_background ?? undefined,
    gateway_webhook: body._gateway_webhook_url ? "configured" : undefined,
  };
}

async function postImageGenerationWebhook(params: {
  url: string;
  generationId: string;
  status: "success" | "failed";
  response?: Record<string, unknown>;
  images?: GatewayImageAsset[];
  error?: string;
}): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(params.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: params.generationId,
          status: params.status,
          response: params.response,
          images: params.images,
          error: params.error,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn("[gateway:image] webhook returned non-2xx", {
          generationId: params.generationId,
          statusCode: response.status,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn("[gateway:image] webhook delivery failed", {
      generationId: params.generationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 背景生图任务结束后给提交人推送企业微信消息。
 * 同步请求由调用方直接拿到结果，不做额外推送。
 */
async function notifyBackgroundImageResult(params: {
  settings: GatewaySettings;
  request: FastifyRequest;
  background: boolean;
  owner?: string;
  generationId: string;
  status: "success" | "failed";
  prompt?: string;
  imageCount?: number;
  durationMs?: number;
  error?: string;
  /** 成功时优先用免登录分享链接，拿不到再回退到生图页。 */
  shareUrl?: string;
}): Promise<void> {
  if (!params.background) {
    return;
  }
  await notifyWecomImageResult({
    settings: params.settings,
    owner: params.owner,
    generationId: params.generationId,
    status: params.status,
    prompt: params.prompt,
    imageCount: params.imageCount,
    durationMs: params.durationMs,
    error: params.error,
    historyUrl: params.shareUrl || `${resolveOrigin(params.request)}/#/generate`,
  });
}

/**
 * 企业微信「接收消息」回调 + 企微内对话的运行状态，管理接口读取，
 * 全部放在 createApp 闭包里，重启即清零。
 */
type WecomCallbackRuntimeState = {
  startedAt: number;
  lastVerifiedAt?: number;
  lastMessageAt?: number;
  lastMessageType?: string;
  lastMessageUser?: string;
  lastReplyAt?: number;
  pendingJobs: number;
  lastError?: { at: number; stage: string; message: string };
  lastPushAt?: number;
  lastPushError?: { at: number; message: string };
};

type WecomSelfTestCheck = { id: string; label: string; ok: boolean; detail?: string };

/** 内部注入请求带标记头：生图结束后由企微桥接逻辑自己推送，避免重复通知。 */
function isWecomInternalRequest(request: FastifyRequest): boolean {
  const value = request.headers[WECOM_INTERNAL_HEADER];
  return (Array.isArray(value) ? value[0] : value) === "1";
}

function toWecomCallbackSettings(wecom: GatewaySettings["wecom"]): WecomCallbackSettings {
  return {
    token: wecom.callbackToken.trim(),
    aesKey: wecom.callbackAesKey.trim(),
    corpId: wecom.corpId.trim(),
  };
}

function toWecomPushConfig(wecom: GatewaySettings["wecom"]): WecomPushConfig {
  return {
    corpId: wecom.corpId.trim(),
    agentId: wecom.agentId.trim(),
    secret: wecom.secret.trim(),
  };
}

function isWecomPushConfigured(wecom: GatewaySettings["wecom"]): boolean {
  return Boolean(wecom.enabled && wecom.corpId.trim() && wecom.agentId.trim() && wecom.secret.trim());
}

function getWecomQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/**
 * 从原始 URL 的 query 里取参数。
 *
 * 企微回调的 echostr / Encrypt 是 base64，可能包含 "+"。Fastify 的 query 解析会把
 * 未编码的 "+" 当成空格，导致签名校验失败，所以这里优先解析原始 query：
 * decodeURIComponent 会保留未编码的 "+"，同时也能正确还原 %2B。
 */
function getWecomRawQueryValue(url: string | undefined, name: string): string | undefined {
  const queryString = url?.split("?")[1] ?? "";
  if (!queryString) {
    return undefined;
  }
  const match = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(queryString);
  if (!match) {
    return undefined;
  }
  const raw = match[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 企微回调参数：原始 query 优先，取不到再回退 Fastify 解析结果。 */
function getWecomCallbackQueryValue(
  request: FastifyRequest,
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  return getWecomRawQueryValue(request.raw.url, name) ?? getWecomQueryValue(query[name]);
}

/** 给 app.inject 调用加超时保护，避免上游卡死时任务永远挂着。 */
function submitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleepForWecom(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function safeParseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 从 /v1/responses 的返回体里取正文（output_text 优先，兼容 output[0].content[0].text）。 */
function extractWecomResponseOutputText(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const record = body as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          const text = (part as { text: string }).text.trim();
          if (text) {
            return text;
          }
        }
      }
    }
  }
  return "";
}

/** 容错解析生图判定 JSON：非 JSON / 字段缺失都按「不生成」处理。 */
function parseWecomImageDecision(text: string): { shouldGenerate: boolean; prompt: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { shouldGenerate: false, prompt: "" };
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { shouldGenerate?: unknown; prompt?: unknown };
      const shouldGenerate = parsed.shouldGenerate === true || String(parsed.shouldGenerate).trim().toLowerCase() === "true";
      const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
      return { shouldGenerate: shouldGenerate && Boolean(prompt), prompt };
    } catch {
      continue;
    }
  }
  return { shouldGenerate: false, prompt: "" };
}

/** 解析聊天 SSE 缓冲结果：message_done 取回复正文，error 取失败原因。 */
function parseWecomSseAssistantReply(body: string): { text: string; error?: string } {
  const blocks = body.replace(/\r\n/g, "\n").split("\n\n");
  let text = "";
  let errorMessage: string | undefined;
  for (const block of blocks) {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const dataText = dataLines.join("\n").trim();
    if (!eventName || !dataText) {
      continue;
    }
    const payload = safeParseJsonText(dataText);
    if (!payload || typeof payload !== "object") {
      continue;
    }
    if (eventName === "message_done") {
      const message = (payload as { message?: unknown }).message;
      if (message && typeof message === "object") {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") {
          text = content.trim();
        }
      }
    } else if (eventName === "error") {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        errorMessage = message.trim();
      }
    }
  }
  return { text, error: errorMessage };
}

function truncateWecomPrompt(prompt: string, maxChars = 60): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 企业微信应用消息只渲染纯文本，把 AI 回复里常见的 Markdown 记号去掉，
 * 避免聊天窗口里出现 `**`、`>`、反引号等原始符号；对话历史仍保留原文。
 */
function toWecomPlainText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/```[A-Za-z0-9_+#-]*\n?/g, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1（$2）")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 企微图片消息走 JPEG：长边压到 2048，循环降质量直到不超过 2MB。 */
async function convertWecomImageToJpeg(filePath: string): Promise<Buffer> {
  const raw = await fs.readFile(filePath);
  const render = async (quality: number): Promise<Buffer> => sharp(raw)
    .rotate()
    .resize({
      width: WECOM_IMAGE_JPEG_MAX_EDGE,
      height: WECOM_IMAGE_JPEG_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer();
  let quality = 82;
  let buffer = await render(quality);
  while (buffer.byteLength > WECOM_IMAGE_JPEG_MAX_BYTES && quality > 30) {
    quality = Math.max(30, quality - 10);
    buffer = await render(quality);
  }
  if (buffer.byteLength > WECOM_IMAGE_JPEG_MAX_BYTES) {
    buffer = await sharp(raw)
      .rotate()
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  }
  return buffer;
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

function localGenerationImagePathFromUrl(request: FastifyRequest, imageUrl: string): string | null {
  const localPrefix = "/_gateway/generations/images/";
  if (imageUrl.startsWith(localPrefix)) {
    return imageUrl.slice(localPrefix.length);
  }

  try {
    const parsed = new URL(imageUrl);
    const requestHost = request.headers.host;
    if (requestHost && parsed.host === requestHost && parsed.pathname.startsWith(localPrefix)) {
      return parsed.pathname.slice(localPrefix.length) + parsed.search;
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveImageEditReferences(
  request: FastifyRequest,
  references: Array<{ imageUrl: string }>,
  params: {
    session: AdminSession | null;
    requestOwner?: string;
    gatewayDatabaseService: ReturnType<typeof createGatewayContext>["gatewayDatabaseService"];
  },
): Promise<Array<{ imageUrl: string }>> {
  const resolved: Array<{ imageUrl: string }> = [];

  for (const reference of references) {
    const imageUrl = reference.imageUrl.trim();
    const localImagePath = localGenerationImagePathFromUrl(request, imageUrl);

    if (!localImagePath) {
      resolved.push(reference);
      continue;
    }

    const file = resolveGenerationImageFile(decodeURIComponent(localImagePath));
    if (!file) {
      throw new Error("历史图片路径无效。");
    }
    if (!isAdminSession(params.session) && file.generationId) {
      const owner = await params.gatewayDatabaseService.getGenerationOwner(file.generationId);
      if (!owner || owner !== params.requestOwner) {
        throw new Error("无权使用该历史图片。");
      }
    }

    const data = await fs.readFile(file.filePath);
    resolved.push({
      imageUrl: `data:${getContentType(file.filePath)};base64,${data.toString("base64")}`,
    });
  }

  return resolved;
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

function getImageGenerationTimeoutMs(settings: GatewaySettings): number {
  const value = settings.image?.generationTimeoutMs;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(30 * 60 * 1000, Math.max(60_000, Math.trunc(value)))
    : DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
}

function isLlmChannelChatResult(result: ChatResult): boolean {
  return isObjectRecord(result.raw) && result.raw._gatewayLlmRoute === "llm-api-channel";
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
  if (normalized.some((reference) => reference.imageUrl && !/^https?:\/\//i.test(reference.imageUrl) && !/^data:image\//i.test(reference.imageUrl) && !reference.imageUrl.startsWith("/_gateway/generations/images/"))) {
    return "images.edits 的 image_url 需要是 http(s) URL、本站历史图片地址、data:image/...;base64,...，或裸 base64 字符串。";
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

function serializeSettings(settings: GatewaySettings, isAdmin: boolean, envApiKeyConfigured = false, userApiKeyConfigured = false): GatewaySettings {
  return {
    ...settings,
    security: {
      apiKeyConfigured: Boolean(settings.security.apiKeyHash || envApiKeyConfigured),
      apiKeySource: settings.security.apiKeyHash ? "database" : envApiKeyConfigured ? "environment" : undefined,
      userApiKeyConfigured,
    } as unknown as GatewaySettings["security"],
    wecom: {
      ...settings.wecom,
      secret: isAdmin ? settings.wecom.secret : "",
      // 非管理员不下发回调 Token 与 EncodingAESKey，避免普通用户读到回调密钥。
      callbackToken: isAdmin ? settings.wecom.callbackToken : "",
      callbackAesKey: isAdmin ? settings.wecom.callbackAesKey : "",
    },
    image: {
      ...settings.image,
      apiChannel: {
        ...settings.image.apiChannel,
        apiKey: isAdmin ? settings.image.apiChannel.apiKey : "",
      },
    },
    llm: {
      ...settings.llm,
      apiChannel: {
        ...settings.llm.apiChannel,
        apiKey: isAdmin ? settings.llm.apiChannel.apiKey : "",
      },
    },
  };
}

function buildGatewayHealth(ctx: ReturnType<typeof createGatewayContext>) {
  const modelAutoRefresh = ctx.modelService.getAutoRefreshStatus();
  return {
    ok: !modelAutoRefresh.lastError || (modelAutoRefresh.lastSuccessAt ?? 0) >= (modelAutoRefresh.lastFailureAt ?? 0),
    modelAutoRefresh,
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

/** 只对 IP 字面量做特殊处理：IP 直连时没有匹配的证书，升级到 https 会撞证书告警。 */
function isIpHost(host: string): boolean {
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/**
 * 是否为浏览器页面导航请求（而不是 API 调用或静态资源请求）。
 * 优先看 `Sec-Fetch-Mode`，老内核没有该头时退回 `Accept` 判断。
 */
function isDocumentNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  if (request.headers["sec-fetch-mode"] === "navigate") {
    return true;
  }
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/html");
}

/**
 * 企业微信 / 微信内置浏览器只在安全上下文（https、localhost）里暴露剪贴板 API，
 * 用 http 打开的页面点「复制图片」必然失败。反向代理会通过 X-Forwarded-Proto
 * 告诉我们客户端实际用的是 http，这里把这类页面导航 301 到 https，
 * 让内置浏览器始终拿到安全上下文；API 客户端（Accept 不含 text/html）不受影响。
 */
function buildHttpsUpgradeUrl(request: FastifyRequest): string | null {
  const rawProtocol = request.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(rawProtocol) ? rawProtocol[0] : rawProtocol)?.split(",")[0]?.trim().toLowerCase();
  if (protocol !== "http" || !isDocumentNavigation(request)) {
    return null;
  }
  const host = request.headers.host;
  if (!host || isIpHost(host)) {
    return null;
  }
  return `https://${host}${request.url}`;
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

function getImageFailureDetails(error: unknown): {
  upstreamText?: string;
  imageDebug?: Record<string, unknown>;
  raw?: unknown;
} {
  if (!error || typeof error !== "object") {
    return {};
  }

  const record = error as {
    upstreamText?: unknown;
    imageDebug?: unknown;
    upstreamRaw?: unknown;
  };
  return {
    upstreamText: typeof record.upstreamText === "string" ? record.upstreamText : undefined,
    imageDebug: record.imageDebug && typeof record.imageDebug === "object" && !Array.isArray(record.imageDebug)
      ? record.imageDebug as Record<string, unknown>
      : undefined,
    raw: typeof record.upstreamRaw === "undefined" ? undefined : record.upstreamRaw,
  };
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  // 企业微信「接收消息」回调以 XML 投递密文，这里原样保留字符串交给协议层解析。
  app.addContentTypeParser(["text/xml", "application/xml"], { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const ctx = createGatewayContext();
  const gatewayRequestLogs: GatewayRequestLog[] = [];
  const codexResponseProfileBindings = new Map<string, { profileId: string; accountId: string; seenAt: number }>();
  let pendingOAuthLogin: { id: string; session: OpenAICodexRemoteLoginSession; createdAt: number } | null = null;
  let bootstrapReady: Promise<void> | null = null;
  const pendingWecomEmbedStates = new Map<string, number>();
  const pendingWecomOAuthStates = new Map<string, number>();
  const pendingWecomCompleteTokens = new Map<string, { username: string; role: GatewayUserRole; expiresAt: number }>();
  const wecomCallbackState: WecomCallbackRuntimeState = { startedAt: Date.now(), pendingJobs: 0 };
  /** 已处理的企微消息 MsgId（TTL 10 分钟），用于抵御企微重复推送。 */
  const wecomSeenMessageIds = new Map<string, number>();
  /** 每个企微用户固定的「企业微信」会话 id，被删除后自动重建。 */
  const wecomConversationIds = new Map<string, string>();
  /** 每个企微用户的串行任务链，保证同一用户的消息按顺序处理。 */
  const wecomChatChains = new Map<string, Promise<void>>();
  /** 每个企微用户未完成的任务数（含正在处理的一条）。 */
  const wecomPendingJobsByOwner = new Map<string, number>();
  const wecomMsgIdSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [msgId, seenAt] of wecomSeenMessageIds) {
      if (now - seenAt > WECOM_CALLBACK_MSG_ID_TTL_MS) {
        wecomSeenMessageIds.delete(msgId);
      }
    }
  }, WECOM_CALLBACK_MSG_ID_SWEEP_MS);
  wecomMsgIdSweepTimer.unref?.();

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
    const apiOwner = (request as GatewayAuthedRequest).gatewayApiAuth?.owner;
    if (apiOwner) {
      return apiOwner;
    }
    return requestOwnerFromSession(await getSessionFromRequest(request));
  }

  /** 生图完成后生成免登录分享链接；失败只记录日志，不影响生图流程。 */
  async function createImageShareUrl(
    request: FastifyRequest,
    owner: string | undefined,
    generationId: string,
  ): Promise<string | undefined> {
    try {
      const link = await ctx.gatewayDatabaseService.createImageShareLink({ generationId, owner });
      return `${resolveOrigin(request)}/s/${link.token}`;
    } catch (error) {
      console.warn("[gateway:share] failed to create image share link", {
        generationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // 企微「接收消息」回调 + 企微内对话桥接
  // 核心思路：伪造该企微用户的 session cookie，用 app.inject 复用网页聊天页的
  // 会话/SSE/分类器/生图路由，再通过企微应用消息把结果推回聊天窗口。
  // ---------------------------------------------------------------------------

  function recordWecomCallbackVerified(): void {
    wecomCallbackState.lastVerifiedAt = Date.now();
  }

  function recordWecomCallbackError(stage: string, error: unknown): void {
    wecomCallbackState.lastError = { at: Date.now(), stage, message: errorText(error) };
  }

  function recordWecomIncomingMessage(incoming: WecomIncomingMessage): void {
    wecomCallbackState.lastMessageAt = Date.now();
    wecomCallbackState.lastMessageType = incoming.msgType;
    wecomCallbackState.lastMessageUser = incoming.fromUser;
  }

  function recordWecomPassiveReply(): void {
    wecomCallbackState.lastReplyAt = Date.now();
  }

  function recordWecomPushSuccess(): void {
    wecomCallbackState.lastPushAt = Date.now();
    wecomCallbackState.lastPushError = undefined;
  }

  function recordWecomPushError(error: unknown): void {
    const message = errorText(error);
    wecomCallbackState.lastPushError = { at: Date.now(), message };
    console.warn("[gateway:wecom] push failed", { message });
  }

  /** 被动回复（加密 XML）直接回给企微，必须在 5 秒内返回。 */
  function sendWecomPassiveReply(
    reply: FastifyReply,
    wecom: GatewaySettings["wecom"],
    params: { toUser: string; content: string },
  ): FastifyReply {
    const xml = buildWecomPassiveReplyXml(toWecomCallbackSettings(wecom), {
      toUser: params.toUser,
      fromUser: wecom.corpId.trim(),
      content: params.content,
    });
    recordWecomPassiveReply();
    reply.type("application/xml; charset=utf-8");
    return reply.send(xml);
  }

  /** 主动推送文本；失败只记录状态并返回 false，不抛异常。 */
  async function sendWecomPushText(userId: string, content: string): Promise<boolean> {
    try {
      const settings = await ctx.configService.getSettings();
      if (!isWecomPushConfigured(settings.wecom)) {
        return false;
      }
      await sendWecomTextMessage({
        config: toWecomPushConfig(settings.wecom),
        userId,
        content,
      });
      recordWecomPushSuccess();
      return true;
    } catch (error) {
      recordWecomPushError(error);
      return false;
    }
  }

  /** 主动推送图片；失败只记录状态并返回 false，不抛异常。 */
  async function sendWecomPushImage(userId: string, image: Buffer): Promise<boolean> {
    try {
      const settings = await ctx.configService.getSettings();
      if (!isWecomPushConfigured(settings.wecom)) {
        return false;
      }
      await sendWecomImageMessage({
        config: toWecomPushConfig(settings.wecom),
        userId,
        image,
        filename: "image.jpg",
      });
      recordWecomPushSuccess();
      return true;
    } catch (error) {
      recordWecomPushError(error);
      return false;
    }
  }

  /** 每个企微用户固定复用标题为「企业微信」的会话；被删除后自动重建。 */
  async function resolveWecomConversationId(username: string): Promise<string> {
    const cached = wecomConversationIds.get(username);
    if (cached) {
      const existing = await ctx.gatewayDatabaseService.getChatConversation(cached, username);
      if (existing) {
        return cached;
      }
      wecomConversationIds.delete(username);
    }
    const conversations = await ctx.gatewayDatabaseService.listChatConversations(100, username);
    const found = conversations.find((item) => item.title === WECOM_CONVERSATION_TITLE);
    if (found) {
      wecomConversationIds.set(username, found.id);
      return found.id;
    }
    const created = await ctx.gatewayDatabaseService.createChatConversation({
      owner: username,
      title: WECOM_CONVERSATION_TITLE,
    });
    wecomConversationIds.set(username, created.id);
    return created.id;
  }

  /** 跑一轮网页聊天页同款 SSE 聊天，取 assistant 最终回复文本。 */
  async function runWecomChatTurn(cookie: string, conversationId: string, content: string): Promise<{ text: string; error?: string }> {
    const response = await submitWithTimeout(
      app.inject({
        method: "POST",
        url: `/_gateway/chats/${encodeURIComponent(conversationId)}/messages/stream`,
        headers: { cookie, "content-type": "application/json" },
        payload: { content, system: WECOM_CHAT_SYSTEM_PROMPT },
      }),
      WECOM_CHAT_TASK_TIMEOUT_MS,
      "AI 回复超时，请稍后重试。",
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const payload = safeParseJsonText(response.body) as { error?: { message?: unknown } } | null;
      const message = typeof payload?.error?.message === "string"
        ? payload.error.message
        : `聊天接口返回 HTTP ${response.statusCode}`;
      throw new Error(message);
    }
    return parseWecomSseAssistantReply(response.body);
  }

  /** 与网页聊天页一致的生图动作判定；判定失败/非 JSON 一律视为不生成。 */
  async function classifyWecomImageAction(
    cookie: string,
    replyText: string,
    settings: GatewaySettings,
  ): Promise<{ shouldGenerate: boolean; prompt: string }> {
    try {
      const model = settings.modelRouting.imageClassifierModel || settings.defaultModel;
      const response = await submitWithTimeout(
        app.inject({
          method: "POST",
          url: "/v1/responses",
          headers: { cookie, "content-type": "application/json" },
          payload: {
            model,
            instructions: WECOM_IMAGE_CLASSIFIER_INSTRUCTIONS,
            input: `assistant 回复：\n${replyText.slice(0, 6000)}`,
            reasoning: { effort: "low" },
            max_output_tokens: 900,
          },
        }),
        WECOM_CLASSIFIER_TIMEOUT_MS,
        "生图判定超时。",
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { shouldGenerate: false, prompt: "" };
      }
      return parseWecomImageDecision(extractWecomResponseOutputText(safeParseJsonText(response.body)));
    } catch (error) {
      console.warn("[gateway:wecom] image classification failed", { message: errorText(error) });
      return { shouldGenerate: false, prompt: "" };
    }
  }

  /** 提交生图任务 → 轮询历史 → 推送图片 + 免登录分享链接。 */
  async function generateWecomImageAndPush(params: {
    request: FastifyRequest;
    userId: string;
    username: string;
    cookie: string;
    prompt: string;
    settings: GatewaySettings;
  }): Promise<void> {
    const submitResponse = await submitWithTimeout(
      app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: {
          cookie: params.cookie,
          [WECOM_INTERNAL_HEADER]: "1",
          "content-type": "application/json",
        },
        payload: {
          model: params.settings.modelRouting.imageGenerationModel,
          prompt: params.prompt,
          n: 1,
          size: "1024x1024",
          quality: "high",
          output_format: "png",
          response_format: "b64_json",
          _gateway_background: true,
        },
      }),
      WECOM_IMAGE_SUBMIT_TIMEOUT_MS,
      "提交生图任务超时。",
    );
    const submitPayload = safeParseJsonText(submitResponse.body) as { id?: unknown; error?: { message?: unknown } } | null;
    if (submitResponse.statusCode < 200 || submitResponse.statusCode >= 300) {
      const message = typeof submitPayload?.error?.message === "string"
        ? submitPayload.error.message
        : `生图接口返回 HTTP ${submitResponse.statusCode}`;
      throw new Error(message);
    }
    const generationId = typeof submitPayload?.id === "string" ? submitPayload.id.trim() : "";
    if (!generationId) {
      throw new Error("生图接口没有返回任务 ID。");
    }

    const generationTimeoutMs = Number.isFinite(params.settings.image.generationTimeoutMs)
      ? params.settings.image.generationTimeoutMs
      : 0;
    // 以网关自己的生图超时为下限再加 1 分钟缓冲，避免轮询比生图更早放弃。
    const pollTimeoutMs = Math.max(WECOM_IMAGE_POLL_TIMEOUT_MS, generationTimeoutMs + 60_000);
    const deadline = Date.now() + pollTimeoutMs;
    let item: GenerationHistoryItem | null = null;
    while (Date.now() < deadline) {
      item = await ctx.gatewayDatabaseService.getGenerationHistoryItem(generationId, params.username);
      if (item && item.status !== "queued" && item.status !== "running") {
        break;
      }
      await sleepForWecom(WECOM_IMAGE_POLL_INTERVAL_MS);
    }
    if (!item || item.status === "queued" || item.status === "running") {
      throw new Error("图片生成超时，请稍后在网页端生图记录中查看。");
    }
    if (item.status !== "success") {
      throw new Error(item.error?.trim() || "生图任务未成功完成。");
    }
    const image = item.images[0];
    if (!image) {
      throw new Error("生图任务没有返回图片。");
    }
    const filename = image.previewFilename?.trim() || image.filename.trim();
    const resolved = resolveGenerationImageFile(`${item.id}/${filename}`);
    if (!resolved) {
      throw new Error("找不到生成的图片文件。");
    }
    const jpeg = await convertWecomImageToJpeg(resolved.filePath);
    const imageSent = await sendWecomPushImage(params.userId, jpeg);

    const origin = resolveOrigin(params.request);
    const fallbackUrl = image.url
      ? (image.url.startsWith("http") ? image.url : `${origin}${image.url}`)
      : `${origin}/#/generate`;
    const shareUrl = (await createImageShareUrl(params.request, params.username, generationId)) || fallbackUrl;
    const promptExcerpt = truncateWecomPrompt(params.prompt);
    const headline = imageSent
      ? `🖼 图片已生成：${promptExcerpt}`
      : `🖼 图片已生成（图片消息发送失败）：${promptExcerpt}`;
    await sendWecomPushText(params.userId, `${headline}\n查看原图与参数：${shareUrl}`);
  }

  /** 处理一条企微文字消息：建号/建会话 → 聊天 → 推送文本 → 按需生图推图。 */
  async function runWecomChatTask(params: {
    request: FastifyRequest;
    userId: string;
    settings: GatewaySettings;
    content: string;
  }): Promise<void> {
    const userId = params.userId.trim();
    if (!userId) {
      return;
    }
    const username = `wxwork:${userId}`;
    try {
      let user = await ctx.gatewayDatabaseService.getUserByUsername(username);
      if (!user) {
        await ctx.gatewayDatabaseService.createUser({
          username,
          displayName: userId,
          passwordHash: hashSecret(randomUUID()),
          role: "user",
        });
        user = await ctx.gatewayDatabaseService.getUserByUsername(username);
      }
      if (!user) {
        throw new Error("企业微信账号创建失败。");
      }
      if (user.disabled) {
        await sendWecomPushText(userId, WECOM_DISABLED_ACCOUNT_MESSAGE);
        return;
      }
      const cookie = `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(createAdminSessionToken(security, user.username, user.role))}`;
      const conversationId = await resolveWecomConversationId(username);
      const reply = await runWecomChatTurn(cookie, conversationId, params.content);
      if (!reply.text) {
        throw new Error(reply.error || "AI 没有返回内容。");
      }
      const textPushed = await sendWecomPushText(userId, toWecomPlainText(reply.text));
      if (!textPushed) {
        return;
      }
      const decision = await classifyWecomImageAction(cookie, reply.text, params.settings);
      if (!decision.shouldGenerate || !decision.prompt) {
        return;
      }
      try {
        await generateWecomImageAndPush({
          request: params.request,
          userId,
          username,
          cookie,
          prompt: decision.prompt,
          settings: params.settings,
        });
      } catch (error) {
        recordWecomCallbackError("image", error);
        await sendWecomPushText(userId, `图片生成失败：${errorText(error)}`);
      }
    } catch (error) {
      recordWecomCallbackError("chat", error);
      await sendWecomPushText(userId, `抱歉，回复失败：${errorText(error)}`);
    }
  }

  /**
   * 每用户串行队列：同一用户的消息按顺序处理；未完成任务数达到上限时返回 false，
   * 由调用方被动回复「上一条还在处理中」。任务内异常全部兜底，不会逃逸成 unhandledRejection。
   */
  function enqueueWecomChatTask(params: {
    request: FastifyRequest;
    userId: string;
    settings: GatewaySettings;
    content: string;
  }): boolean {
    const ownerKey = `wxwork:${params.userId.trim()}`;
    const pending = wecomPendingJobsByOwner.get(ownerKey) ?? 0;
    if (pending >= WECOM_CHAT_MAX_PENDING_JOBS) {
      return false;
    }
    wecomPendingJobsByOwner.set(ownerKey, pending + 1);
    wecomCallbackState.pendingJobs += 1;
    const previous = wecomChatChains.get(ownerKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => runWecomChatTask(params))
      .catch((error) => {
        recordWecomCallbackError("queue", error);
        console.warn("[gateway:wecom] chat task failed", { message: errorText(error) });
      })
      .finally(() => {
        const remaining = (wecomPendingJobsByOwner.get(ownerKey) ?? 1) - 1;
        if (remaining > 0) {
          wecomPendingJobsByOwner.set(ownerKey, remaining);
        } else {
          wecomPendingJobsByOwner.delete(ownerKey);
        }
        wecomCallbackState.pendingJobs = Math.max(0, wecomCallbackState.pendingJobs - 1);
        if (wecomChatChains.get(ownerKey) === next) {
          wecomChatChains.delete(ownerKey);
        }
      });
    wecomChatChains.set(ownerKey, next);
    return true;
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

  type ImageLimitSource = {
    perUserDaily?: number;
    perUserHourly?: number;
    minIntervalSeconds?: number;
  };

  function hasPositiveImageLimit(source: ImageLimitSource | undefined): boolean {
    return Boolean(
      source &&
      ((source.perUserDaily ?? 0) > 0 || (source.perUserHourly ?? 0) > 0 || (source.minIntervalSeconds ?? 0) > 0),
    );
  }

  function resolveImageLimits(settings: GatewaySettings, owner: string, groupLimits?: ImageLimitSource): {
    perUserDaily: number;
    perUserHourly: number;
    minIntervalSeconds: number;
    hasActiveOverride: boolean;
  } {
    const limits = settings.image.limits;
    const override = limits.userOverrides.find((item) => item.username === owner);
    const inheritedDaily = limits.enabled ? limits.perUserDaily : 0;
    const inheritedHourly = limits.enabled ? limits.perUserHourly : 0;
    const inheritedMinIntervalSeconds = limits.enabled ? limits.minIntervalSeconds : 0;
    return {
      perUserDaily: override?.perUserDaily ?? groupLimits?.perUserDaily ?? inheritedDaily,
      perUserHourly: override?.perUserHourly ?? groupLimits?.perUserHourly ?? inheritedHourly,
      minIntervalSeconds: override?.minIntervalSeconds ?? groupLimits?.minIntervalSeconds ?? inheritedMinIntervalSeconds,
      hasActiveOverride: hasPositiveImageLimit(override) || hasPositiveImageLimit(groupLimits),
    };
  }

  async function getImageOwnerPolicy(owner: string | undefined): Promise<ImageOwnerPolicy> {
    if (!owner) {
      return {
        priority: 0,
        imageLimitsDisabled: false,
      };
    }
    const user = await ctx.gatewayDatabaseService.getUserWithGroupByUsername(owner).catch(() => null);
    return {
      priority: user?.groupSortOrder ?? 0,
      imageLimitsDisabled: Boolean(user?.groupImageLimitsDisabled),
      groupName: user?.groupName,
      groupLimits: user
        ? {
            perUserDaily: user.groupPerUserDaily,
            perUserHourly: user.groupPerUserHourly,
            minIntervalSeconds: user.groupMinIntervalSeconds,
          }
        : undefined,
    };
  }

  async function checkImageGenerationLimit(owner: string | undefined, settings: GatewaySettings): Promise<ImageLimitCheckResult> {
    const limits = settings.image.limits;
    if (!owner) {
      return { allowed: true };
    }

    const policy = await getImageOwnerPolicy(owner);
    if (policy.imageLimitsDisabled) {
      return { allowed: true };
    }

    const effective = resolveImageLimits(settings, owner, policy.groupLimits);
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
    // 放在鉴权之前：http 页面先升级到 https，避免内置浏览器在非安全上下文里
    // 失去剪贴板能力后连登录重定向都失败。
    const httpsUrl = buildHttpsUpgradeUrl(request);
    if (!httpsUrl) {
      return;
    }
    return reply.redirect(httpsUrl, 301);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!acceptsGzip(request) || !shouldCompressReply(reply, payload)) {
      return payload;
    }
    reply.header("Content-Encoding", "gzip");
    reply.removeHeader("Content-Length");
    return gzipAsync(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  });

  app.addHook("onRequest", async (request, reply) => {
    if (isPublicPath(request.method, request.url)) {
      return;
    }

    // Retired endpoint: answer every caller (authenticated or not) with the
    // retirement notice instead of an auth error that suggests it still works.
    if (request.url.split("?")[0] === "/v1/chat/completions") {
      const message = CHAT_COMPLETIONS_RETIRED_MESSAGE;
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: "-",
        statusCode: 410,
        durationMs: 0,
        source: requestSourceFromUserAgent(request.headers["user-agent"]),
        details: {
          requestId: request.id,
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
          error: { type: "endpoint_retired", message },
        },
      });
      reply.code(410);
      return reply.send({ error: { type: "endpoint_retired", message } });
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

    if (isApiPath(request.url) && (request.url.split("?")[0]?.startsWith("/_gateway/") ? Boolean(getBearerToken(request)) : true)) {
      const pathOnly = request.url.split("?")[0] ?? "/";
      if (
        isAdminSession(session) ||
        (session && (
          pathOnly === "/v1/images/generations" ||
          pathOnly === "/v1/images/edits" ||
          pathOnly === "/v1/responses"
        ))
      ) {
        return;
      }

      const bearerToken = getBearerToken(request);
      const resolvedApiKey = await resolveApiKeyAuth(ctx, security, bearerToken);
      if (!resolvedApiKey.hash) {
        reply.code(403);
        return reply.send({
          error: {
            type: "forbidden",
            message: "API access is disabled. Set API Key in Settings or AZT_API_KEY to enable OpenAI-compatible endpoints.",
          },
        });
      }

      if (!secureEqualHash(resolvedApiKey.hash, bearerToken)) {
        reply.code(401);
        reply.header("WWW-Authenticate", "Bearer");
        return reply.send({
          error: {
            type: "unauthorized",
            message: "Missing or invalid API key.",
          },
        });
      }
      (request as GatewayAuthedRequest).gatewayApiAuth = {
        owner: resolvedApiKey.owner,
        source: resolvedApiKey.source ?? "database",
      };
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

  app.addHook("onReady", async () => {
    const interruptedCount = await ctx.gatewayDatabaseService.interruptRunningGenerations();
    if (interruptedCount > 0) {
      console.warn(`[generation] marked ${interruptedCount} running task(s) as interrupted after restart.`);
    }
    const interruptedChatCount = await ctx.gatewayDatabaseService.interruptRunningChatMessages();
    if (interruptedChatCount > 0) {
      console.warn(`[gateway:chat] marked ${interruptedChatCount} running reply(ies) as interrupted after restart.`);
    }
    ctx.modelService.startAutoRefresh();
  });

  app.addHook("onClose", async () => {
    ctx.modelService.stopAutoRefresh();
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    const statusCode = getErrorStatusCode(normalized);
    const imageFailureDetails = getImageFailureDetails(normalized);
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
      upstreamText: imageFailureDetails.upstreamText,
      imageDebug: imageFailureDetails.imageDebug,
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

  app.get("/_gateway/chats", async (request) => {
    const parsed = chatListQuerySchema.safeParse(request.query);
    const owner = await getRequestOwner(request);
    return {
      items: await ctx.gatewayDatabaseService.listChatConversations(parsed.success ? parsed.data.limit : 100, owner),
    };
  });

  app.post("/_gateway/chats", async (request, reply) => {
    const parsed = chatConversationBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }
    const owner = await getRequestOwner(request);
    return {
      item: await ctx.gatewayDatabaseService.createChatConversation({
        owner,
        title: parsed.data.title,
        model: parsed.data.model,
      }),
    };
  });

  app.get("/_gateway/chats/:id", async (request, reply) => {
    const parsed = chatDetailQuerySchema.safeParse(request.query);
    const id = String((request.params as { id?: string }).id ?? "");
    const owner = await getRequestOwner(request);
    const item = await ctx.gatewayDatabaseService.getChatConversation(id, owner, {
      messageLimit: parsed.success ? parsed.data.messageLimit ?? 80 : 80,
      beforeMessageId: parsed.success ? parsed.data.beforeMessageId : undefined,
      includeAttachmentData: false,
    });
    if (!item) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }
    return { item };
  });

  app.get("/_gateway/chats/:id/export", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    const owner = await getRequestOwner(request);
    const item = await ctx.gatewayDatabaseService.getChatConversation(id, owner);
    if (!item) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }
    const plan = await prepareChatExport(item);
    const downloadName = chatExportDownloadName(item);
    const asciiName = `conversation-${item.id.slice(0, 8) || "export"}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeContentDispositionFileName(downloadName)}`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(createChatExportZipStream(item, plan));
  });

  app.patch("/_gateway/chats/:id", async (request, reply) => {
    const parsed = chatConversationPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }
    const id = String((request.params as { id?: string }).id ?? "");
    const owner = await getRequestOwner(request);
    const item = await ctx.gatewayDatabaseService.updateChatConversation(id, owner, parsed.data);
    if (!item) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }
    return { item };
  });

  app.delete("/_gateway/chats/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    const owner = await getRequestOwner(request);
    const ok = await ctx.gatewayDatabaseService.deleteChatConversation(id, owner);
    if (!ok) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }
    return { ok: true };
  });

  /**
   * 解析聊天页要使用的模型：渠道「优先」时直接用渠道模型；「回退」时先按
   * Codex 目录解析，解析失败但渠道可用时退回渠道模型，避免 Codex 未登录/
   * 目录同步失败时连回退机会都没有。
   */
  async function resolveChatModel(requested: string | undefined, fallbackModel: string | undefined, channel: LlmApiChannelConfig | undefined): Promise<string> {
    const candidate = (requested || fallbackModel || "").trim();
    // 选中的模型属于外部渠道目录时直接使用该模型（Codex 无法提供）。
    if (channel && candidate && isLlmApiChannelModel(channel, candidate)) {
      return candidate;
    }
    if (channel?.mode === "primary") {
      return channel.model;
    }
    try {
      return await ctx.modelService.resolveModel("openai-codex", requested || fallbackModel);
    } catch (error) {
      if (channel) {
        return channel.model;
      }
      throw error;
    }
  }

  async function streamGatewayChatAssistantReply(params: {
    request: FastifyRequest;
    reply: FastifyReply;
    owner: string | undefined;
    conversationId: string;
    model: string;
    system?: string;
    llmChannel?: LlmApiChannelConfig;
    assistantMessage: ChatMessage;
    contextMessages: ChatMessage[];
    promptLength: number;
    startPayload: Record<string, unknown>;
  }): Promise<FastifyReply> {
    const startedAt = performance.now();
    const abortController = new AbortController();
    const codexBody = await createGatewayChatCodexBody({ model: params.model, messages: params.contextMessages, system: params.system });
    let profile: OAuthProfile | null = null;
    let accumulated = "";
    let sseBuffer = "";
    let inBandFailure: CodexInBandFailure | undefined;
    let channelAttempted = false;
    let channelUsage: UsageTokenUsage | null = null;
    const channel = params.llmChannel;

    async function failChatReplyWithReason(error: unknown): Promise<void> {
      const normalized = normalizeError(error);
      if (profile) {
        await ctx.authService.recordProfileRequestFailure(profile.profileId, error, undefined, "openai-codex").catch(() => undefined);
      }
      const failedMessage = await ctx.gatewayDatabaseService.updateChatMessage(params.assistantMessage.id, params.owner, {
        content: accumulated.trim(),
        status: "failed",
        model: params.model,
        error: normalized.message,
        metadata: {
          durationMs: performance.now() - startedAt,
          requestId: params.request.id,
        },
      });
      pushGatewayRequestLog({
        id: params.request.id,
        owner: params.owner,
        method: params.request.method,
        endpoint: params.request.url,
        account: channelAttempted ? "大模型 API 渠道" : profileLogLabel(profile),
        model: params.model,
        statusCode: getErrorStatusCode(normalized),
        durationMs: performance.now() - startedAt,
        source: "聊天工作台",
        details: {
          requestId: params.request.id,
          remoteAddress: params.request.ip,
          userAgent: params.request.headers["user-agent"],
          request: {
            conversationId: params.conversationId,
            promptLength: params.promptLength,
            attachmentCount: params.contextMessages.reduce((sum, message) => sum + message.attachments.length, 0),
            contextMessageCount: params.contextMessages.length,
            ...(channelAttempted ? { llmChannel: true } : {}),
          },
          response: {
            assistantMessageId: params.assistantMessage.id,
            textPreview: truncateForLog(accumulated, CHAT_LOG_TEXT_PREVIEW_CHARS),
            textLength: accumulated.length,
          },
          error: {
            message: normalized.message,
            upstreamStatus: (normalized as Error & { upstreamStatus?: unknown }).upstreamStatus,
            upstreamRequestId: (normalized as Error & { requestId?: unknown }).requestId,
            upstreamErrorCode: (normalized as Error & { upstreamErrorCode?: unknown }).upstreamErrorCode,
            upstreamErrorMessage: (normalized as Error & { upstreamErrorMessage?: unknown }).upstreamErrorMessage,
          },
        },
        usage: {
          profile,
          tokenUsage: channelAttempted ? channelUsage : null,
        },
      });
      writeGatewayChatSse(params.reply, "error", {
        message: normalized.message,
        assistantMessage: failedMessage,
      });
      writeGatewayChatSse(params.reply, "done", { ok: false });
      params.reply.raw.end();
    }

    async function completeViaChannel(): Promise<void> {
      const activeChannel = channel;
      if (!activeChannel) {
        throw new Error("大模型 API 渠道未配置完整。");
      }
      channelAttempted = true;
      // 聊天页选中的模型若在渠道目录里就沿用，否则使用渠道默认模型。
      const requestModel = isLlmApiChannelModel(activeChannel, params.model)
        ? params.model
        : activeChannel.model || params.model;
      let resolvedModel = requestModel;
      for await (const event of streamLlmChatCompletion({
        channel: activeChannel,
        model: requestModel,
        messages: await buildLlmChatMessages(params.contextMessages, params.system),
        signal: abortController.signal,
        timeoutMs: 5 * 60 * 1000,
      })) {
        if (event.type === "delta") {
          accumulated += event.text;
          writeGatewayChatSse(params.reply, "message_delta", {
            id: params.assistantMessage.id,
            delta: event.text,
          });
        } else if (event.type === "usage") {
          channelUsage = normalizeTokenUsage(event.usage);
        } else if (event.type === "done") {
          resolvedModel = event.model || resolvedModel;
        }
      }
      if (!accumulated.trim()) {
        throw new Error("大模型 API 渠道没有返回文本内容。");
      }
      const finalMessage = await ctx.gatewayDatabaseService.updateChatMessage(params.assistantMessage.id, params.owner, {
        content: accumulated.trim(),
        status: "success",
        model: resolvedModel,
        error: null,
        metadata: {
          durationMs: performance.now() - startedAt,
          account: "大模型 API 渠道",
          requestId: params.request.id,
        },
      });
      pushGatewayRequestLog({
        id: params.request.id,
        owner: params.owner,
        method: params.request.method,
        endpoint: params.request.url,
        account: "大模型 API 渠道",
        model: resolvedModel,
        statusCode: 200,
        durationMs: performance.now() - startedAt,
        source: "聊天工作台",
        details: {
          requestId: params.request.id,
          remoteAddress: params.request.ip,
          userAgent: params.request.headers["user-agent"],
          request: {
            conversationId: params.conversationId,
            promptLength: params.promptLength,
            attachmentCount: params.contextMessages.reduce((sum, message) => sum + message.attachments.length, 0),
            contextMessageCount: params.contextMessages.length,
            llmChannel: true,
          },
          response: {
            assistantMessageId: params.assistantMessage.id,
            textPreview: truncateForLog(accumulated, CHAT_LOG_TEXT_PREVIEW_CHARS),
            textLength: accumulated.length,
          },
        },
        usage: {
          tokenUsage: channelUsage,
        },
      });
      writeGatewayChatSse(params.reply, "message_done", {
        message: finalMessage,
        durationMs: performance.now() - startedAt,
      });
      writeGatewayChatSse(params.reply, "done", { ok: true });
      params.reply.raw.end();
    }

    params.reply.raw.on("close", () => {
      abortController.abort();
    });
    params.reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeGatewayChatSse(params.reply, "message_start", params.startPayload);

    let channelFailure: unknown;
    if (channel?.mode === "primary") {
      try {
        await completeViaChannel();
        return params.reply;
      } catch (error) {
        channelFailure = error;
        // 渠道已经输出过增量时无法再切换到 Codex，只能按失败收尾。
        if (accumulated) {
          await failChatReplyWithReason(error);
          return params.reply;
        }
      }
    }

    try {
      profile = await ctx.authService.requireUsableProfile("openai-codex");
      const selectedProfile = profile;
      const upstream = await ctx.requestThrottleService.runForProfile(
        selectedProfile,
        () => streamOpenAICodex({
          profile: selectedProfile,
          model: params.model,
          bodyOverride: codexBody,
          passthroughBody: true,
          signal: abortController.signal,
        }),
        {
          requestId: params.request.id,
          route: "gateway-chat",
          model: params.model,
        },
      );
      await ctx.authService.recordProfileRequestSuccess(selectedProfile.profileId, upstream.quota, "openai-codex");

      for await (const chunk of Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0])) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        sseBuffer += text;
        const parsedChunk = extractGatewayChatDeltasFromBufferedText(sseBuffer);
        sseBuffer = parsedChunk.rest;
        inBandFailure = parsedChunk.failure ?? inBandFailure;
        for (const delta of parsedChunk.deltas) {
          accumulated += delta;
          writeGatewayChatSse(params.reply, "message_delta", {
            id: params.assistantMessage.id,
            delta,
          });
        }
      }
      const finalParsed = extractGatewayChatDeltasFromBufferedText(sseBuffer, true);
      inBandFailure = finalParsed.failure ?? inBandFailure;
      for (const delta of finalParsed.deltas) {
        accumulated += delta;
        writeGatewayChatSse(params.reply, "message_delta", { id: params.assistantMessage.id, delta });
      }
      // The upstream answers 200 and reports failures inside the stream. Surface
      // them as a failed message instead of persisting an empty successful reply.
      if (inBandFailure) {
        throw createCodexInBandFailureError(inBandFailure);
      }
      if (!accumulated.trim()) {
        throw new Error(`调用 Responses API 失败: HTTP ${upstream.status} 上游没有返回任何内容（model=${params.model}）`);
      }
      const finalMessage = await ctx.gatewayDatabaseService.updateChatMessage(params.assistantMessage.id, params.owner, {
        content: accumulated.trim(),
        status: "success",
        model: params.model,
        error: null,
        metadata: {
          durationMs: performance.now() - startedAt,
          account: profileLogLabel(selectedProfile),
          requestId: params.request.id,
        },
      });
      pushGatewayRequestLog({
        id: params.request.id,
        owner: params.owner,
        method: params.request.method,
        endpoint: params.request.url,
        account: profileLogLabel(selectedProfile),
        model: params.model,
        statusCode: upstream.status,
        durationMs: performance.now() - startedAt,
        source: "聊天工作台",
        details: {
          requestId: params.request.id,
          remoteAddress: params.request.ip,
          userAgent: params.request.headers["user-agent"],
          request: {
            conversationId: params.conversationId,
            promptLength: params.promptLength,
            attachmentCount: params.contextMessages.reduce((sum, message) => sum + message.attachments.length, 0),
            contextMessageCount: params.contextMessages.length,
          },
          response: {
            assistantMessageId: params.assistantMessage.id,
            textPreview: truncateForLog(accumulated, CHAT_LOG_TEXT_PREVIEW_CHARS),
            textLength: accumulated.length,
          },
        },
        usage: {
          profile: selectedProfile,
        },
      });
      writeGatewayChatSse(params.reply, "message_done", {
        message: finalMessage,
        durationMs: performance.now() - startedAt,
      });
      writeGatewayChatSse(params.reply, "done", { ok: true });
      params.reply.raw.end();
    } catch (error) {
      let failure = error;
      // Codex 在输出任何文本增量之前失败时，回退到大模型 API 渠道。
      if (channel?.mode === "fallback" && !accumulated) {
        try {
          await completeViaChannel();
          return params.reply;
        } catch (channelError) {
          channelAttempted = true;
          failure = new Error(`Codex 账号调用失败：${errorText(error)}；大模型 API 渠道回退失败：${errorText(channelError)}`);
        }
      } else if (channelFailure) {
        // 渠道优先模式：渠道失败后已回退 Codex，Codex 也失败时合并两个原因。
        failure = new Error(`大模型 API 渠道调用失败：${errorText(channelFailure)}；Codex 账号回退失败：${errorText(error)}`);
      }
      await failChatReplyWithReason(failure);
    }
    return params.reply;
  }

  app.post("/_gateway/chats/:id/messages/stream", async (request, reply) => {
    const parsed = chatMessageStreamBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }

    const id = String((request.params as { id?: string }).id ?? "");
    const owner = await getRequestOwner(request);
    const conversation = await ctx.gatewayDatabaseService.getChatConversation(id, owner);
    if (!conversation) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }

    // 大模型 API 渠道启用为「优先使用」时，文本回复直接走渠道模型，不再要求
    // Codex 模型目录里有该模型（Codex 账号未登录/目录同步失败时聊天仍可用）。
    const llmChannel = resolveLlmApiChannel((await ctx.configService.getSettings()).llm?.apiChannel);
    const model = await resolveChatModel(parsed.data.model, conversation.model, llmChannel);
    const userMessage = await ctx.gatewayDatabaseService.saveChatMessage({
      conversationId: id,
      owner,
      role: "user",
      content: parsed.data.content.trim(),
      attachments: parsed.data.attachments ?? [],
      status: "success",
      model,
    });
    if (conversation.title === "新对话") {
      await ctx.gatewayDatabaseService.updateChatConversation(id, owner, {
        title: chatMessageTitle(parsed.data.content, parsed.data.attachments ?? []),
        model,
      });
    } else if (conversation.model !== model) {
      await ctx.gatewayDatabaseService.updateChatConversation(id, owner, { model });
    }

    const assistantMessage = await ctx.gatewayDatabaseService.saveChatMessage({
      conversationId: id,
      owner,
      role: "assistant",
      content: "",
      status: "running",
      model,
    });
    const contextMessages = await ctx.gatewayDatabaseService.listSuccessfulChatMessages(id, owner);
    return streamGatewayChatAssistantReply({
      request,
      reply,
      owner,
      conversationId: id,
      model,
      system: parsed.data.system,
      llmChannel,
      assistantMessage,
      contextMessages,
      promptLength: parsed.data.content.length,
      startPayload: { userMessage, assistantMessage },
    });
  });

  app.patch("/_gateway/chats/:id/messages/:messageId/image-generation", async (request, reply) => {
    const parsed = chatMessageImageGenerationBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }

    const params = request.params as { id?: string; messageId?: string };
    const id = String(params.id ?? "");
    const messageId = String(params.messageId ?? "");
    const owner = await getRequestOwner(request);
    const [conversation, existing, generation] = await Promise.all([
      ctx.gatewayDatabaseService.getChatConversation(id, owner, { messageLimit: 1, includeAttachmentData: false }),
      ctx.gatewayDatabaseService.getChatMessageById(messageId, owner),
      ctx.gatewayDatabaseService.getGenerationHistoryItem(parsed.data.historyId, owner),
    ]);
    if (!conversation) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }
    if (!existing || existing.conversationId !== id || existing.role !== "assistant") {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天回复不存在。" } };
    }
    if (!generation) {
      reply.code(404);
      return { error: { type: "not_found", message: "生图任务不存在。" } };
    }

    const item = await ctx.gatewayDatabaseService.updateChatMessage(existing.id, owner, {
      metadata: {
        ...(existing.metadata ?? {}),
        imageGeneration: {
          historyId: parsed.data.historyId,
          prompt: parsed.data.prompt,
        },
      },
    });
    if (!item) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天回复不存在。" } };
    }
    return { item };
  });

  app.post("/_gateway/chats/:id/messages/:messageId/retry/stream", async (request, reply) => {
    const parsed = chatMessageRetryStreamBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }

    const params = request.params as { id?: string; messageId?: string };
    const id = String(params.id ?? "");
    const messageId = String(params.messageId ?? "");
    const owner = await getRequestOwner(request);
    const conversation = await ctx.gatewayDatabaseService.getChatConversation(id, owner);
    if (!conversation) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }

    const existing = await ctx.gatewayDatabaseService.getChatMessageById(messageId, owner);
    if (!existing || existing.conversationId !== id || existing.role !== "assistant") {
      reply.code(404);
      return { error: { type: "not_found", message: "要重试的回复不存在。" } };
    }
    if (existing.status !== "failed" && existing.status !== "interrupted") {
      reply.code(400);
      return { error: { type: "validation_error", message: "只能重试失败的回复。" } };
    }

    const llmChannel = resolveLlmApiChannel((await ctx.configService.getSettings()).llm?.apiChannel);
    const model = await resolveChatModel(parsed.data.model || existing.model, conversation.model, llmChannel);
    if (conversation.model !== model) {
      await ctx.gatewayDatabaseService.updateChatConversation(id, owner, { model });
    }
    const assistantMessage = await ctx.gatewayDatabaseService.updateChatMessage(existing.id, owner, {
      content: "",
      status: "running",
      model,
      error: null,
      metadata: null,
    });
    if (!assistantMessage) {
      reply.code(404);
      return { error: { type: "not_found", message: "要重试的回复不存在。" } };
    }
    const retryIndex = conversation.messages.findIndex((message) => message.id === existing.id);
    const contextMessages = (retryIndex >= 0 ? conversation.messages.slice(0, retryIndex) : conversation.messages)
      .filter((message) => message.status === "success");
    const lastUserMessage = [...contextMessages].reverse().find((message) => message.role === "user");
    return streamGatewayChatAssistantReply({
      request,
      reply,
      owner,
      conversationId: id,
      model,
      llmChannel,
      assistantMessage,
      contextMessages,
      promptLength: lastUserMessage?.content.length ?? 0,
      startPayload: { assistantMessage },
    });
  });

  app.patch("/_gateway/chats/:id/messages/:messageId/rewrite/stream", async (request, reply) => {
    const parsed = chatMessageRewriteStreamBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }

    const params = request.params as { id?: string; messageId?: string };
    const id = String(params.id ?? "");
    const messageId = String(params.messageId ?? "");
    const owner = await getRequestOwner(request);
    const conversation = await ctx.gatewayDatabaseService.getChatConversation(id, owner);
    if (!conversation) {
      reply.code(404);
      return { error: { type: "not_found", message: "聊天会话不存在。" } };
    }

    if (conversation.messages.some((message) => message.status === "running")) {
      reply.code(409);
      return { error: { type: "conflict", message: "当前对话仍有消息生成中，请稍后再编辑。" } };
    }

    const existing = conversation.messages.find((message) => message.id === messageId);
    if (!existing || existing.role !== "user") {
      reply.code(404);
      return { error: { type: "not_found", message: "要编辑的用户消息不存在。" } };
    }

    const llmChannel = resolveLlmApiChannel((await ctx.configService.getSettings()).llm?.apiChannel);
    const model = await resolveChatModel(parsed.data.model || conversation.model, existing.model, llmChannel);
    if (conversation.model !== model || conversation.title === "新对话") {
      await ctx.gatewayDatabaseService.updateChatConversation(id, owner, {
        model,
        ...(conversation.title === "新对话" ? { title: chatMessageTitle(parsed.data.content, existing.attachments) } : {}),
      });
    }

    const userMessage = await ctx.gatewayDatabaseService.updateChatMessage(existing.id, owner, {
      content: parsed.data.content,
      status: "success",
      model,
      error: null,
      metadata: existing.metadata ?? null,
    });
    if (!userMessage) {
      reply.code(404);
      return { error: { type: "not_found", message: "要编辑的用户消息不存在。" } };
    }

    await ctx.gatewayDatabaseService.deleteChatMessagesAfter(id, userMessage.id, owner);
    const assistantMessage = await ctx.gatewayDatabaseService.saveChatMessage({
      conversationId: id,
      owner,
      role: "assistant",
      content: "",
      status: "running",
      model,
    });
    const updatedConversation = await ctx.gatewayDatabaseService.getChatConversation(id, owner);
    const messageIndex = updatedConversation?.messages.findIndex((message) => message.id === userMessage.id) ?? -1;
    const contextMessages = (updatedConversation && messageIndex >= 0 ? updatedConversation.messages.slice(0, messageIndex + 1) : [userMessage])
      .filter((message) => message.status === "success");

    return streamGatewayChatAssistantReply({
      request,
      reply,
      owner,
      conversationId: id,
      model,
      llmChannel,
      assistantMessage,
      contextMessages,
      promptLength: parsed.data.content.length,
      startPayload: {
        userMessage,
        assistantMessage,
        replacedAfterMessageId: userMessage.id,
      },
    });
  });

  app.get("/_gateway/generations/history", async (request) => {
    const parsed = generationHistoryQuerySchema.safeParse(request.query);
    const limit = parsed.success ? parsed.data.limit ?? 10 : 10;
    const page = parsed.success ? parsed.data.page ?? 1 : 1;
    const offset = (page - 1) * limit;
    const query = parsed.success ? parsed.data.query : undefined;
    const status = parsed.success ? parsed.data.status : undefined;
    const startTime = parsed.success ? parsed.data.startTime : undefined;
    const endTime = parsed.success ? parsed.data.endTime : undefined;
    const range = normalizeGenerationTimeRange(startTime, endTime);
    const session = await getSessionFromRequest(request);
    const owner = resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    const [items, total] = await Promise.all([
      ctx.gatewayDatabaseService.listGenerationHistory(limit, owner, {
        light: parsed.success ? parsed.data.light ?? true : true,
        offset,
        query,
        status,
        startTime: range.startTime,
        endTime: range.endTime,
      }),
      ctx.gatewayDatabaseService.countGenerationHistory(owner, query, status, range),
    ]);
    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasMore: offset + items.length < total,
      startTime: range.startTime,
      endTime: range.endTime,
    };
  });

  app.get("/_gateway/generations/history/owners", async (request) => {
    const session = await getSessionFromRequest(request);
    const owner = isAdminSession(session) ? undefined : requestOwnerFromSession(session);
    const [items, total] = await Promise.all([
      ctx.gatewayDatabaseService.listGenerationOwnerUsage(owner),
      ctx.gatewayDatabaseService.countGenerationHistory(owner),
    ]);
    return {
      items,
      total,
    };
  });

  app.get("/_gateway/generations/report", async (request) => {
    const parsed = generationReportQuerySchema.safeParse(request.query);
    const session = await getSessionFromRequest(request);
    const owner = resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    const range = parsed.success
      ? normalizeGenerationTimeRange(parsed.data.startTime, parsed.data.endTime)
      : { startTime: undefined, endTime: undefined };
    return ctx.gatewayDatabaseService.getGenerationReport(owner, range);
  });

  app.get("/_gateway/generations/history/:id", async (request, reply) => {
    const parsed = generationHistoryQuerySchema.safeParse(request.query);
    const params = request.params as { id?: string };
    const session = await getSessionFromRequest(request);
    const apiOwner = (request as GatewayAuthedRequest).gatewayApiAuth?.owner;
    const owner = apiOwner || resolveDataOwnerFilter(session, parsed.success ? parsed.data.owner : undefined);
    const item = await ctx.gatewayDatabaseService.getGenerationHistoryItem(String(params.id ?? ""), owner);
    if (!item) {
      reply.code(404);
      return { error: { type: "not_found", message: "生图任务不存在。" } };
    }
    return { item };
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
    const requestOwner = await getRequestOwner(request);
    const wildcard = (request.params as { "*": string })["*"] ?? "";
    const file = resolveGenerationImageFile(wildcard);
    if (!file) {
      reply.code(403);
      return { error: { type: "forbidden", message: "禁止访问该文件。" } };
    }
    if (!isAdminSession(session) && file.generationId) {
      const owner = await ctx.gatewayDatabaseService.getGenerationOwner(file.generationId);
      if (!owner || owner !== requestOwner) {
        reply.code(403);
        return { error: { type: "forbidden", message: "禁止访问该图片。" } };
      }
    }
    try {
      const stats = await fs.stat(file.filePath);
      if (!stats.isFile()) {
        reply.code(404);
        return { error: { type: "not_found", message: "图片不存在。" } };
      }
      const accelRedirect = generationImageAccelRedirect(file.filePath);
      if (accelRedirect) {
        reply.header("Content-Type", getContentType(file.filePath));
        reply.header("Content-Length", String(stats.size));
        reply.header("Cache-Control", "private, max-age=3600");
        reply.header("X-Accel-Redirect", accelRedirect);
        return reply.send();
      }
      const data = await fs.readFile(file.filePath);
      reply.header("Content-Type", getContentType(file.filePath));
      reply.header("Content-Length", String(data.byteLength));
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(data);
    } catch {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
  });

  app.get("/s/:token", async (request, reply) => {
    const token = String((request.params as { token?: string }).token ?? "").trim();
    const link = token ? await ctx.gatewayDatabaseService.getImageShareLink(token).catch(() => null) : null;
    if (!link) {
      reply.code(404).header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow").type("text/html; charset=utf-8");
      return renderImageShareMissingPage();
    }
    const item = await ctx.gatewayDatabaseService
      .getGenerationHistoryItem(link.generationId, link.owner ?? undefined)
      .catch(() => null);
    if (!item || item.status !== "success" || item.images.length === 0) {
      reply.code(404).header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow").type("text/html; charset=utf-8");
      return renderImageShareMissingPage();
    }
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow").type("text/html; charset=utf-8");
    return renderImageSharePage({ item, token: link.token });
  });

  app.get("/s/:token/image/:index", async (request, reply) => {
    const params = request.params as { token?: string; index?: string };
    const token = String(params.token ?? "").trim();
    const index = Number.parseInt(String(params.index ?? ""), 10);
    const link = token ? await ctx.gatewayDatabaseService.getImageShareLink(token).catch(() => null) : null;
    if (!link || !Number.isInteger(index) || index < 0) {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
    const item = await ctx.gatewayDatabaseService
      .getGenerationHistoryItem(link.generationId, link.owner ?? undefined)
      .catch(() => null);
    const image = item?.images[index];
    if (!item || item.status !== "success" || !image) {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
    const file = resolveGenerationImageFile(`${item.id}/${image.filename}`);
    if (!file || file.generationId !== item.id) {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
    try {
      const accelRedirect = generationImageAccelRedirect(file.filePath);
      if (accelRedirect) {
        reply.header("Content-Type", image.mimeType || getContentType(file.filePath));
        reply.header("Cache-Control", "private, max-age=3600");
        reply.header("X-Accel-Redirect", accelRedirect);
        return reply.send();
      }
      const data = await fs.readFile(file.filePath);
      reply.header("Content-Type", image.mimeType || getContentType(file.filePath));
      reply.header("Content-Length", String(data.byteLength));
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(data);
    } catch {
      reply.code(404);
      return { error: { type: "not_found", message: "图片不存在。" } };
    }
  });

  app.get("/_gateway/chat-attachments/*", async (request, reply) => {
    const session = await getSessionFromRequest(request);
    const requestOwner = await getRequestOwner(request);
    const wildcard = (request.params as { "*": string })["*"] ?? "";
    const file = resolveChatAttachmentFile(wildcard);
    if (!file) {
      reply.code(403);
      return { error: { type: "forbidden", message: "禁止访问该文件。" } };
    }
    if (!isAdminSession(session) && file.conversationId) {
      const owner = await ctx.gatewayDatabaseService.getChatConversationOwner(file.conversationId);
      if (!owner || owner !== requestOwner) {
        reply.code(403);
        return { error: { type: "forbidden", message: "禁止访问该附件。" } };
      }
    }
    try {
      const data = await fs.readFile(file.filePath);
      reply.header("Content-Type", getContentType(file.filePath));
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(data);
    } catch {
      reply.code(404);
      return { error: { type: "not_found", message: "附件不存在。" } };
    }
  });

  app.get("/_gateway/branding-assets/:kind/:filename", async (request, reply) => {
    const params = request.params as { kind?: string; filename?: string };
    if (params.kind !== "app-icon" && params.kind !== "favicon") {
      reply.code(404);
      return { error: { type: "not_found", message: "资源不存在。" } };
    }

    const filename = path.basename(params.filename ?? "");
    if (!filename || filename !== params.filename || filename.includes("/") || filename.includes("\\")) {
      reply.code(400);
      return { error: { type: "validation_error", message: "资源文件名无效。" } };
    }

    const root = path.resolve(getBrandingAssetsDir(), params.kind);
    const filePath = path.resolve(root, filename);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      reply.code(403);
      return { error: { type: "forbidden", message: "禁止访问该文件。" } };
    }

    try {
      const data = await fs.readFile(filePath);
      reply.header("Content-Type", getContentType(filePath));
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.send(data);
    } catch {
      reply.code(404);
      return { error: { type: "not_found", message: "资源不存在。" } };
    }
  });

  async function buildAdminConfig(request: FastifyRequest) {
    const session = await getSessionFromRequest(request);
    const isAdmin = isAdminSession(session);
    const [status, models, modelCatalog, versionStatus, settings, profile, profiles, codexStatus, usage, users, currentUserRecord] = await Promise.all([
      ctx.authService.getStatus(),
      ctx.modelService.listModels("openai-codex", { includeLlmApiChannel: true }),
      ctx.modelService.getCatalog(),
      ctx.versionService.getVersionStatus(),
      ctx.configService.getSettings(),
      ctx.authService.getActiveProfile(),
      ctx.authService.listProfiles(),
      ctx.authService.getCodexStatus(),
      ctx.usageService.getSummary(),
      session ? ctx.gatewayDatabaseService.listUsers() : Promise.resolve([]),
      session ? ctx.gatewayDatabaseService.getUserByUsername(session.user) : Promise.resolve(null),
    ]);
    const origin = resolveOrigin(request);
    const visibleUsers = isAdmin ? users : users.filter((item) => item.username === session?.user);

    return {
      auth: session ? { user: session.user, role: session.role } : null,
      status,
      settings: serializeSettings(settings, isAdmin, Boolean(security.apiKeyHash), Boolean(currentUserRecord?.apiKeyHash)),
      models,
      modelCatalog,
      modelAutoRefresh: ctx.modelService.getAutoRefreshStatus(),
      versionStatus: isAdmin ? versionStatus : { ...versionStatus, latestVersion: undefined },
      profile: serializeProfile(profile),
      profiles: isAdmin ? profiles.map((item) => serializeManagedProfile(item)) : [],
      users: visibleUsers.map((item) => ({
        username: item.username,
        displayName: item.displayName,
      })),
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
    const hashRedirect = normalizeEncodedAdminHashRoute(rootAsset);
    if (hashRedirect) {
      return reply.redirect(hashRedirect);
    }
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
    const settings = ensureSecurityConfigured() ? await ctx.configService.getSettings() : null;
    if (settings?.branding.faviconUrl) {
      return reply.redirect(settings.branding.faviconUrl);
    }
    reply.code(204);
    return "";
  });

  app.get("/_gateway/health", async () => buildGatewayHealth(ctx));

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
      branding: settings?.branding ?? null,
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

  app.get("/_gateway/admin/users", async (request) => {
    const parsed = gatewayUsersQuerySchema.safeParse(request.query);
    const users = await ctx.gatewayDatabaseService.listUsers();
    const limit = parsed.success ? parsed.data.limit : undefined;
    const page = parsed.success ? parsed.data.page ?? 1 : 1;
    if (!limit) {
      return { users };
    }
    const start = (page - 1) * limit;
    return {
      users: users.slice(start, start + limit),
      total: users.length,
      page,
      pageSize: limit,
    };
  });

  app.get("/_gateway/admin/user-groups", async () => ({
    groups: await ctx.gatewayDatabaseService.listUserGroups(),
  }));

  app.post("/_gateway/admin/user-groups", async (request, reply) => {
    const parsed = gatewayUserGroupCreateSchema.safeParse(request.body);
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
      const group = await ctx.gatewayDatabaseService.createUserGroup(parsed.data);
      return {
        group,
        groups: await ctx.gatewayDatabaseService.listUserGroups(),
      };
    } catch (error) {
      reply.code(409);
      return {
        error: {
          type: "group_conflict",
          message: error instanceof Error && error.message ? error.message : "用户组创建失败，名称可能已存在。",
        },
      };
    }
  });

  app.put("/_gateway/admin/user-groups/:id", async (request, reply) => {
    const params = gatewayUserGroupParamsSchema.safeParse(request.params);
    const parsed = gatewayUserGroupUpdateSchema.safeParse(request.body);
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
    try {
      const group = await ctx.gatewayDatabaseService.updateUserGroup(params.data.id, parsed.data);
      if (!group) {
        reply.code(404);
        return {
          error: {
            type: "not_found",
            message: "用户组不存在。",
          },
        };
      }
      return {
        group,
        groups: await ctx.gatewayDatabaseService.listUserGroups(),
        users: await ctx.gatewayDatabaseService.listUsers(),
      };
    } catch (error) {
      reply.code(409);
      return {
        error: {
          type: "group_conflict",
          message: error instanceof Error && error.message ? error.message : "用户组更新失败，名称可能已存在。",
        },
      };
    }
  });

  app.delete("/_gateway/admin/user-groups/:id", async (request, reply) => {
    const params = gatewayUserGroupParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: params.error.issues[0]?.message ?? "请求参数错误",
        },
      };
    }
    const deleted = await ctx.gatewayDatabaseService.deleteUserGroup(params.data.id);
    if (!deleted) {
      reply.code(400);
      return {
        error: {
          type: "delete_group_failed",
          message: "用户组不存在，或至少需要保留一个用户组。",
        },
      };
    }
    return {
      ok: true,
      groups: await ctx.gatewayDatabaseService.listUserGroups(),
      users: await ctx.gatewayDatabaseService.listUsers(),
    };
  });

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
        groupId: parsed.data.groupId,
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

  app.post("/_gateway/admin/users/import-wecom-contacts", async (request, reply) => {
    const parsed = wecomContactImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message: parsed.error.issues[0]?.message ?? "通讯录导入数据格式错误",
        },
      };
    }
    const result = await ctx.gatewayDatabaseService.importWecomContacts({
      contacts: parsed.data.contacts,
      groupId: parsed.data.groupId,
    });
    return {
      result,
      users: await ctx.gatewayDatabaseService.listUsers(),
    };
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
      groupId: parsed.data.groupId,
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
    data: await ctx.modelService.listAvailableModels(),
    catalog: await ctx.modelService.getCatalog(),
  }));

  app.post("/_gateway/models/refresh", async () => {
    const result = await ctx.modelService.refreshModels();
    return {
      data: await ctx.modelService.listAvailableModels(),
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

  app.post("/_gateway/admin/branding-assets", async (request, reply) => {
    const session = await getSessionFromRequest(request);
    if (!isAdminSession(session)) {
      reply.code(403);
      return {
        error: {
          type: "forbidden",
          message: "只有管理员可以上传外观资源。",
        },
      };
    }

    const parsed = brandingAssetUploadSchema.safeParse(request.body);
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
      asset: await saveBrandingAsset(parsed.data),
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

    const { security: securityUpdate, ...settingsUpdate } = parsed.data;
    const session = await getSessionFromRequest(request);
    const hasGlobalSettingsUpdate = Object.values(settingsUpdate).some((value) => value !== undefined);
    if (!isAdminSession(session) && hasGlobalSettingsUpdate) {
      reply.code(403);
      return {
        error: {
          type: "forbidden",
          message: "普通用户只能管理自己的 API Key。",
        },
      };
    }
    const owner = requestOwnerFromSession(session);
    if (securityUpdate) {
      if (!owner) {
        reply.code(401);
        return {
          error: {
            type: "unauthorized",
            message: "Login required.",
          },
        };
      }
      if (securityUpdate.clearApiKey || securityUpdate.apiKey) {
        const nextApiKeyHash = securityUpdate.clearApiKey
          ? null
          : securityUpdate.apiKey
            ? hashSecret(securityUpdate.apiKey)
            : null;
        const updated = await ctx.gatewayDatabaseService.setUserApiKey(
          owner,
          nextApiKeyHash,
        );
        if (!updated) {
          reply.code(404);
          return {
            error: {
              type: "not_found",
              message: "当前用户不存在或已禁用。",
            },
          };
        }
      }
    }
    if (!hasGlobalSettingsUpdate) {
      return buildAdminConfig(request);
    }
    await ctx.configService.updateSettings({
      ...settingsUpdate,
    });
    return buildAdminConfig(request);
  });

  app.post("/_gateway/admin/llm-channel/test", async (request, reply) => {
    const parsed = llmChannelTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }
    const settings = await ctx.configService.getSettings();
    const saved = settings.llm.apiChannel;
    // 表单里没手动填模型时，回退到已保存的模型或已同步模型列表里的第一个，
    // 这样只填 Base URL + API Key 也能直接测试连接。
    const fallbackModel = saved.model?.trim() || (saved.models ?? []).map((item) => item.trim()).find(Boolean) || "";
    const channel: LlmApiChannelConfig = {
      enabled: true,
      mode: "primary",
      baseUrl: parsed.data.baseUrl?.trim() || saved.baseUrl,
      apiKey: parsed.data.apiKey?.trim() || saved.apiKey,
      model: parsed.data.model?.trim() || fallbackModel,
      models: saved.models ?? [],
    };
    if (!channel.baseUrl || !channel.apiKey) {
      reply.code(400);
      return { error: { type: "validation_error", message: "请先填写 Base URL 和 API Key。" } };
    }
    if (!channel.model) {
      reply.code(400);
      return { error: { type: "validation_error", message: "请先选择渠道模型，或先点「同步模型列表」后再测试。" } };
    }
    const startedAt = performance.now();
    const result = await requestLlmChatCompletion({
      channel,
      messages: [{ role: "user", content: "请只回复：连接成功" }],
      maxTokens: 32,
      timeoutMs: 20_000,
    });
    return {
      ok: true,
      model: result.model,
      latencyMs: Math.round(performance.now() - startedAt),
      reply: result.text.slice(0, 200),
    };
  });

  app.post("/_gateway/admin/llm-channel/models", async (request, reply) => {
    const parsed = llmChannelModelsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { type: "validation_error", message: parsed.error.issues[0]?.message ?? "请求体格式错误" } };
    }
    const settings = await ctx.configService.getSettings();
    const saved = settings.llm.apiChannel;
    const baseUrl = parsed.data.baseUrl?.trim() || saved.baseUrl;
    const apiKey = parsed.data.apiKey?.trim() || saved.apiKey;
    if (!baseUrl || !apiKey) {
      reply.code(400);
      return { error: { type: "validation_error", message: "请先填写 Base URL 和 API Key。" } };
    }
    const models = await listLlmApiChannelModels({ baseUrl, apiKey, timeoutMs: 15_000 });
    return { ok: true, count: models.length, models };
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
      const failedLlmChannel = resolveLlmApiChannel((await ctx.configService.getSettings()).llm?.apiChannel);
      pushGatewayRequestLog({
        method: request.method,
        endpoint: request.url,
        account: failedLlmChannel?.mode === "primary" ? "大模型 API 渠道" : profileLogLabel(activeProfile),
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
          ...(failedLlmChannel ? { llmChannel: true } : {}),
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

    const llmChannelResult = isLlmChannelChatResult(result);
    const activeProfile = llmChannelResult ? null : result.profile ?? await ctx.authService.getActiveProfile();
    pushGatewayRequestLog({
      id: request.id,
      method: request.method,
      endpoint: request.url,
      account: llmChannelResult ? "大模型 API 渠道" : profileLogLabel(activeProfile),
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

    const settings = await ctx.configService.getSettings();
    parsed.data.model ??= settings.modelRouting.imageGenerationModel;
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
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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

    const requestSummary = summarizeImageRequestForLog(parsed.data);
    console.info("[gateway:image] request accepted", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
    });

    const activeProfile = await ctx.authService.getActiveProfile();
    const imageGenerationTimeoutMs = getImageGenerationTimeoutMs(settings);
    const imageRoute: UsageImageRoute = resolveUsageImageRoute(settings, activeProfile);
    const ownerPolicy = await getImageOwnerPolicy(requestOwner);
    const limit = await checkImageGenerationLimit(requestOwner, settings);
    if (!limit.allowed) {
      return sendImageLimitResponse(reply, limit, {
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
    await ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      status: "queued",
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
    const runImageGenerationJob = async (): Promise<Record<string, unknown>> => {
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
            priority: ownerPolicy.priority,
            onQueued: async () => {
              await ctx.gatewayDatabaseService.saveGeneration({
                id: generationId,
                owner: requestOwner,
                createdAt: generationCreatedAt,
                status: "queued",
                endpoint: request.url,
                account: profileLogLabel(activeProfile),
                model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
            onStart: async (profile) => {
              startTimeout();
              generationStartedAt ??= Date.now();
              await ctx.gatewayDatabaseService.saveGeneration({
                id: generationId,
                owner: requestOwner,
                createdAt: generationCreatedAt,
                startedAt: generationStartedAt,
                status: "running",
                endpoint: request.url,
                account: profileLogLabel(profile),
                model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
          imageGenerationTimeoutMs,
          `图片生成超过 ${Math.floor(imageGenerationTimeoutMs / 1000)} 秒仍未完成，已超时。`,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        const statusCode = getErrorStatusCode(normalized);
        const imageFailureDetails = getImageFailureDetails(normalized);
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
          model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
          responseSummary: {
            parseFailure: {
              upstreamText: imageFailureDetails.upstreamText,
              debug: imageFailureDetails.imageDebug,
              raw: imageFailureDetails.raw,
            },
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
          model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
              upstreamText: imageFailureDetails.upstreamText,
              imageDebug: imageFailureDetails.imageDebug,
              raw: imageFailureDetails.raw,
            },
          },
          usage: {
            profile: failedProfile,
            imageRoute: failedImageRoute,
          },
        });
        if (parsed.data._gateway_webhook_url) {
          await postImageGenerationWebhook({
            url: parsed.data._gateway_webhook_url,
            generationId,
            status: "failed",
            error: normalized.message,
          });
        }
        await notifyBackgroundImageResult({
          settings,
          request,
          background: Boolean(parsed.data._gateway_background) && !isWecomInternalRequest(request),
          owner: requestOwner,
          generationId,
          status: "failed",
          prompt: parsed.data.prompt,
          durationMs,
          error: normalized.message,
        });
        throw error;
      }

    const responseProfile = response._gatewayProfile ?? activeProfile;
    const responseImageRoute: UsageImageRoute = response._gatewayImageRoute ?? resolveUsageImageRoute(settings, responseProfile);
    const imageAccountLabel = responseImageRoute === "api-channel" ? "API 渠道" : profileLogLabel(responseProfile);
    const { _gatewayProfile: _generationProfile, _gatewayImageRoute: _generationImageRoute, ...publicResponse } = response;
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
      account: imageAccountLabel,
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
      account: imageAccountLabel,
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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

      const gatewayImages = savedGeneration ? toGatewayImageAssets(savedGeneration.images) : undefined;
      const finalResponse = savedGeneration ? { ...publicResponse, _gateway_images: gatewayImages } : publicResponse;
      if (parsed.data._gateway_webhook_url) {
        await postImageGenerationWebhook({
          url: parsed.data._gateway_webhook_url,
          generationId,
          status: "success",
          response: publicResponse,
          images: gatewayImages,
        });
      }
      const shareUrl = parsed.data._gateway_background && settings.wecom.notifyImageResult
        ? await createImageShareUrl(request, requestOwner, generationId)
        : undefined;
      await notifyBackgroundImageResult({
        settings,
        request,
        // 企微桥接自己推送结果，避免同一次生图再触发一条完成通知。
        background: Boolean(parsed.data._gateway_background) && !isWecomInternalRequest(request),
        owner: requestOwner,
        generationId,
        status: "success",
        prompt: parsed.data.prompt,
        imageCount: publicResponse.data.length,
        durationMs,
        shareUrl,
      });
      return finalResponse;
    };

    if (parsed.data._gateway_background) {
      void runImageGenerationJob().catch((error) => {
        const normalized = normalizeError(error);
        console.warn("[gateway:image] background generation failed", {
          requestId: generationId,
          message: normalized.message,
        });
      });
      reply.code(202);
      return {
        id: generationId,
        status: "queued",
        object: "image.generation.job",
        history_url: `${resolveOrigin(request)}/_gateway/generations/history/${encodeURIComponent(generationId)}`,
        webhook_url: parsed.data._gateway_webhook_url ? "configured" : undefined,
      };
    }

    return runImageGenerationJob();
  });

  app.post("/v1/images/edits", async (request, reply) => {
    const startedAt = performance.now();
    const requestOwner = await getRequestOwner(request);
    const session = await getSessionFromRequest(request);
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

    const settings = await ctx.configService.getSettings();
    parsed.data.model ??= settings.modelRouting.imageGenerationModel;
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
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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

    let imageReferences: Array<{ imageUrl: string }>;
    try {
      imageReferences = await resolveImageEditReferences(
        request,
        getImageEditReferences(parsed.data)
          .map((reference) => normalizeJsonImageReference(reference))
          .map((reference) => ({
            imageUrl: reference.imageUrl ?? "",
          })),
        {
          session,
          requestOwner,
          gatewayDatabaseService: ctx.gatewayDatabaseService,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gateway:image:edit] failed to resolve image references", {
        method: request.method,
        url: request.url,
        summary: summarizeImageEditRequestForLog(parsed.data),
        error: message,
      });
      pushGatewayRequestLog({
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        account: "-",
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
            message,
          },
        },
      });
      reply.code(400);
      return {
        error: {
          type: "validation_error",
          message,
        },
      };
    }
    const requestSummary = summarizeImageEditRequestForLog(parsed.data);
    console.info("[gateway:image:edit] request accepted", {
      method: request.method,
      url: request.url,
      summary: requestSummary,
    });

    const activeProfile = await ctx.authService.getActiveProfile();
    const imageGenerationTimeoutMs = getImageGenerationTimeoutMs(settings);
    const imageRoute: UsageImageRoute = resolveUsageImageRoute(settings, activeProfile);
    const ownerPolicy = await getImageOwnerPolicy(requestOwner);
    const limit = await checkImageGenerationLimit(requestOwner, settings);
    if (!limit.allowed) {
      return sendImageLimitResponse(reply, limit, {
        owner: requestOwner,
        method: request.method,
        endpoint: request.url,
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
    await ctx.gatewayDatabaseService.saveGeneration({
      id: generationId,
      owner: requestOwner,
      createdAt: generationCreatedAt,
      status: "queued",
      endpoint: request.url,
      account: profileLogLabel(activeProfile),
      model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
    const runImageEditJob = async (): Promise<Record<string, unknown>> => {
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
            priority: ownerPolicy.priority,
            onQueued: async () => {
              await ctx.gatewayDatabaseService.saveGeneration({
                id: generationId,
                owner: requestOwner,
                createdAt: generationCreatedAt,
                status: "queued",
                endpoint: request.url,
                account: profileLogLabel(activeProfile),
                model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
            onStart: async (profile) => {
              startTimeout();
              generationStartedAt ??= Date.now();
              await ctx.gatewayDatabaseService.saveGeneration({
                id: generationId,
                owner: requestOwner,
                createdAt: generationCreatedAt,
                startedAt: generationStartedAt,
                status: "running",
                endpoint: request.url,
                account: profileLogLabel(profile),
                model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
          imageGenerationTimeoutMs,
          `图片生成超过 ${Math.floor(imageGenerationTimeoutMs / 1000)} 秒仍未完成，已超时。`,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        const statusCode = getErrorStatusCode(normalized);
        const imageFailureDetails = getImageFailureDetails(normalized);
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
          model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
          responseSummary: {
            parseFailure: {
              upstreamText: imageFailureDetails.upstreamText,
              debug: imageFailureDetails.imageDebug,
              raw: imageFailureDetails.raw,
            },
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
          model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
              upstreamText: imageFailureDetails.upstreamText,
              imageDebug: imageFailureDetails.imageDebug,
              raw: imageFailureDetails.raw,
            },
          },
          usage: {
            profile: failedProfile,
            imageRoute: failedImageRoute,
          },
        });
        await notifyBackgroundImageResult({
          settings,
          request,
          background: Boolean(parsed.data._gateway_background),
          owner: requestOwner,
          generationId,
          status: "failed",
          prompt: parsed.data.prompt,
          durationMs,
          error: normalized.message,
        });
        throw error;
      }

      const responseProfile = response._gatewayProfile ?? activeProfile;
      const responseImageRoute: UsageImageRoute = response._gatewayImageRoute ?? resolveUsageImageRoute(settings, responseProfile);
    const imageAccountLabel = responseImageRoute === "api-channel" ? "API 渠道" : profileLogLabel(responseProfile);
      const { _gatewayProfile: _editProfile, _gatewayImageRoute: _editImageRoute, ...publicResponse } = response;
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
        account: imageAccountLabel,
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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
        account: imageAccountLabel,
        model: parsed.data.model ?? DEFAULT_IMAGE_MODEL,
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

      const shareUrl = parsed.data._gateway_background && settings.wecom.notifyImageResult
        ? await createImageShareUrl(request, requestOwner, generationId)
        : undefined;
      await notifyBackgroundImageResult({
        settings,
        request,
        background: Boolean(parsed.data._gateway_background),
        owner: requestOwner,
        generationId,
        status: "success",
        prompt: parsed.data.prompt,
        imageCount: publicResponse.data.length,
        durationMs,
        shareUrl,
      });
      return savedGeneration ? { ...publicResponse, _gateway_images: toGatewayImageAssets(savedGeneration.images) } : publicResponse;
    };

    if (parsed.data._gateway_background) {
      void runImageEditJob().catch((error) => {
        const normalized = normalizeError(error);
        console.warn("[gateway:image:edit] background generation failed", {
          requestId: generationId,
          message: normalized.message,
        });
      });
      reply.code(202);
      return {
        id: generationId,
        status: "queued",
        object: "image.generation.job",
        history_url: `${resolveOrigin(request)}/_gateway/generations/history/${encodeURIComponent(generationId)}`,
      };
    }

    return runImageEditJob();
  });

  // ---------------------------------------------------------------------------
  // 企业微信「接收消息」回调（公开路径，无登录）
  // ---------------------------------------------------------------------------

  app.get(WECOM_CALLBACK_PATH, async (request, reply) => {
    await ensureBootstrapUsers();
    const settings = await ctx.configService.getSettings();
    if (!isWecomCallbackConfigured(settings.wecom)) {
      reply.code(404);
      return reply.type("text/plain; charset=utf-8").send("企业微信回调未配置");
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    try {
      const echo = buildWecomVerifyEcho(toWecomCallbackSettings(settings.wecom), {
        msg_signature: getWecomCallbackQueryValue(request, query, "msg_signature"),
        timestamp: getWecomCallbackQueryValue(request, query, "timestamp"),
        nonce: getWecomCallbackQueryValue(request, query, "nonce"),
        echostr: getWecomCallbackQueryValue(request, query, "echostr"),
      });
      recordWecomCallbackVerified();
      return reply.type("text/plain; charset=utf-8").send(echo);
    } catch (error) {
      recordWecomCallbackError("verify", error);
      reply.code(400);
      return reply.type("text/plain; charset=utf-8").send(`企业微信回调校验失败：${errorText(error)}`);
    }
  });

  app.post(WECOM_CALLBACK_PATH, async (request, reply) => {
    await ensureBootstrapUsers();
    const settings = await ctx.configService.getSettings();
    if (!isWecomCallbackConfigured(settings.wecom)) {
      return reply.type("text/plain; charset=utf-8").send("success");
    }
    const rawBody = typeof request.body === "string" ? request.body : "";
    if (!rawBody.trim()) {
      return reply.type("text/plain; charset=utf-8").send("success");
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    let incoming: WecomIncomingMessage;
    try {
      incoming = parseWecomIncomingMessage(toWecomCallbackSettings(settings.wecom), rawBody, {
        msg_signature: getWecomCallbackQueryValue(request, query, "msg_signature"),
        timestamp: getWecomCallbackQueryValue(request, query, "timestamp"),
        nonce: getWecomCallbackQueryValue(request, query, "nonce"),
      });
    } catch (error) {
      recordWecomCallbackError("parse", error);
      console.warn("[gateway:wecom] callback parse failed", { message: errorText(error) });
      reply.code(400);
      return reply.type("text/plain; charset=utf-8").send("企业微信回调解析失败");
    }

    // 企微在 5 秒内没收到响应会重推同一条消息，按 MsgId 去重。
    const msgId = incoming.msgId?.trim();
    if (msgId) {
      if (wecomSeenMessageIds.has(msgId)) {
        return reply.type("text/plain; charset=utf-8").send("");
      }
      wecomSeenMessageIds.set(msgId, Date.now());
    }
    recordWecomIncomingMessage(incoming);
    const fromUser = incoming.fromUser.trim();
    if (!fromUser) {
      return reply.type("text/plain; charset=utf-8").send("");
    }

    try {
      if (incoming.msgType === "event") {
        if (!incoming.event || incoming.event === "enter_agent") {
          return sendWecomPassiveReply(reply, settings.wecom, { toUser: fromUser, content: WECOM_WELCOME_MESSAGE });
        }
        return reply.type("text/plain; charset=utf-8").send("");
      }
      if (incoming.msgType !== "text") {
        return sendWecomPassiveReply(reply, settings.wecom, { toUser: fromUser, content: WECOM_UNSUPPORTED_MESSAGE });
      }
      const content = (incoming.content ?? "").trim().slice(0, 4000);
      if (!content) {
        return reply.type("text/plain; charset=utf-8").send("");
      }
      if (!settings.wecom.enabled || !settings.wecom.chatEnabled) {
        return sendWecomPassiveReply(reply, settings.wecom, { toUser: fromUser, content: WECOM_CHAT_DISABLED_MESSAGE });
      }
      const accepted = enqueueWecomChatTask({
        request,
        userId: fromUser,
        settings,
        content,
      });
      if (!accepted) {
        return sendWecomPassiveReply(reply, settings.wecom, { toUser: fromUser, content: WECOM_BUSY_MESSAGE });
      }
      // 被动回复必须在 5 秒内返回，异步任务把真正的回复用应用消息推送。
      return sendWecomPassiveReply(reply, settings.wecom, { toUser: fromUser, content: WECOM_THINKING_MESSAGE });
    } catch (error) {
      recordWecomCallbackError("reply", error);
      console.warn("[gateway:wecom] callback reply failed", { message: errorText(error) });
      return reply.type("text/plain; charset=utf-8").send("success");
    }
  });

  // ---------------------------------------------------------------------------
  // 企业微信管理接口（管理员）
  // ---------------------------------------------------------------------------

  app.get("/_gateway/admin/wecom/status", async (request) => {
    const settings = await ctx.configService.getSettings();
    return {
      callbackUrl: `${resolveOrigin(request)}${WECOM_CALLBACK_PATH}`,
      configured: isWecomCallbackConfigured(settings.wecom),
      chatEnabled: settings.wecom.chatEnabled,
      startedAt: wecomCallbackState.startedAt,
      lastVerifiedAt: wecomCallbackState.lastVerifiedAt,
      lastMessageAt: wecomCallbackState.lastMessageAt,
      lastMessageType: wecomCallbackState.lastMessageType,
      lastMessageUser: wecomCallbackState.lastMessageUser,
      lastReplyAt: wecomCallbackState.lastReplyAt,
      pendingJobs: wecomCallbackState.pendingJobs,
      lastError: wecomCallbackState.lastError,
      lastPushAt: wecomCallbackState.lastPushAt,
      lastPushError: wecomCallbackState.lastPushError,
    };
  });

  app.post("/_gateway/admin/wecom/self-test", async (request) => {
    const settings = await ctx.configService.getSettings();
    const wecom = settings.wecom;
    const callbackConfigured = isWecomCallbackConfigured(wecom);
    const tokenOk = /^[A-Za-z0-9]{1,32}$/.test(wecom.callbackToken.trim());
    const aesKeyOk = /^[A-Za-z0-9+/]{43}$/.test(wecom.callbackAesKey.trim());
    const checks: WecomSelfTestCheck[] = [];

    const configProblems = [
      wecom.enabled ? undefined : "未启用企业微信",
      wecom.corpId.trim() ? undefined : "缺少企业 ID",
      wecom.agentId.trim() ? undefined : "缺少 AgentID",
      wecom.secret.trim() ? undefined : "缺少 Secret",
      wecom.callbackToken.trim() ? (tokenOk ? undefined : "Token 需为 1-32 位字母数字") : "缺少接收消息 Token",
      wecom.callbackAesKey.trim() ? (aesKeyOk ? undefined : "EncodingAESKey 需为 43 位 base64 字符") : "缺少 EncodingAESKey",
    ].filter((item): item is string => Boolean(item));
    checks.push({
      id: "config",
      label: "企业微信配置完整性",
      ok: configProblems.length === 0 && callbackConfigured,
      detail: configProblems.join("；") || "企业 ID、AgentID、Secret、Token、EncodingAESKey 均已填写。",
    });

    if (wecom.corpId.trim() && wecom.secret.trim()) {
      try {
        const pushCheck = await checkWecomPushCredentials(toWecomPushConfig(wecom));
        checks.push({
          id: "accessToken",
          label: "应用凭证可用性（gettoken）",
          ok: pushCheck.ok,
          detail: pushCheck.detail,
        });
      } catch (error) {
        checks.push({
          id: "accessToken",
          label: "应用凭证可用性（gettoken）",
          ok: false,
          detail: errorText(error),
        });
      }
    } else {
      checks.push({
        id: "accessToken",
        label: "应用凭证可用性（gettoken）",
        ok: false,
        detail: "缺少企业 ID 或 Secret，无法获取 access_token。",
      });
    }

    if (callbackConfigured) {
      try {
        const selfTest = runWecomCallbackSelfTest(toWecomCallbackSettings(wecom));
        const failures = selfTest.checks
          .filter((item) => !item.ok)
          .map((item) => (item.detail ? `${item.label}：${item.detail}` : item.label));
        checks.push({
          id: "crypto",
          label: "回调加解密自检",
          ok: selfTest.ok,
          detail: selfTest.ok ? "加解密回环、签名校验、被动回复均通过。" : failures.join("；") || "回调加解密自检未通过。",
        });
        for (const item of selfTest.checks) {
          checks.push({ id: `crypto:${item.id}`, label: item.label, ok: item.ok, detail: item.detail });
        }
      } catch (error) {
        checks.push({ id: "crypto", label: "回调加解密自检", ok: false, detail: errorText(error) });
      }
    } else {
      checks.push({
        id: "crypto",
        label: "回调加解密自检",
        ok: false,
        detail: "请先启用企业微信并填写企业 ID、接收消息 Token 与 EncodingAESKey。",
      });
    }

    const callbackUrl = `${resolveOrigin(request)}${WECOM_CALLBACK_PATH}`;
    checks.push({
      id: "endpoint",
      label: "回调地址可构造",
      ok: /^https?:\/\//i.test(callbackUrl),
      detail: callbackUrl,
    });

    return { ok: checks.every((item) => item.ok), checks };
  });

  app.post("/_gateway/admin/wecom/test-message", async (request, reply) => {
    const parsed = wecomTestMessageSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: { message: parsed.error.issues[0]?.message ?? "企业微信 UserId 格式错误。" } };
    }
    const settings = await ctx.configService.getSettings();
    if (!isWecomPushConfigured(settings.wecom)) {
      reply.code(400);
      return { error: { message: "请先启用企业微信并填写企业 ID、AgentID 和 Secret。" } };
    }
    try {
      await sendWecomTestMessage({
        config: toWecomPushConfig(settings.wecom),
        userId: parsed.data.userId,
        content: WECOM_TEST_MESSAGE,
      });
      recordWecomPushSuccess();
      return { ok: true };
    } catch (error) {
      recordWecomPushError(error);
      reply.code(400);
      return { error: { message: errorText(error) } };
    }
  });

  app.addHook("onClose", async () => {
    clearInterval(wecomMsgIdSweepTimer);
  });

  return app;
}
