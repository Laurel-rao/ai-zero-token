import { createHash } from "node:crypto";
import { requestText } from "../providers/http-client.js";
import type { GatewaySettings } from "../types.js";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
const WECOM_USERNAME_PREFIX = "wxwork:";
const WECOM_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const WECOM_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;
const WECOM_TEXT_MAX_BYTES = 2000;
const WECOM_INVALID_TOKEN_ERROR_CODES = new Set([40014, 42001]);

type CachedAccessToken = {
  token: string;
  expiresAt: number;
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

function isWecomConfigured(settings: GatewaySettings): boolean {
  const wecom = settings.wecom;
  return Boolean(wecom?.corpId?.trim() && wecom?.agentId?.trim() && wecom?.secret?.trim());
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

async function requestWecomApi(url: string, body?: string): Promise<WecomApiResponse> {
  const response = await requestText({
    method: body ? "POST" : "GET",
    url,
    body,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    timeoutMs: 20_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("企业微信接口返回不是有效 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("企业微信接口返回格式错误。");
  }
  return parsed as WecomApiResponse;
}

function wecomResponseError(response: WecomApiResponse, action: string): Error | undefined {
  const errcode = Number(response.errcode ?? 0);
  if (errcode === 0) {
    return undefined;
  }
  const errmsg = response.errmsg ? `: ${response.errmsg}` : "";
  return new Error(`企业微信${action}失败 ${errcode}${errmsg}`);
}

async function fetchWecomAccessToken(params: { corpId: string; secret: string }): Promise<string> {
  const url = new URL(`${WECOM_API_BASE}/gettoken`);
  url.searchParams.set("corpid", params.corpId);
  url.searchParams.set("corpsecret", params.secret);
  const response = await requestWecomApi(url.toString());
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

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function cacheKeyFor(params: { corpId: string; secret: string }): string {
  return `${params.corpId}|${hashSecret(params.secret)}`;
}

async function getCachedWecomAccessToken(params: { corpId: string; secret: string }): Promise<string> {
  const cached = accessTokenCache.get(cacheKeyFor(params));
  if (cached && cached.expiresAt - WECOM_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  return fetchWecomAccessToken(params);
}

function invalidateWecomAccessToken(corpId: string, secret: string): void {
  accessTokenCache.delete(cacheKeyFor({ corpId, secret }));
}

export async function sendWecomTextMessage(params: {
  corpId: string;
  agentId: string;
  secret: string;
  touser: string;
  content: string;
}): Promise<void> {
  const agentId = Number.parseInt(params.agentId, 10);
  if (!Number.isFinite(agentId)) {
    throw new Error(`企业微信 AgentID 不是有效数字：${params.agentId}`);
  }
  const payload = JSON.stringify({
    touser: params.touser,
    msgtype: "text",
    agentid: agentId,
    text: { content: params.content },
    safe: 0,
    enable_id_trans: 0,
    // 同一个提示词可能被反复提交，关闭企微的去重检查，保证每次都推送。
    enable_duplicate_check: 0,
  });

  const send = async (token: string): Promise<WecomApiResponse> => {
    const url = new URL(`${WECOM_API_BASE}/message/send`);
    url.searchParams.set("access_token", token);
    return requestWecomApi(url.toString(), payload);
  };

  let token = await getCachedWecomAccessToken({ corpId: params.corpId, secret: params.secret });
  let response = await send(token);
  if (WECOM_INVALID_TOKEN_ERROR_CODES.has(Number(response.errcode ?? 0))) {
    invalidateWecomAccessToken(params.corpId, params.secret);
    token = await getCachedWecomAccessToken({ corpId: params.corpId, secret: params.secret });
    response = await send(token);
  }
  const error = wecomResponseError(response, "发送应用消息");
  if (error) {
    throw error;
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
      corpId: settings.wecom.corpId.trim(),
      agentId: settings.wecom.agentId.trim(),
      secret: settings.wecom.secret.trim(),
      touser,
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
