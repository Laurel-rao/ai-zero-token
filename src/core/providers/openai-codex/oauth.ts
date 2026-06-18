import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AccountIdSource, OAuthProfile } from "../../types.js";
import { requestText } from "../http-client.js";
import { generatePKCE } from "./pkce.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const PROFILE_CLAIM_PATH = "https://api.openai.com/profile";
const DEFAULT_CALLBACK_TIMEOUT_MS = 180_000;
const SUCCESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OAuth Success</title>
</head>
<body>
  <p>登录成功，请回到终端继续。</p>
</body>
</html>`;

type AuthorizationResult = {
  code?: string;
  state?: string;
};

type TokenResult = {
  access: string;
  refresh: string;
  idToken?: string;
  expires: number;
};

export type OpenAICodexLoginOptions = {
  allowManualCode?: boolean;
  callbackTimeoutMs?: number;
};

export type OpenAICodexLoginSession = {
  state: string;
  authorizeUrl: string;
  waitForCode: (timeoutMs: number) => Promise<string | null>;
  completeWithCode: (code: string) => Promise<OAuthProfile>;
  completeWithInput: (input: string) => Promise<OAuthProfile>;
  close: () => void;
};

export type OpenAICodexRemoteLoginSession = {
  state: string;
  authorizeUrl: string;
  completeWithInput: (input: string) => Promise<OAuthProfile>;
};

type UpstreamErrorBody = {
  message?: string;
  type?: string;
  code?: string;
};

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1] ?? "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(normalized + padding, "base64").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractEmailFromPayload(payload: Record<string, unknown> | null): string | undefined {
  const profileClaim = payload?.[PROFILE_CLAIM_PATH] as Record<string, unknown> | undefined;
  const nestedEmail = profileClaim?.email;
  if (typeof nestedEmail === "string" && nestedEmail.trim()) {
    return nestedEmail.trim();
  }

  const topLevelEmail = payload?.email;
  if (typeof topLevelEmail === "string" && topLevelEmail.trim()) {
    return topLevelEmail.trim();
  }

  return undefined;
}

function hashAccessToken(access: string): string {
  return createHash("sha256").update(access).digest("hex");
}

function resolveCodexAccountId(profile?: Pick<OAuthProfile, "accountId" | "codexAccountId" | "accountIdSource">): string | undefined {
  if (!profile) {
    return undefined;
  }
  return profile.codexAccountId ?? (!profile.accountIdSource ? profile.accountId : undefined);
}

type ExtractedIdentity = {
  accountId: string;
  codexAccountId?: string;
  source: AccountIdSource;
};

function extractIdentity(
  accessToken: string,
  payload: Record<string, unknown> | null,
  fallback?: Pick<OAuthProfile, "accountId" | "codexAccountId" | "accountIdSource">,
): ExtractedIdentity {
  const authClaim = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const tokenAccountId = getString(authClaim?.chatgpt_account_id);
  if (tokenAccountId) {
    return {
      accountId: tokenAccountId,
      codexAccountId: tokenAccountId,
      source: "chatgpt_account_id",
    };
  }

  if (fallback?.accountId) {
    return {
      accountId: fallback.accountId,
      codexAccountId: resolveCodexAccountId(fallback),
      source: fallback.accountIdSource ?? "chatgpt_account_id",
    };
  }

  const chatGptUserId = getString(authClaim?.chatgpt_user_id);
  if (chatGptUserId) {
    return {
      accountId: chatGptUserId,
      source: "chatgpt_user_id",
    };
  }

  const userId = getString(authClaim?.user_id);
  if (userId) {
    return {
      accountId: userId,
      source: "user_id",
    };
  }

  const subject = getString(payload?.sub);
  if (subject) {
    return {
      accountId: subject,
      source: "sub",
    };
  }

  const email = extractEmailFromPayload(payload);
  if (email) {
    return {
      accountId: `email:${email.toLowerCase()}`,
      source: "email",
    };
  }

  return {
    accountId: `access:${hashAccessToken(accessToken).slice(0, 32)}`,
    source: "access_token_sha256",
  };
}

function parseUpstreamErrorBody(body: string): UpstreamErrorBody | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const error = parsed.error;
    if (!error || typeof error !== "object") {
      return undefined;
    }

    const record = error as Record<string, unknown>;
    return {
      message: typeof record.message === "string" ? record.message : undefined,
      type: typeof record.type === "string" ? record.type : undefined,
      code: typeof record.code === "string" ? record.code : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseAuthorizationInput(value: string): AuthorizationResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // ignore
  }

  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    return { code, state };
  }

  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(trimmed);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: trimmed };
}

function extractProfile(
  accessToken: string,
  refreshToken: string,
  expires: number,
  idToken?: string,
  fallback?: Pick<OAuthProfile, "accountId" | "codexAccountId" | "accountIdSource" | "email">,
): OAuthProfile {
  const payload = decodeJwtPayload(accessToken);
  const identity = extractIdentity(accessToken, payload, fallback);
  const email = extractEmailFromPayload(payload) ?? fallback?.email;

  return {
    provider: "openai-codex",
    profileId: `openai-codex:${identity.accountId}`,
    mode: "oauth_account",
    access: accessToken,
    refresh: refreshToken,
    idToken,
    expires,
    accountId: identity.accountId,
    codexAccountId: identity.codexAccountId,
    accountIdSource: identity.source,
    email,
  };
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenResult> {
  const response = await requestText({
    method: "POST",
    url: TOKEN_URL,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`授权码换 token 失败: HTTP ${response.status} via ${response.transport} ${response.body}`);
  }

  const json = JSON.parse(response.body) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("token 响应缺少 access_token / refresh_token / expires_in。");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    idToken: json.id_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshOpenAICodexToken(profile: OAuthProfile): Promise<OAuthProfile> {
  if (!profile.refresh) {
    throw new Error("该账号是导入的 ChatGPT session token，没有 refresh_token；session 过期后请重新导入。");
  }

  const response = await requestText({
    method: "POST",
    url: TOKEN_URL,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: profile.refresh,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (response.status < 200 || response.status >= 300) {
    const upstreamError = parseUpstreamErrorBody(response.body);
    const error = new Error(`刷新 token 失败: HTTP ${response.status} via ${response.transport} ${response.body}`) as Error & {
      upstreamStatus?: number;
      upstreamErrorCode?: string;
      upstreamErrorType?: string;
      upstreamErrorMessage?: string;
    };
    error.upstreamStatus = response.status;
    error.upstreamErrorCode = upstreamError?.code;
    error.upstreamErrorType = upstreamError?.type;
    error.upstreamErrorMessage = upstreamError?.message;
    throw error;
  }

  const json = JSON.parse(response.body) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("刷新响应缺少 access_token / refresh_token / expires_in。");
  }

  return extractProfile(
    json.access_token,
    json.refresh_token,
    Date.now() + json.expires_in * 1000,
    json.id_token ?? profile.idToken,
    {
      accountId: profile.accountId,
      codexAccountId: profile.codexAccountId,
      accountIdSource: profile.accountIdSource,
      email: profile.email,
    },
  );
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function tryOpenPrivateBrowser(url: string): boolean {
  if (process.platform === "darwin") {
    const browsers = [
      { app: "Google Chrome", args: ["--incognito", url] },
      { app: "Chromium", args: ["--incognito", url] },
      { app: "Microsoft Edge", args: ["--inprivate", url] },
      { app: "Brave Browser", args: ["--incognito", url] },
      { app: "Firefox", args: ["-private-window", url] },
    ];

    for (const browser of browsers) {
      try {
        const result = spawnSync("open", ["-na", browser.app, "--args", ...browser.args], {
          stdio: "ignore",
          timeout: 2_000,
        });
        if (result.status === 0) {
          return true;
        }
      } catch {
        // Try the next browser candidate.
      }
    }
    return false;
  }

  if (process.platform === "win32") {
    const browsers = [
      { command: "chrome", args: ["--incognito", url] },
      { command: "msedge", args: ["--inprivate", url] },
      { command: "brave", args: ["--incognito", url] },
      { command: "firefox", args: ["-private-window", url] },
    ];

    for (const browser of browsers) {
      if (commandExists(browser.command)) {
        return spawnDetached("cmd", ["/c", "start", "", browser.command, ...browser.args]);
      }
    }
    return false;
  }

  const browsers = [
    { command: "google-chrome", args: ["--incognito", url] },
    { command: "google-chrome-stable", args: ["--incognito", url] },
    { command: "chromium", args: ["--incognito", url] },
    { command: "chromium-browser", args: ["--incognito", url] },
    { command: "microsoft-edge", args: ["--inprivate", url] },
    { command: "brave-browser", args: ["--incognito", url] },
    { command: "firefox", args: ["--private-window", url] },
  ];

  for (const browser of browsers) {
    if (commandExists(browser.command)) {
      return spawnDetached(browser.command, browser.args);
    }
  }

  return false;
}

async function promptLine(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function listen(server: http.Server, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(1455, host);
  });
}

async function startLocalCallbackServer(expectedState: string): Promise<{
  close: () => void;
  waitForCode: (timeoutMs: number) => Promise<string | null>;
}> {
  let lastCode: string | null = null;
  let closed = false;

  const handleRequest: http.RequestListener = (req, res) => {
    try {
      const url = new URL(req.url || "", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }

      lastCode = code;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  };

  const servers = [http.createServer(handleRequest), http.createServer(handleRequest)];
  const errors: string[] = [];

  await Promise.all([
    listen(servers[0] as http.Server, "127.0.0.1").catch((error) => {
      errors.push(`127.0.0.1: ${error instanceof Error ? error.message : String(error)}`);
    }),
    listen(servers[1] as http.Server, "::1").catch((error) => {
      errors.push(`::1: ${error instanceof Error ? error.message : String(error)}`);
    }),
  ]);

  const listeningServers = servers.filter((server) => server.listening);
  if (listeningServers.length === 0) {
    throw new Error(`无法启动 OAuth 回调服务: ${errors.join("; ") || "未知错误"}`);
  }

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const server of listeningServers) {
        server.close();
      }
    },
    waitForCode: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (lastCode) {
          return lastCode;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    },
  };
}

function parseManualAuthorizationCode(input: string, expectedState: string): string {
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== expectedState) {
    throw new Error("state 不匹配，已拒绝本次授权结果。");
  }
  if (!parsed.code) {
    throw new Error("没有解析出 authorization code。");
  }
  return parsed.code;
}

async function requestManualCode(expectedState: string): Promise<string> {
  const manual = await promptLine("没有自动回调，请粘贴完整回调 URL 或 code: ");
  return parseManualAuthorizationCode(manual, expectedState);
}

function buildAuthorizeUrl(state: string, challenge: string): string {
  const authorizeUrl = new URL(AUTHORIZE_URL);

  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authorizeUrl.searchParams.set("originator", "pi");

  return authorizeUrl.toString();
}

export async function startOpenAICodexRemoteLogin(): Promise<OpenAICodexRemoteLoginSession> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl(state, challenge);

  return {
    state,
    authorizeUrl,
    completeWithInput: async (inputValue: string) => {
      const code = parseManualAuthorizationCode(inputValue, state);
      const token = await exchangeAuthorizationCode(code, verifier);
      return extractProfile(token.access, token.refresh, token.expires, token.idToken);
    },
  };
}

export async function startOpenAICodexLogin(): Promise<OpenAICodexLoginSession> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl(state, challenge);

  const callbackServer = await startLocalCallbackServer(state);
  const url = authorizeUrl;

  console.log("开始 OpenAI Codex OAuth 登录。");
  console.log(`回调地址: ${REDIRECT_URI}`);
  console.log(`授权地址: ${url}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    console.log("检测到代理环境变量，token 交换会复用当前终端代理。");
  } else {
    console.log("当前未检测到 HTTP_PROXY / HTTPS_PROXY。");
  }
  if (process.env.OAUTH_DEMO_USE_CURL === "1") {
    console.log("已启用 curl-only 模式进行 token 请求。");
  }

  const opened = tryOpenPrivateBrowser(url);
  if (opened) {
    console.log("已尝试打开无痕浏览器窗口。");
  } else {
    console.log("未能自动打开无痕浏览器窗口，请手动用无痕/隐私窗口打开上面的授权地址。");
  }

  return {
    state,
    authorizeUrl: url,
    waitForCode: (timeoutMs: number) => callbackServer.waitForCode(timeoutMs),
    completeWithCode: async (code: string) => {
      console.log("已收到授权回调，正在交换 access token...");
      const token = await exchangeAuthorizationCode(code, verifier);
      console.log("token 交换成功，正在解析账号信息...");
      return extractProfile(token.access, token.refresh, token.expires, token.idToken);
    },
    completeWithInput: async (inputValue: string) => {
      const code = parseManualAuthorizationCode(inputValue, state);
      console.log("已收到手动授权结果，正在交换 access token...");
      const token = await exchangeAuthorizationCode(code, verifier);
      console.log("token 交换成功，正在解析账号信息...");
      return extractProfile(token.access, token.refresh, token.expires, token.idToken);
    },
    close: callbackServer.close,
  };
}

export async function loginOpenAICodex(options?: OpenAICodexLoginOptions): Promise<OAuthProfile> {
  const session = await startOpenAICodexLogin();
  const callbackTimeoutMs = options?.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  try {
    const code = await session.waitForCode(callbackTimeoutMs);
    if (!code && options?.allowManualCode === false) {
      throw new Error("OAuth 回调超时，请重新点击登录并在授权完成后保持管理页打开。");
    }
    const resolvedCode = code ?? (await requestManualCode(session.state));
    return session.completeWithCode(resolvedCode);
  } finally {
    session.close();
  }
}
