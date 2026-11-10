import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * 企业微信「接收消息」回调协议层。
 *
 * 只做纯协议处理，不依赖 Fastify / 数据库 / 配置存储：
 * - 回调 URL 验证（GET，echostr 解密）
 * - 消息体签名校验 + 解密（POST，Encrypt 密文）
 * - 被动回复 XML 构造（加密 + 签名）
 * - 本地自检（不需要真实企微账号）
 *
 * 加密约定（企业微信官方）：
 * key = Base64Decode(EncodingAESKey + "=")，必须 32 字节；
 * iv = key 前 16 字节；AES-256-CBC + PKCS#7；
 * 明文 = 16 字节随机数 + 4 字节大端消息长度 + 消息 + receiveid。
 * 签名 = sha1(sort([token, timestamp, nonce, encrypt]).join(""))。
 */

export const WECOM_CALLBACK_PATH = "/_gateway/wecom/callback";

export type WecomCallbackSettings = {
  token: string;
  aesKey: string;
  corpId: string;
};

export type WecomCallbackQuery = {
  msgSignature?: string;
  timestamp?: string;
  nonce?: string;
  echostr?: string;
  encrypt?: string;
};

export type WecomIncomingMessage = {
  msgType: "text" | "image" | "voice" | "event" | "unknown";
  fromUser: string;
  toUser: string;
  createTime: number;
  msgId?: string;
  agentId?: string;
  content?: string;
  mediaId?: string;
  event?: string;
  eventKey?: string;
  raw: Record<string, string>;
};

export type WecomCallbackSelfTestCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
};

export type WecomCallbackSelfTestResult = {
  ok: boolean;
  checks: WecomCallbackSelfTestCheck[];
};

const WECOM_TOKEN_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const WECOM_AES_KEY_PATTERN = /^[A-Za-z0-9+/]{43}$/;
const WECOM_KEY_SIZE = 32;
const WECOM_IV_SIZE = 16;
const WECOM_RANDOM_SIZE = 16;
const WECOM_LENGTH_SIZE = 4;
const WECOM_HEADER_SIZE = WECOM_RANDOM_SIZE + WECOM_LENGTH_SIZE;
const WECOM_SELF_TEST_CORP_ID = "wecom-self-test-corp-id";

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function randomNonce(): string {
  return randomBytes(5).toString("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAesKey(aesKey: string): Buffer {
  const normalized = (aesKey ?? "").trim();
  if (!normalized) {
    throw new Error("企业微信回调 AESKey 未配置。");
  }
  const key = Buffer.from(`${normalized}=`, "base64");
  if (key.length !== WECOM_KEY_SIZE) {
    throw new Error("企业微信回调 AESKey 无效：必须是 43 位 Base64 字符，解码后为 32 字节。");
  }
  return key;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (match: string, entity: string): string => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          break;
      }
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      if (entity.startsWith("#")) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      return match;
    },
  );
}

/**
 * 把 XML 元素内部文本还原成真实字符串：
 * 支持多个 CDATA 片段拼接，CDATA 之外的文本做实体反转义。
 */
function normalizeXmlText(raw: string): string {
  const trimmed = raw.trim();
  const parts: string[] = [];
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    if (match.index > lastIndex) {
      parts.push(decodeXmlEntities(trimmed.slice(lastIndex, match.index)));
    }
    parts.push(match[1] ?? "");
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < trimmed.length) {
    parts.push(decodeXmlEntities(trimmed.slice(lastIndex)));
  }
  return parts.join("");
}

function escapeXmlCdata(value: string): string {
  // CDATA 里不能出现 `]]>`，按 XML 规范拆成两段 CDATA。
  return `<![CDATA[${value.split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

function matchXmlElement(xml: string, tagNames: string[]): string | undefined {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i");
    const match = pattern.exec(xml);
    if (match) {
      return normalizeXmlText(match[1] ?? "");
    }
  }
  return undefined;
}

const WECOM_XML_LEAF_PATTERN =
  /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>((?:<!\[CDATA\[[\s\S]*?\]\]>|[^<])*)<\/\1>/g;

function parseXmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = new RegExp(WECOM_XML_LEAF_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const name = match[1];
    if (!name || name.toLowerCase() === "xml") {
      continue;
    }
    fields[name] = normalizeXmlText(match[2] ?? "");
  }
  return fields;
}

function readXmlField(fields: Record<string, string>, names: string[]): string | undefined {
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    lowered.set(key.toLowerCase(), value);
  }
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function extractEncryptField(xml: string): string | undefined {
  const value = matchXmlElement(xml, ["Encrypt"]);
  const normalized = value?.replace(/\s+/g, "");
  return normalized ? normalized : undefined;
}

export function isWecomCallbackConfigured(settings: {
  enabled?: boolean;
  corpId?: string;
  callbackToken?: string;
  callbackAesKey?: string;
}): boolean {
  return Boolean(
    settings.enabled &&
      settings.corpId?.trim() &&
      settings.callbackToken?.trim() &&
      settings.callbackAesKey?.trim(),
  );
}

export function buildWecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  const parts = [token ?? "", timestamp ?? "", nonce ?? "", encrypt ?? ""];
  parts.sort();
  return createHash("sha1").update(parts.join(""), "utf8").digest("hex");
}

export function verifyWecomCallbackSignature(
  settings: WecomCallbackSettings,
  params: { msgSignature?: string; timestamp?: string; nonce?: string; encrypt?: string },
): boolean {
  const token = settings.token?.trim();
  const signature = params.msgSignature?.trim().toLowerCase();
  const timestamp = params.timestamp?.trim();
  const nonce = params.nonce?.trim();
  const encrypt = params.encrypt?.trim();
  if (!token || !signature || !timestamp || !nonce || !encrypt) {
    return false;
  }
  const expected = buildWecomSignature(token, timestamp, nonce, encrypt);
  return constantTimeEqualHex(expected, signature);
}

export function decryptWecomPayload(
  settings: WecomCallbackSettings,
  encrypt: string,
): { message: string; receiveId: string } {
  const key = resolveAesKey(settings.aesKey);
  const cipherText = Buffer.from((encrypt ?? "").replace(/\s+/g, ""), "base64");
  if (cipherText.length === 0) {
    throw new Error("企业微信回调解密失败：密文为空。");
  }
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, WECOM_IV_SIZE));
    plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch {
    throw new Error("企业微信回调解密失败：请检查回调 AESKey 与密文是否匹配。");
  }
  if (plain.length < WECOM_HEADER_SIZE) {
    throw new Error("企业微信回调解密失败：明文长度不足 20 字节。");
  }
  const messageLength = plain.readUInt32BE(WECOM_RANDOM_SIZE);
  if (WECOM_HEADER_SIZE + messageLength > plain.length) {
    throw new Error("企业微信回调解密失败：消息长度字段与明文实际长度不一致。");
  }
  const message = plain
    .subarray(WECOM_HEADER_SIZE, WECOM_HEADER_SIZE + messageLength)
    .toString("utf8");
  const receiveId = plain.subarray(WECOM_HEADER_SIZE + messageLength).toString("utf8").trim();
  const expectedCorpId = settings.corpId?.trim() ?? "";
  if (receiveId !== expectedCorpId) {
    throw new Error("企业微信回调 receiveid 与配置的企业 ID 不一致。");
  }
  return { message, receiveId };
}

export function encryptWecomPayload(settings: WecomCallbackSettings, plain: string): string {
  const key = resolveAesKey(settings.aesKey);
  const message = Buffer.from(plain ?? "", "utf8");
  const length = Buffer.alloc(WECOM_LENGTH_SIZE);
  length.writeUInt32BE(message.length, 0);
  const payload = Buffer.concat([
    randomBytes(WECOM_RANDOM_SIZE),
    length,
    message,
    Buffer.from(settings.corpId?.trim() ?? "", "utf8"),
  ]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, WECOM_IV_SIZE));
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
}

export function buildWecomVerifyEcho(
  settings: WecomCallbackSettings,
  query: { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string },
): string {
  const timestamp = query.timestamp?.trim();
  const nonce = query.nonce?.trim();
  const echostr = query.echostr?.trim();
  if (!query.msg_signature?.trim() || !timestamp || !nonce || !echostr) {
    throw new Error("企业微信回调 URL 校验缺少必要参数（msg_signature、timestamp、nonce、echostr）。");
  }
  const verified = verifyWecomCallbackSignature(settings, {
    msgSignature: query.msg_signature,
    timestamp,
    nonce,
    encrypt: echostr,
  });
  if (!verified) {
    throw new Error("企业微信回调 URL 校验签名不合法。");
  }
  try {
    return decryptWecomPayload(settings, echostr).message;
  } catch (error) {
    throw new Error(`企业微信回调 URL 校验解密失败：${messageOf(error)}`);
  }
}

export function parseWecomIncomingMessage(
  settings: WecomCallbackSettings,
  encryptedBodyXml: string,
  query: { msg_signature?: string; timestamp?: string; nonce?: string },
): WecomIncomingMessage {
  const encrypted = extractEncryptField(encryptedBodyXml ?? "");
  if (!encrypted) {
    throw new Error("企业微信回调请求缺少 Encrypt 字段。");
  }
  const timestamp = query.timestamp?.trim();
  const nonce = query.nonce?.trim();
  if (!query.msg_signature?.trim() || !timestamp || !nonce) {
    throw new Error("企业微信回调缺少签名参数（msg_signature、timestamp、nonce）。");
  }
  const verified = verifyWecomCallbackSignature(settings, {
    msgSignature: query.msg_signature,
    timestamp,
    nonce,
    encrypt: encrypted,
  });
  if (!verified) {
    throw new Error("企业微信回调签名校验失败。");
  }
  const plain = decryptWecomPayload(settings, encrypted).message;
  const fields = parseXmlFields(plain);
  const rawMsgType = (readXmlField(fields, ["MsgType"]) ?? "").toLowerCase();
  const msgType: WecomIncomingMessage["msgType"] =
    rawMsgType === "text" ||
    rawMsgType === "image" ||
    rawMsgType === "voice" ||
    rawMsgType === "event"
      ? rawMsgType
      : "unknown";
  const createTimeRaw = readXmlField(fields, ["CreateTime"]);
  const parsedCreateTime = createTimeRaw ? Number.parseInt(createTimeRaw, 10) : Number.NaN;
  const message: WecomIncomingMessage = {
    msgType,
    fromUser: readXmlField(fields, ["FromUserName"]) ?? "",
    toUser: readXmlField(fields, ["ToUserName"]) ?? "",
    createTime: Number.isFinite(parsedCreateTime) ? parsedCreateTime : 0,
    raw: fields,
  };
  const msgId = readXmlField(fields, ["MsgId"]);
  if (msgId) {
    message.msgId = msgId;
  }
  const agentId = readXmlField(fields, ["AgentID", "AgentId"]);
  if (agentId) {
    message.agentId = agentId;
  }
  const content = readXmlField(fields, ["Content"]);
  if (content !== undefined) {
    message.content = content;
  }
  const mediaId = readXmlField(fields, ["MediaId"]);
  if (mediaId) {
    message.mediaId = mediaId;
  }
  const event = readXmlField(fields, ["Event"]);
  if (event) {
    message.event = event;
  }
  const eventKey = readXmlField(fields, ["EventKey"]);
  if (eventKey) {
    message.eventKey = eventKey;
  }
  return message;
}

export function buildWecomPassiveReplyXml(
  settings: WecomCallbackSettings,
  params: { toUser: string; fromUser: string; content: string; timestamp?: string; nonce?: string },
): string {
  const token = settings.token?.trim();
  if (!token) {
    throw new Error("企业微信回调 Token 未配置。");
  }
  const timestamp = params.timestamp?.trim() || currentTimestamp();
  const nonce = params.nonce?.trim() || randomNonce();
  const plainXml = [
    "<xml>",
    `<ToUserName>${escapeXmlCdata(params.toUser ?? "")}</ToUserName>`,
    `<FromUserName>${escapeXmlCdata(params.fromUser ?? "")}</FromUserName>`,
    `<CreateTime>${timestamp}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content>${escapeXmlCdata(params.content ?? "")}</Content>`,
    "</xml>",
  ].join("");
  const encrypt = encryptWecomPayload(settings, plainXml);
  const signature = buildWecomSignature(token, timestamp, nonce, encrypt);
  return [
    "<xml>",
    `<Encrypt>${escapeXmlCdata(encrypt)}</Encrypt>`,
    `<MsgSignature>${escapeXmlCdata(signature)}</MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce>${escapeXmlCdata(nonce)}</Nonce>`,
    "</xml>",
  ].join("");
}

type SelfTestRunner = () => string | undefined;

function runSelfTestCheck(
  checks: WecomCallbackSelfTestCheck[],
  id: string,
  label: string,
  runner: SelfTestRunner,
): void {
  try {
    const detail = runner();
    checks.push({ id, label, ok: true, detail });
  } catch (error) {
    checks.push({ id, label, ok: false, detail: messageOf(error) });
  }
}

/**
 * 本地自检：不依赖真实企业微信账号，验证加解密、签名、receiveid 与被动回复是否自洽。
 */
export function runWecomCallbackSelfTest(
  settings: WecomCallbackSettings,
): WecomCallbackSelfTestResult {
  const checks: WecomCallbackSelfTestCheck[] = [];
  const token = settings.token?.trim() ?? "";
  const aesKey = settings.aesKey?.trim() ?? "";
  const corpId = settings.corpId?.trim() ?? "";

  runSelfTestCheck(checks, "config", "回调配置格式", () => {
    const problems: string[] = [];
    if (!WECOM_TOKEN_PATTERN.test(token)) {
      problems.push("Token 需为 1-32 位字母或数字");
    }
    if (!WECOM_AES_KEY_PATTERN.test(aesKey)) {
      problems.push("AESKey 需为 43 位 Base64 字符");
    } else {
      try {
        resolveAesKey(aesKey);
      } catch (error) {
        problems.push(messageOf(error));
      }
    }
    if (!corpId) {
      problems.push("企业 ID（corpId）不能为空");
    }
    if (problems.length > 0) {
      throw new Error(problems.join("；"));
    }
    return "Token / AESKey / 企业 ID 格式均合法";
  });

  runSelfTestCheck(checks, "encrypt-decrypt", "加解密回环", () => {
    const plain = `自检消息 & <xml> "引号" '单引号' 中文与 emoji 🚀 ${Date.now()}`;
    const encrypted = encryptWecomPayload(settings, plain);
    const decrypted = decryptWecomPayload(settings, encrypted);
    if (decrypted.message !== plain) {
      throw new Error("解密后的消息与原文不一致。");
    }
    if (decrypted.receiveId !== corpId) {
      throw new Error(`解密后的 receiveid「${decrypted.receiveId}」与配置的企业 ID「${corpId}」不一致。`);
    }
    return `密文 ${encrypted.length} 字符，解密后 ${Buffer.byteLength(plain, "utf8")} 字节，receiveid 正确`;
  });

  runSelfTestCheck(checks, "signature", "签名生成与校验", () => {
    const timestamp = currentTimestamp();
    const nonce = "self-test-nonce";
    const encrypt = encryptWecomPayload(settings, "<xml>self-test</xml>");
    const signature = buildWecomSignature(token, timestamp, nonce, encrypt);
    if (!verifyWecomCallbackSignature(settings, { msgSignature: signature, timestamp, nonce, encrypt })) {
      throw new Error("正确签名未通过校验。");
    }
    const tampered = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    if (verifyWecomCallbackSignature(settings, { msgSignature: tampered, timestamp, nonce, encrypt })) {
      throw new Error("被篡改的签名错误通过校验。");
    }
    if (verifyWecomCallbackSignature(settings, { msgSignature: signature, timestamp: "1", nonce, encrypt })) {
      throw new Error("错误时间戳的签名错误通过校验。");
    }
    return "正确签名通过，篡改签名与错误时间戳均被拒绝";
  });

  runSelfTestCheck(checks, "receiveid", "receiveid 校验", () => {
    const otherCorpId = corpId === WECOM_SELF_TEST_CORP_ID ? `${WECOM_SELF_TEST_CORP_ID}-2` : WECOM_SELF_TEST_CORP_ID;
    const encrypted = encryptWecomPayload({ ...settings, corpId: otherCorpId }, "<xml>receiveid</xml>");
    const positive = decryptWecomPayload({ ...settings, corpId: otherCorpId }, encrypted);
    if (positive.receiveId !== otherCorpId) {
      throw new Error("receiveid 与密文内企业 ID 一致时解密结果不正确。");
    }
    try {
      decryptWecomPayload(settings, encrypted);
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("receiveid")) {
        return "receiveid 不一致时按预期拒绝解密";
      }
      throw new Error(`receiveid 校验抛出了非预期错误：${message}`);
    }
    throw new Error("receiveid 不一致时没有报错。");
  });

  runSelfTestCheck(checks, "passive-reply", "被动回复 XML 生成与再解密", () => {
    const timestamp = currentTimestamp();
    const nonce = randomNonce();
    const content = `被动回复自检 & <内容> "引号" '单引号' 中文，含 CDATA 结束符 ]]> 的情况。`;
    const replyXml = buildWecomPassiveReplyXml(settings, {
      toUser: "self-test-touser",
      fromUser: "self-test-fromuser",
      content,
      timestamp,
      nonce,
    });
    const encrypt = extractEncryptField(replyXml);
    if (!encrypt) {
      throw new Error("被动回复 XML 缺少 Encrypt 字段。");
    }
    const fields = parseXmlFields(replyXml);
    const signature = readXmlField(fields, ["MsgSignature"]);
    const replyTimestamp = readXmlField(fields, ["TimeStamp"]);
    const replyNonce = readXmlField(fields, ["Nonce"]);
    if (!signature || !replyTimestamp || !replyNonce) {
      throw new Error("被动回复 XML 缺少签名、时间戳或随机串。");
    }
    if (replyTimestamp !== timestamp || replyNonce !== nonce) {
      throw new Error("被动回复 XML 的时间戳或随机串与入参不一致。");
    }
    if (!verifyWecomCallbackSignature(settings, { msgSignature: signature, timestamp: replyTimestamp, nonce: replyNonce, encrypt })) {
      throw new Error("被动回复 XML 的签名校验失败。");
    }
    const plain = decryptWecomPayload(settings, encrypt).message;
    const plainFields = parseXmlFields(plain);
    if (readXmlField(plainFields, ["ToUserName"]) !== "self-test-touser") {
      throw new Error("被动回复 XML 的 ToUserName 不正确。");
    }
    if (readXmlField(plainFields, ["FromUserName"]) !== "self-test-fromuser") {
      throw new Error("被动回复 XML 的 FromUserName 不正确。");
    }
    if (readXmlField(plainFields, ["MsgType"]) !== "text") {
      throw new Error("被动回复 XML 的 MsgType 不正确。");
    }
    const decryptedContent = readXmlField(plainFields, ["Content"]);
    if (decryptedContent !== content) {
      throw new Error("被动回复 XML 的 Content 在 CDATA 转义后无法还原。");
    }
    return "外层 Encrypt/签名/时间戳/随机串可还原，CDATA 与实体内容解密后一致";
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
