import { createHash } from "node:crypto";
import { requestText } from "../providers/http-client.js";
import type { GatewaySettings } from "../types.js";

const WECOM_API_BASE_DEFAULT = "https://qyapi.weixin.qq.com";
const WECOM_API_BASE_ENV = "AZT_WECOM_API_BASE";
const WECOM_USERNAME_PREFIX = "wxwork:";
const WECOM_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const WECOM_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;
const WECOM_TEXT_MAX_BYTES = 2000;
const WECOM_TEXT_SEND_MAX_BYTES = 2048;
const WECOM_TEXT_MAX_SEGMENTS = 4;
const WECOM_TEXT_TRUNCATED_SUFFIX = "…（内容较长已截断）";
const WECOM_REQUEST_TIMEOUT_MS = 20_000;
const WECOM_INVALID_TOKEN_ERROR_CODES = new Set([40014, 42001]);
const WECOM_TEXT_BREAK_CHARS = new Set(["\n", "。", "！", "？", "；"]);

type CachedAccessToken = {
  token: string;
  expiresAt: number;
};

type WecomTokenParams = {
  apiBase: string;
  corpId: string;
  secret: string;
};

/**
 * 企业微信主动推送（应用消息 / 素材上传）配置。
 * apiBase 仅用于本地联调：优先取 config.apiBase，其次 AZT_WECOM_API_BASE 环境变量，
 * 最后回落到官方地址 https://qyapi.weixin.qq.com。
 */
export type WecomPushConfig = {
  corpId: string;
  agentId: string;
  secret: string;
  apiBase?: string;
};

const accessTokenCache = new Map<string, CachedAccessToken>();

export type WecomImageNoticeStatus = "success" | "failed";

export type WecomImageNoticeParams = {
  settings: GatewaySettings;
  owner?: string;
  generationId: string;
  status: WecomImageNoticeStatus;
  prompt?: string;
  imageCount?: number;
  durationMs?: number;
  error?: string;
  historyUrl?: string;
};

type WecomApiResponse = {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
};

type WecomMediaUploadResponse = WecomApiResponse & {
  media_id?: string;
  type?: string;
  created_at?: string;
};

function isWecomConfigured(settings: GatewaySettings): boolean {
  const wecom = settings.wecom;
  return Boolean(wecom?.corpId?.trim() && wecom?.agentId?.trim() && wecom?.secret?.trim());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWecomError(prefix: string, error: unknown): Error {
  const message = messageOf(error);
  return new Error(message.startsWith("企业微信") ? message : `${prefix}：${message}`);
}

/**
 * 企业微信导入/扫码登录创建的账号形如 `wxwork:zhangsan`，这里还原成企微 UserId。
 * 其它账号（admin、手工创建用户）没有企微身份，直接跳过推送。
 */
export function resolveWecomUserId(owner?: string | null): string | undefined {
  const normalized = owner?.trim();
  if (!normalized || !normalized.toLowerCase().startsWith(WECOM_USERNAME_PREFIX)) {
    return undefined;
  }
  const userId = normalized.slice(WECOM_USERNAME_PREFIX.length).trim();
  return userId || undefined;
}

function truncateText(value: string | undefined, maxChars: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = value;
  while (result.length > 0 && Buffer.byteLength(`${result}…`, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const char of Array.from(value)) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    result += char;
  }
  return result;
}

function formatDuration(durationMs?: number): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

export function buildWecomImageNoticeContent(params: {
  status: WecomImageNoticeStatus;
  prompt?: string;
  imageCount?: number;
  durationMs?: number;
  error?: string;
  historyUrl?: string;
}): string {
  const lines: string[] = [];
  if (params.status === "success") {
    const count = params.imageCount && params.imageCount > 0 ? params.imageCount : undefined;
    const duration = formatDuration(params.durationMs);
    lines.push("【生图完成】");
    const summaryParts: string[] = [];
    if (count) {
      summaryParts.push(`${count} 张`);
    }
    if (duration) {
      summaryParts.push(`用时 ${duration}`);
    }
    if (summaryParts.length > 0) {
      lines.push(summaryParts.join(" · "));
    }
  } else {
    lines.push("【生图失败】");
    const reason = truncateText(params.error, 200);
    lines.push(reason ? `原因：${reason}` : "原因：上游未返回具体错误信息。");
  }
  const prompt = truncateText(params.prompt, 80);
  if (prompt) {
    lines.push(`提示词：${prompt}`);
  }
  if (params.historyUrl) {
    lines.push(`查看：${params.historyUrl}`);
  }
  return truncateBytes(lines.join("\n"), WECOM_TEXT_MAX_BYTES);
}

/**
 * 解析企业微信 API 基地址：config.apiBase > AZT_WECOM_API_BASE > 官方地址。
 * 返回值不带结尾斜杠，供拼接 `/cgi-bin/...` 使用。
 */
function resolveWecomApiBase(apiBase?: string): string {
  const raw =
    apiBase?.trim() || process.env[WECOM_API_BASE_ENV]?.trim() || WECOM_API_BASE_DEFAULT;
  const normalized = raw.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`企业微信 API 地址无效：${raw}`);
  }
  return normalized;
}

function parseWecomJson<T extends WecomApiResponse>(body: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("企业微信接口返回不是有效 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("企业微信接口返回格式错误。");
  }
  return parsed as T;
}

async function requestWecomApi(url: string, body?: string): Promise<WecomApiResponse> {
  const response = await requestText({
    method: body ? "POST" : "GET",
    url,
    body,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    timeoutMs: WECOM_REQUEST_TIMEOUT_MS,
  });
  return parseWecomJson<WecomApiResponse>(response.body);
}

function wecomResponseError(response: WecomApiResponse, action: string): Error | undefined {
  const errcode = Number(response.errcode ?? 0);
  if (errcode === 0) {
    return undefined;
  }
  const errmsg = response.errmsg ? `: ${response.errmsg}` : "";
  return new Error(`企业微信${action}失败 ${errcode}${errmsg}`);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function cacheKeyFor(params: WecomTokenParams): string {
  return `${params.apiBase}|${params.corpId}|${hashSecret(params.secret)}`;
}

function buildTokenParams(apiBase: string, config: WecomPushConfig): WecomTokenParams {
  const corpId = config.corpId?.trim() ?? "";
  const secret = config.secret?.trim() ?? "";
  if (!corpId) {
    throw new Error("企业微信推送配置缺少企业 ID（corpId）。");
  }
  if (!secret) {
    throw new Error("企业微信推送配置缺少应用 Secret。");
  }
  return { apiBase, corpId, secret };
}

async function fetchWecomAccessToken(params: WecomTokenParams): Promise<string> {
  const url = new URL(`${params.apiBase}/cgi-bin/gettoken`);
  url.searchParams.set("corpid", params.corpId);
  url.searchParams.set("corpsecret", params.secret);
  let response: WecomApiResponse;
  try {
    response = await requestWecomApi(url.toString());
  } catch (error) {
    throw toWecomError("企业微信获取 access_token 失败", error);
  }
  const error = wecomResponseError(response, "获取 access_token ");
  if (error) {
    throw error;
  }
  const token = response.access_token?.trim();
  if (!token) {
    throw new Error("企业微信未返回 access_token。");
  }
  const expiresInSeconds = Number(response.expires_in ?? 0);
  const ttlMs = expiresInSeconds > 0 ? expiresInSeconds * 1000 : WECOM_TOKEN_DEFAULT_TTL_MS;
  accessTokenCache.set(cacheKeyFor(params), {
    token,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

async function resolveWecomAccessToken(params: WecomTokenParams): Promise<string> {
  const cached = accessTokenCache.get(cacheKeyFor(params));
  if (cached && cached.expiresAt - WECOM_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  return fetchWecomAccessToken(params);
}

function invalidateWecomAccessToken(params: WecomTokenParams): void {
  accessTokenCache.delete(cacheKeyFor(params));
}

/**
 * 获取企业微信应用 access_token（带本地缓存，cache key 含 apiBase、corpId 与 secret 摘要）。
 */
export async function getWecomAccessToken(config: WecomPushConfig): Promise<string> {
  const apiBase = resolveWecomApiBase(config.apiBase);
  return resolveWecomAccessToken(buildTokenParams(apiBase, config));
}

/**
 * 按 UTF-8 字节长度切分长文本，优先在换行或中文句号/感叹号/问号/分号处断开。
 * 返回的每段（除单个字符本身就超限的极端情况）都不超过 maxBytes 字节。
 */
export function splitWecomText(content: string, maxBytes = WECOM_TEXT_SEND_MAX_BYTES): string[] {
  const limit =
    Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : WECOM_TEXT_SEND_MAX_BYTES;
  const normalized = content ?? "";
  if (!normalized) {
    return [];
  }
  const chars = Array.from(normalized);
  const segments: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    let breakAt = -1;
    while (end < chars.length) {
      const char = chars[end] ?? "";
      const charBytes = Buffer.byteLength(char, "utf8");
      if (bytes + charBytes > limit) {
        break;
      }
      bytes += charBytes;
      if (WECOM_TEXT_BREAK_CHARS.has(char)) {
        breakAt = end;
      }
      end += 1;
    }
    if (end === start) {
      // 单个字符就超过限制时无法继续拆分，只能单独成段。
      end = start + 1;
    }
    if (end < chars.length && breakAt >= start) {
      const breakLength = breakAt + 1 - start;
      const chunkLength = end - start;
      if (breakLength * 2 >= chunkLength) {
        end = breakAt + 1;
      }
    }
    const segment = chars.slice(start, end).join("");
    if (segment) {
      segments.push(segment);
    }
    start = end;
  }
  return segments;
}

function truncateSegments(segments: string[]): string[] {
  if (segments.length <= WECOM_TEXT_MAX_SEGMENTS) {
    return segments;
  }
  const kept = segments.slice(0, WECOM_TEXT_MAX_SEGMENTS);
  const suffix = WECOM_TEXT_TRUNCATED_SUFFIX;
  const budget = Math.max(0, WECOM_TEXT_SEND_MAX_BYTES - Buffer.byteLength(suffix, "utf8"));
  const last = kept[WECOM_TEXT_MAX_SEGMENTS - 1] ?? "";
  kept[WECOM_TEXT_MAX_SEGMENTS - 1] = `${truncateToBytes(last, budget)}${suffix}`;
  return kept;
}

function parseAgentId(value?: string): number {
  const normalized = value?.trim() ?? "";
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`企业微信 AgentID 不是有效数字：${normalized}`);
  }
  const agentId = Number.parseInt(normalized, 10);
  if (!Number.isFinite(agentId)) {
    throw new Error(`企业微信 AgentID 不是有效数字：${normalized}`);
  }
  return agentId;
}

async function sendWecomApplicationMessage(params: {
  config: WecomPushConfig;
  payload: Record<string, unknown>;
}): Promise<void> {
  const apiBase = resolveWecomApiBase(params.config.apiBase);
  const tokenParams = buildTokenParams(apiBase, params.config);
  const send = async (token: string): Promise<WecomApiResponse> => {
    const url = new URL(`${apiBase}/cgi-bin/message/send`);
    url.searchParams.set("access_token", token);
    try {
      return await requestWecomApi(url.toString(), JSON.stringify(params.payload));
    } catch (error) {
      throw toWecomError("企业微信发送应用消息失败", error);
    }
  };
  let token = await resolveWecomAccessToken(tokenParams);
  let response = await send(token);
  if (WECOM_INVALID_TOKEN_ERROR_CODES.has(Number(response.errcode ?? 0))) {
    invalidateWecomAccessToken(tokenParams);
    token = await resolveWecomAccessToken(tokenParams);
    response = await send(token);
  }
  const error = wecomResponseError(response, "发送应用消息");
  if (error) {
    throw error;
  }
}

/**
 * 发送企业微信文本应用消息。内容超过 2048 字节时自动切分为多条顺序发送，
 * 最多发送 4 段，超出的部分截断并追加提示。
 */
export async function sendWecomTextMessage(params: {
  config: WecomPushConfig;
  userId: string;
  content: string;
}): Promise<void> {
  const userId = params.userId?.trim();
  if (!userId) {
    throw new Error("企业微信推送缺少 UserId。");
  }
  const agentId = parseAgentId(params.config.agentId);
  const segments = truncateSegments(
    splitWecomText(params.content ?? "", WECOM_TEXT_SEND_MAX_BYTES),
  );
  if (segments.length === 0) {
    throw new Error("企业微信消息内容不能为空。");
  }
  for (const content of segments) {
    await sendWecomApplicationMessage({
      config: params.config,
      payload: {
        touser: userId,
        msgtype: "text",
        agentid: agentId,
        text: { content },
        safe: 0,
        enable_id_trans: 0,
        // 同一个提示词可能被反复提交，关闭企微的去重检查，保证每次都推送。
        enable_duplicate_check: 0,
      },
    });
  }
}

async function uploadWecomImage(params: {
  apiBase: string;
  tokenParams: WecomTokenParams;
  image: Buffer;
  filename: string;
}): Promise<string> {
  const upload = async (token: string): Promise<WecomMediaUploadResponse> => {
    const url = new URL(`${params.apiBase}/cgi-bin/media/upload`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("type", "image");
    const form = new FormData();
    form.append(
      "media",
      new Blob([new Uint8Array(params.image)], { type: "image/jpeg" }),
      params.filename,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(WECOM_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw toWecomError("企业微信上传图片素材失败", error);
    }
    const text = await response.text();
    return parseWecomJson<WecomMediaUploadResponse>(text);
  };

  let token = await resolveWecomAccessToken(params.tokenParams);
  let response = await upload(token);
  if (WECOM_INVALID_TOKEN_ERROR_CODES.has(Number(response.errcode ?? 0))) {
    invalidateWecomAccessToken(params.tokenParams);
    token = await resolveWecomAccessToken(params.tokenParams);
    response = await upload(token);
  }
  const error = wecomResponseError(response, "上传图片素材");
  if (error) {
    throw error;
  }
  const mediaId = response.media_id?.trim();
  if (!mediaId) {
    throw new Error("企业微信上传图片素材失败：接口未返回 media_id。");
  }
  return mediaId;
}

/**
 * 发送企业微信图片应用消息：先上传临时素材拿 media_id，再发 msgtype=image 的应用消息。
 */
export async function sendWecomImageMessage(params: {
  config: WecomPushConfig;
  userId: string;
  image: Buffer;
  filename?: string;
}): Promise<void> {
  const userId = params.userId?.trim();
  if (!userId) {
    throw new Error("企业微信推送缺少 UserId。");
  }
  if (!params.image || params.image.length === 0) {
    throw new Error("企业微信图片消息缺少图片内容。");
  }
  const agentId = parseAgentId(params.config.agentId);
  const apiBase = resolveWecomApiBase(params.config.apiBase);
  const tokenParams = buildTokenParams(apiBase, params.config);
  const filename = params.filename?.trim() || "image.jpg";
  const mediaId = await uploadWecomImage({
    apiBase,
    tokenParams,
    image: params.image,
    filename,
  });
  await sendWecomApplicationMessage({
    config: params.config,
    payload: {
      touser: userId,
      msgtype: "image",
      agentid: agentId,
      image: { media_id: mediaId },
      safe: 0,
      enable_duplicate_check: 0,
    },
  });
}

const WECOM_TEST_MESSAGE_CONTENT =
  "【AI Zero Token】企业微信推送测试消息：收到此消息说明 corpId / agentId / secret 配置可用。";

/**
 * 发送一条测试消息，用于管理端「测试推送」按钮。
 */
export async function sendWecomTestMessage(params: {
  config: WecomPushConfig;
  userId: string;
  content?: string;
}): Promise<void> {
  const content = params.content?.trim() || WECOM_TEST_MESSAGE_CONTENT;
  await sendWecomTextMessage({
    config: params.config,
    userId: params.userId,
    content,
  });
}

/**
 * 校验企业微信推送凭证：corpId / secret 通过 gettoken 校验，agentId 只做数字格式校验
 * （gettoken 接口本身不校验 agentId）。不抛错，统一返回 { ok, detail }。
 */
export async function checkWecomPushCredentials(
  config: WecomPushConfig,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const corpId = config.corpId?.trim() ?? "";
    const secret = config.secret?.trim() ?? "";
    if (!corpId) {
      return { ok: false, detail: "未配置企业 ID（corpId）。" };
    }
    if (!secret) {
      return { ok: false, detail: "未配置应用 Secret。" };
    }
    let agentId: number;
    try {
      agentId = parseAgentId(config.agentId);
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
    // 强制真实调一次 gettoken，避免命中旧缓存后误报可用。
    const tokenParams = buildTokenParams(resolveWecomApiBase(config.apiBase), {
      corpId,
      agentId: String(agentId),
      secret,
      apiBase: config.apiBase,
    });
    invalidateWecomAccessToken(tokenParams);
    await resolveWecomAccessToken(tokenParams);
    return { ok: true, detail: "企业微信 corpId / secret 校验通过，AgentID 格式正确。" };
  } catch (error) {
    return { ok: false, detail: messageOf(error) };
  }
}

/**
 * 生图任务结束（成功或失败）后，向提交人推送一条企业微信应用消息。
 * 只处理企业微信账号；未配置、未开启或推送失败时静默降级，不影响生图主流程。
 */
export async function notifyWecomImageResult(params: WecomImageNoticeParams): Promise<void> {
  try {
    const settings = params.settings;
    if (!settings.wecom?.notifyImageResult || !isWecomConfigured(settings)) {
      return;
    }
    const touser = resolveWecomUserId(params.owner);
    if (!touser) {
      return;
    }
    const content = buildWecomImageNoticeContent({
      status: params.status,
      prompt: params.prompt,
      imageCount: params.imageCount,
      durationMs: params.durationMs,
      error: params.error,
      historyUrl: params.historyUrl,
    });
    await sendWecomTextMessage({
      config: {
        corpId: settings.wecom.corpId.trim(),
        agentId: settings.wecom.agentId.trim(),
        secret: settings.wecom.secret.trim(),
      },
      userId: touser,
      content,
    });
  } catch (error) {
    console.warn("[gateway:wecom] image notification failed", {
      generationId: params.generationId,
      owner: params.owner,
      status: params.status,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
