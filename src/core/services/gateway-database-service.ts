import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { getDatabasePath, getGenerationAssetsDir, getStateDir } from "../store/state-paths.js";

export type PersistedRequestLog = {
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

export type GenerationImageAsset = {
  filename: string;
  path: string;
  url: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  previewFilename?: string;
  previewPath?: string;
  previewUrl?: string;
  previewMimeType?: string;
  previewSize?: number;
};

export type GenerationReferenceAsset = {
  name?: string;
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  sourceType: "data-url" | "url" | "file-id";
  source?: string;
};

export type GenerationHistoryItem = {
  id: string;
  owner?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  status: "queued" | "running" | "success" | "failed";
  endpoint: string;
  account: string;
  model: string;
  prompt: string;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  durationMs: number;
  waitDurationMs: number;
  request: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  error?: string;
  referenceImages: GenerationReferenceAsset[];
  images: GenerationImageAsset[];
};

export type GenerationLimitUsage = {
  sinceCount: number;
  lastCreatedAt?: number;
};

export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "success" | "running" | "failed";

export type ChatAttachmentKind = "image" | "text";

export type ChatAttachment = {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  text?: string;
};

export type ChatConversation = {
  id: string;
  owner?: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview?: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  owner?: string;
  role: ChatMessageRole;
  content: string;
  attachments: ChatAttachment[];
  status: ChatMessageStatus;
  model?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type ChatConversationDetail = ChatConversation & {
  messages: ChatMessage[];
  hasMoreMessages?: boolean;
  nextBeforeMessageId?: string;
  loadedMessageCount?: number;
};

type CreateChatConversationParams = {
  owner?: string;
  title?: string;
  model?: string;
};

type ChatConversationMessagePageOptions = {
  messageLimit?: number;
  beforeMessageId?: string;
};

type SaveChatMessageParams = {
  id?: string;
  conversationId: string;
  owner?: string;
  role: ChatMessageRole;
  content: string;
  status?: ChatMessageStatus;
  model?: string;
  error?: string;
  attachments?: ChatAttachment[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
};

type UpdateChatMessageParams = {
  content?: string;
  status?: ChatMessageStatus;
  model?: string;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
};

type SaveGenerationParams = {
  id?: string;
  owner?: string;
  createdAt?: number;
  startedAt?: number;
  status: "queued" | "running" | "success" | "failed";
  endpoint: string;
  account: string;
  model: string;
  prompt: string;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  durationMs: number;
  request: Record<string, unknown>;
  response?: {
    data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    output_format?: string;
    quality?: string;
    size?: string;
  };
  responseSummary?: Record<string, unknown>;
  error?: string;
  referenceImages?: Array<{ name?: string; value: string }>;
};

type GenerationDedupTarget = {
  id: string;
  owner?: string;
  endpoint: string;
  prompt: string;
  createdAt: number;
};

export type GatewayUserRole = "admin" | "user";

export type GatewayUserGroup = {
  id: string;
  name: string;
  sortOrder: number;
  imageLimitsDisabled: boolean;
  perUserDaily?: number;
  perUserHourly?: number;
  minIntervalSeconds?: number;
  createdAt: number;
  updatedAt: number;
};

export type GatewayUser = {
  id: string;
  username: string;
  displayName?: string;
  role: GatewayUserRole;
  apiKeyConfigured?: boolean;
  groupId?: string;
  groupName?: string;
  groupSortOrder: number;
  groupImageLimitsDisabled: boolean;
  groupPerUserDaily?: number;
  groupPerUserHourly?: number;
  groupMinIntervalSeconds?: number;
  createdAt: number;
  updatedAt: number;
  disabled: boolean;
};

export type GatewayUserRecord = GatewayUser & {
  passwordHash: string;
  apiKeyHash?: string;
};

export type SaveGatewayUserParams = {
  username: string;
  displayName?: string;
  passwordHash: string;
  role: GatewayUserRole;
  groupId?: string | null;
  disabled?: boolean;
};

export type ImportWecomContactParams = {
  userId: string;
  displayName: string;
  groupId?: string | null;
};

export type ImportWecomContactsResult = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
};

export type SaveGatewayUserGroupParams = {
  name: string;
  sortOrder: number;
  imageLimitsDisabled?: boolean;
  perUserDaily?: number | null;
  perUserHourly?: number | null;
  minIntervalSeconds?: number | null;
};

const DEFAULT_USER_GROUP_ID = "default-user";
const DEFAULT_VIP_GROUP_ID = "vip-user";

type DataUrlPayload = {
  mimeType: string;
  base64: string;
  bytes: Buffer;
};

const MAX_REQUEST_LOGS = 5000;
const MAX_GENERATION_HISTORY = 500;
const MAX_CHAT_CONVERSATIONS = 500;
const DEFAULT_CHAT_MESSAGE_PAGE_SIZE = 80;
const MAX_CHAT_MESSAGE_PAGE_SIZE = 200;
const MAX_PREVIEW_BYTES = 1024 * 1024;

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseDataUrl(value: string): DataUrlPayload | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const base64 = match[2] ?? "";
  const bytes = Buffer.from(base64, "base64");
  return {
    mimeType: match[1] ?? "application/octet-stream",
    base64,
    bytes,
  };
}

function extensionForMimeType(mimeType: string, fallback = "png"): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  if (mimeType.includes("png")) {
    return "png";
  }
  return fallback;
}

function outputMimeType(format?: string): string {
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  return "image/png";
}

function sanitizeFileName(value: string): string {
  return value.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

function sanitizeGatewayUsername(value: string, prefix = ""): string {
  const normalized = value.trim().replace(/[^\w.@:-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}${normalized || "user"}`.slice(0, 80);
}

function clampLimit(limit: number | undefined, max: number): number {
  return Math.max(1, Math.min(limit ?? 100, max));
}

function normalizeChatTitle(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 80) : "新对话";
}

function chatPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function parseChatAttachments(metadata: Record<string, unknown> | undefined): ChatAttachment[] {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const kind = record.kind === "image" || record.kind === "text" ? record.kind : null;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "";
      const mimeType = typeof record.mimeType === "string" && record.mimeType.trim() ? record.mimeType.trim() : "application/octet-stream";
      const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
      if (!kind || !id || !name) {
        return null;
      }
      return {
        id,
        kind,
        name,
        mimeType,
        size,
        dataUrl: typeof record.dataUrl === "string" && record.dataUrl ? record.dataUrl : undefined,
        text: typeof record.text === "string" ? record.text : undefined,
      } satisfies ChatAttachment;
    })
    .filter(Boolean) as ChatAttachment[];
}

function mergeChatMetadata(metadata: Record<string, unknown> | undefined, attachments: ChatAttachment[] | undefined): Record<string, unknown> | undefined {
  if (typeof attachments === "undefined") {
    return metadata;
  }
  const next: Record<string, unknown> = metadata ? { ...metadata } : {};
  if (attachments.length > 0) {
    next.attachments = attachments;
  } else {
    delete next.attachments;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function calculateWaitDurationMs(createdAt: number, startedAt: number | undefined, status: string, now: number): number {
  if (!Number.isFinite(createdAt)) {
    return 0;
  }
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    return Math.max(0, startedAt - createdAt);
  }
  if (status === "queued") {
    return Math.max(0, now - createdAt);
  }
  return 0;
}

export class GatewayDatabaseService {
  private db: DatabaseSync | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(getStateDir(), { recursive: true });
    await fs.mkdir(getGenerationAssetsDir(), { recursive: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_user_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        image_limits_disabled INTEGER NOT NULL DEFAULT 0,
        per_user_daily INTEGER,
        per_user_hourly INTEGER,
        min_interval_seconds INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_user_groups_sort_order ON gateway_user_groups(sort_order DESC, created_at ASC);
      CREATE TABLE IF NOT EXISTS gateway_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        api_key_hash TEXT,
        role TEXT NOT NULL,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_users_username ON gateway_users(username);
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        owner TEXT,
        time INTEGER NOT NULL,
        method TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        account TEXT NOT NULL,
        model TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        source TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(time DESC);
      CREATE TABLE IF NOT EXISTS generation_history (
        id TEXT PRIMARY KEY,
        owner TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        account TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        ratio TEXT,
        size TEXT,
        quality TEXT,
        output_format TEXT,
        duration_ms REAL NOT NULL,
        request_json TEXT NOT NULL,
        response_summary_json TEXT,
        error TEXT,
        reference_images_json TEXT NOT NULL,
        images_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_generation_history_created_at ON generation_history(created_at DESC);
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        owner TEXT,
        title TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_conversations_owner_updated_at ON chat_conversations(owner, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        owner TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created_at ON chat_messages(conversation_id, created_at ASC);
    `);
    this.addColumnIfMissing("request_logs", "owner", "TEXT");
    this.addColumnIfMissing("gateway_users", "group_id", "TEXT");
    this.addColumnIfMissing("gateway_users", "display_name", "TEXT");
    this.addColumnIfMissing("gateway_users", "api_key_hash", "TEXT");
    this.addColumnIfMissing("gateway_user_groups", "per_user_daily", "INTEGER");
    this.addColumnIfMissing("gateway_user_groups", "per_user_hourly", "INTEGER");
    this.addColumnIfMissing("gateway_user_groups", "min_interval_seconds", "INTEGER");
    this.addColumnIfMissing("generation_history", "owner", "TEXT");
    this.addColumnIfMissing("generation_history", "started_at", "INTEGER");
    this.ensureDefaultUserGroups();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_owner_time ON request_logs(owner, time DESC);
      CREATE INDEX IF NOT EXISTS idx_generation_history_owner_created_at ON generation_history(owner, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created_rowid ON chat_messages(conversation_id, created_at DESC, id);
    `);
    this.initialized = true;
  }

  async ensureBootstrapAdmin(username: string, passwordHash: string): Promise<void> {
    await this.init();
    const now = Date.now();
    const existing = await this.getUserByUsername(username);
    if (existing) {
      this.database
        .prepare("UPDATE gateway_users SET password_hash = ?, role = 'admin', group_id = COALESCE(group_id, ?), disabled = 0, updated_at = ? WHERE id = ?")
        .run(passwordHash, DEFAULT_USER_GROUP_ID, now, existing.id);
      return;
    }
    this.database
      .prepare(`
        INSERT INTO gateway_users (id, username, display_name, password_hash, role, group_id, created_at, updated_at, disabled)
        VALUES (?, ?, NULL, ?, 'admin', ?, ?, ?, 0)
      `)
      .run(crypto.randomUUID(), username, passwordHash, DEFAULT_USER_GROUP_ID, now, now);
  }

  async hasUsers(): Promise<boolean> {
    await this.init();
    const row = this.database.prepare("SELECT COUNT(1) AS count FROM gateway_users").get() as { count?: unknown };
    return Number(row.count ?? 0) > 0;
  }

  async getUserByUsername(username: string): Promise<GatewayUserRecord | null> {
    await this.init();
    const row = this.database
      .prepare(`
        SELECT id, username, password_hash AS passwordHash, api_key_hash AS apiKeyHash, role, created_at AS createdAt,
               updated_at AS updatedAt, disabled, group_id AS groupId, display_name AS displayName
        FROM gateway_users
        WHERE username = ?
      `)
      .get(username) as Record<string, unknown> | undefined;
    return row ? this.mapUserRecord(row) : null;
  }

  async getUserWithGroupByUsername(username: string): Promise<GatewayUserRecord | null> {
    await this.init();
    const row = this.database
      .prepare(`
        SELECT u.id, u.username, u.password_hash AS passwordHash, u.api_key_hash AS apiKeyHash, u.role, u.created_at AS createdAt,
               u.updated_at AS updatedAt, u.disabled, u.group_id AS groupId, u.display_name AS displayName,
               g.name AS groupName, g.sort_order AS groupSortOrder,
               g.image_limits_disabled AS groupImageLimitsDisabled,
               g.per_user_daily AS groupPerUserDaily,
               g.per_user_hourly AS groupPerUserHourly,
               g.min_interval_seconds AS groupMinIntervalSeconds
        FROM gateway_users u
        LEFT JOIN gateway_user_groups g ON g.id = u.group_id
        WHERE u.username = ?
      `)
      .get(username) as Record<string, unknown> | undefined;
    return row ? this.mapUserRecord(row) : null;
  }

  async getUserByApiKeyHash(apiKeyHash: string): Promise<GatewayUserRecord | null> {
    await this.init();
    const row = this.database
      .prepare(`
        SELECT u.id, u.username, u.password_hash AS passwordHash, u.api_key_hash AS apiKeyHash, u.role, u.created_at AS createdAt,
               u.updated_at AS updatedAt, u.disabled, u.group_id AS groupId, u.display_name AS displayName,
               g.name AS groupName, g.sort_order AS groupSortOrder,
               g.image_limits_disabled AS groupImageLimitsDisabled,
               g.per_user_daily AS groupPerUserDaily,
               g.per_user_hourly AS groupPerUserHourly,
               g.min_interval_seconds AS groupMinIntervalSeconds
        FROM gateway_users u
        LEFT JOIN gateway_user_groups g ON g.id = u.group_id
        WHERE u.api_key_hash = ?
          AND u.disabled = 0
        LIMIT 1
      `)
      .get(apiKeyHash) as Record<string, unknown> | undefined;
    return row ? this.mapUserRecord(row) : null;
  }

  async setUserApiKey(username: string, apiKeyHash: string | null): Promise<GatewayUser | null> {
    await this.init();
    const now = Date.now();
    const result = this.database
      .prepare("UPDATE gateway_users SET api_key_hash = ?, updated_at = ? WHERE username = ? AND disabled = 0")
      .run(apiKeyHash?.trim() || null, now, username);
    if (result.changes <= 0) {
      return null;
    }
    const updated = await this.getUserByUsername(username);
    if (!updated) {
      return null;
    }
    const { passwordHash: _passwordHash, apiKeyHash: _apiKeyHash, ...user } = updated;
    return user;
  }

  async listUsers(): Promise<GatewayUser[]> {
    await this.init();
    const rows = this.database
      .prepare(`
        SELECT u.id, u.username, u.password_hash AS passwordHash, u.api_key_hash AS apiKeyHash, u.role, u.created_at AS createdAt,
               u.updated_at AS updatedAt, u.disabled, u.group_id AS groupId, u.display_name AS displayName,
               g.name AS groupName, g.sort_order AS groupSortOrder,
               g.image_limits_disabled AS groupImageLimitsDisabled,
               g.per_user_daily AS groupPerUserDaily,
               g.per_user_hourly AS groupPerUserHourly,
               g.min_interval_seconds AS groupMinIntervalSeconds
        FROM gateway_users u
        LEFT JOIN gateway_user_groups g ON g.id = u.group_id
        ORDER BY role = 'admin' DESC, COALESCE(g.sort_order, 0) DESC, u.created_at ASC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const { passwordHash: _passwordHash, apiKeyHash: _apiKeyHash, ...user } = this.mapUserRecord(row);
      return user;
    });
  }

  async createUser(params: SaveGatewayUserParams): Promise<GatewayUser> {
    await this.init();
    const now = Date.now();
    const id = crypto.randomUUID();
    this.database
      .prepare(`
        INSERT INTO gateway_users (id, username, display_name, password_hash, role, group_id, created_at, updated_at, disabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, params.username, params.displayName?.trim() || null, params.passwordHash, params.role, params.groupId ?? DEFAULT_USER_GROUP_ID, now, now, params.disabled ? 1 : 0);
    const created = await this.getUserByUsername(params.username);
    if (!created) {
      throw new Error("用户创建失败。");
    }
    const { passwordHash: _passwordHash, apiKeyHash: _apiKeyHash, ...user } = created;
    return user;
  }

  async updateUser(
    id: string,
    params: Partial<Pick<SaveGatewayUserParams, "passwordHash" | "role" | "groupId" | "disabled">>,
  ): Promise<GatewayUser | null> {
    await this.init();
    const current = this.database
      .prepare(`
        SELECT id, username, password_hash AS passwordHash, api_key_hash AS apiKeyHash, role, created_at AS createdAt,
               updated_at AS updatedAt, disabled, group_id AS groupId, display_name AS displayName
        FROM gateway_users
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!current) {
      return null;
    }
    const now = Date.now();
    const record = this.mapUserRecord(current);
    this.database
      .prepare("UPDATE gateway_users SET password_hash = ?, role = ?, group_id = ?, disabled = ?, updated_at = ? WHERE id = ?")
      .run(
        params.passwordHash ?? record.passwordHash,
        params.role ?? record.role,
        params.groupId === undefined ? (record.groupId ?? DEFAULT_USER_GROUP_ID) : params.groupId,
        params.disabled === undefined ? (record.disabled ? 1 : 0) : (params.disabled ? 1 : 0),
        now,
        id,
      );
    const updated = this.database
      .prepare(`
        SELECT u.id, u.username, u.password_hash AS passwordHash, u.api_key_hash AS apiKeyHash, u.role, u.created_at AS createdAt,
               u.updated_at AS updatedAt, u.disabled, u.group_id AS groupId, u.display_name AS displayName,
               g.name AS groupName, g.sort_order AS groupSortOrder,
               g.image_limits_disabled AS groupImageLimitsDisabled,
               g.per_user_daily AS groupPerUserDaily,
               g.per_user_hourly AS groupPerUserHourly,
               g.min_interval_seconds AS groupMinIntervalSeconds
        FROM gateway_users u
        LEFT JOIN gateway_user_groups g ON g.id = u.group_id
        WHERE u.id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!updated) {
      return null;
    }
    const { passwordHash: _passwordHash, apiKeyHash: _apiKeyHash, ...user } = this.mapUserRecord(updated);
    return user;
  }

  async importWecomContacts(params: { contacts: ImportWecomContactParams[]; groupId?: string | null }): Promise<ImportWecomContactsResult> {
    await this.init();
    const now = Date.now();
    const result: ImportWecomContactsResult = {
      total: params.contacts.length,
      created: 0,
      updated: 0,
      skipped: 0,
    };
    const seen = new Set<string>();
    const insert = this.database.prepare(`
      INSERT INTO gateway_users (id, username, display_name, password_hash, role, group_id, created_at, updated_at, disabled)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 0)
    `);
    const update = this.database.prepare("UPDATE gateway_users SET display_name = ?, group_id = COALESCE(group_id, ?), updated_at = ? WHERE username = ?");
    const existingQuery = this.database.prepare("SELECT id FROM gateway_users WHERE username = ?");

    for (const contact of params.contacts) {
      const userId = contact.userId.trim();
      const displayName = contact.displayName.trim();
      if (!userId || !displayName) {
        result.skipped += 1;
        continue;
      }
      const username = sanitizeGatewayUsername(userId, "wxwork:");
      const key = username.toLowerCase();
      if (seen.has(key)) {
        result.skipped += 1;
        continue;
      }
      seen.add(key);
      const groupId = contact.groupId ?? params.groupId ?? DEFAULT_USER_GROUP_ID;
      const existing = existingQuery.get(username) as { id?: unknown } | undefined;
      if (existing) {
        update.run(displayName, groupId, now, username);
        result.updated += 1;
        continue;
      }
      const passwordHash = crypto.createHash("sha256").update(`wecom-import:${userId}:${crypto.randomUUID()}:${now}`).digest("hex");
      insert.run(crypto.randomUUID(), username, displayName, passwordHash, groupId, now, now);
      result.created += 1;
    }
    return result;
  }

  async deleteUser(id: string): Promise<boolean> {
    await this.init();
    const result = this.database.prepare("DELETE FROM gateway_users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async countActiveAdmins(exceptId?: string): Promise<number> {
    await this.init();
    const row = this.database
      .prepare(`
        SELECT COUNT(1) AS count
        FROM gateway_users
        WHERE role = 'admin' AND disabled = 0 AND (? IS NULL OR id <> ?)
      `)
      .get(exceptId ?? null, exceptId ?? null) as { count?: unknown };
    return Number(row.count ?? 0);
  }

  async listUserGroups(): Promise<GatewayUserGroup[]> {
    await this.init();
    const rows = this.database
      .prepare(`
        SELECT id, name, sort_order AS sortOrder, image_limits_disabled AS imageLimitsDisabled,
               per_user_daily AS perUserDaily, per_user_hourly AS perUserHourly,
               min_interval_seconds AS minIntervalSeconds,
               created_at AS createdAt, updated_at AS updatedAt
        FROM gateway_user_groups
        ORDER BY sort_order DESC, created_at ASC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapUserGroup(row));
  }

  async createUserGroup(params: SaveGatewayUserGroupParams): Promise<GatewayUserGroup> {
    await this.init();
    const now = Date.now();
    const id = crypto.randomUUID();
    this.database
      .prepare(`
        INSERT INTO gateway_user_groups (id, name, sort_order, image_limits_disabled, per_user_daily, per_user_hourly, min_interval_seconds, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, params.name, params.sortOrder, params.imageLimitsDisabled ? 1 : 0, params.perUserDaily ?? null, params.perUserHourly ?? null, params.minIntervalSeconds ?? null, now, now);
    const created = this.database
      .prepare(`
        SELECT id, name, sort_order AS sortOrder, image_limits_disabled AS imageLimitsDisabled,
               per_user_daily AS perUserDaily, per_user_hourly AS perUserHourly,
               min_interval_seconds AS minIntervalSeconds,
               created_at AS createdAt, updated_at AS updatedAt
        FROM gateway_user_groups
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!created) {
      throw new Error("用户组创建失败。");
    }
    return this.mapUserGroup(created);
  }

  async updateUserGroup(id: string, params: Partial<SaveGatewayUserGroupParams>): Promise<GatewayUserGroup | null> {
    await this.init();
    const current = this.database
      .prepare(`
        SELECT id, name, sort_order AS sortOrder, image_limits_disabled AS imageLimitsDisabled,
               per_user_daily AS perUserDaily, per_user_hourly AS perUserHourly,
               min_interval_seconds AS minIntervalSeconds,
               created_at AS createdAt, updated_at AS updatedAt
        FROM gateway_user_groups
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!current) {
      return null;
    }
    const record = this.mapUserGroup(current);
    const now = Date.now();
    this.database
      .prepare("UPDATE gateway_user_groups SET name = ?, sort_order = ?, image_limits_disabled = ?, per_user_daily = ?, per_user_hourly = ?, min_interval_seconds = ?, updated_at = ? WHERE id = ?")
      .run(
        params.name ?? record.name,
        params.sortOrder ?? record.sortOrder,
        params.imageLimitsDisabled === undefined ? (record.imageLimitsDisabled ? 1 : 0) : (params.imageLimitsDisabled ? 1 : 0),
        params.perUserDaily === undefined ? (record.perUserDaily ?? null) : params.perUserDaily,
        params.perUserHourly === undefined ? (record.perUserHourly ?? null) : params.perUserHourly,
        params.minIntervalSeconds === undefined ? (record.minIntervalSeconds ?? null) : params.minIntervalSeconds,
        now,
        id,
      );
    const updated = this.database
      .prepare(`
        SELECT id, name, sort_order AS sortOrder, image_limits_disabled AS imageLimitsDisabled,
               per_user_daily AS perUserDaily, per_user_hourly AS perUserHourly,
               min_interval_seconds AS minIntervalSeconds,
               created_at AS createdAt, updated_at AS updatedAt
        FROM gateway_user_groups
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    return updated ? this.mapUserGroup(updated) : null;
  }

  async deleteUserGroup(id: string): Promise<boolean> {
    await this.init();
    const fallbackId = await this.ensureUserGroupFallback(id);
    if (!fallbackId) {
      return false;
    }
    this.database.prepare("UPDATE gateway_users SET group_id = ? WHERE group_id = ?").run(fallbackId, id);
    const result = this.database.prepare("DELETE FROM gateway_user_groups WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async listRequestLogs(limit = 100, owner?: string, options?: { includeDetails?: boolean }): Promise<PersistedRequestLog[]> {
    await this.init();
    const includeDetails = Boolean(options?.includeDetails);
    const rows = this.database
      .prepare(`
        SELECT id, owner, time, method, endpoint, account, model, status_code AS statusCode,
               duration_ms AS durationMs, source${includeDetails ? ", details_json AS detailsJson" : ""}
        FROM request_logs
        WHERE (? IS NULL OR owner = ?)
        ORDER BY time DESC
        LIMIT ?
      `)
      .all(owner ?? null, owner ?? null, clampLimit(limit, MAX_REQUEST_LOGS)) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      owner: typeof row.owner === "string" ? row.owner : undefined,
      time: Number(row.time),
      method: String(row.method),
      endpoint: String(row.endpoint),
      account: String(row.account),
      model: String(row.model),
      statusCode: Number(row.statusCode),
      durationMs: Number(row.durationMs),
      source: String(row.source),
      details: includeDetails ? parseJsonObject(row.detailsJson) : undefined,
    }));
  }

  async saveRequestLog(log: PersistedRequestLog): Promise<void> {
    await this.init();
    this.database
      .prepare(`
        INSERT OR REPLACE INTO request_logs
          (id, owner, time, method, endpoint, account, model, status_code, duration_ms, source, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        log.id,
        log.owner ?? null,
        log.time,
        log.method,
        log.endpoint,
        log.account,
        log.model,
        log.statusCode,
        log.durationMs,
        log.source,
        log.details ? JSON.stringify(log.details) : null,
      );
    this.prune("request_logs", "time", MAX_REQUEST_LOGS);
  }

  async countGenerationHistory(owner?: string): Promise<number> {
    await this.init();
    this.deleteCoveredRunningGenerations(owner);
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM generation_history
        WHERE (? IS NULL OR owner = ?)
      `)
      .get(owner ?? null, owner ?? null) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  async listGenerationHistory(limit = 10, owner?: string, options?: { light?: boolean; offset?: number }): Promise<GenerationHistoryItem[]> {
    await this.init();
    this.deleteCoveredRunningGenerations(owner);
    const light = Boolean(options?.light);
    const safeLimit = clampLimit(limit, MAX_GENERATION_HISTORY);
    const safeOffset = Math.max(0, Math.trunc(options?.offset ?? 0));
    const rows = this.database
      .prepare(`
        SELECT id, owner, created_at AS createdAt, started_at AS startedAt, updated_at AS updatedAt, status, endpoint, account, model,
               prompt, ratio, size, quality, output_format AS outputFormat, duration_ms AS durationMs,
               ${light ? "NULL AS requestJson, NULL AS responseSummaryJson" : "request_json AS requestJson, response_summary_json AS responseSummaryJson"}, error,
               reference_images_json AS referenceImagesJson, images_json AS imagesJson
        FROM generation_history
        WHERE (? IS NULL OR owner = ?)
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
      `)
      .all(owner ?? null, owner ?? null, safeLimit, safeOffset) as Array<Record<string, unknown>>;

    const now = Date.now();
    return rows.map((row) => ({
      id: String(row.id),
      owner: typeof row.owner === "string" ? row.owner : undefined,
      createdAt: Number(row.createdAt),
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
      updatedAt: Number(row.updatedAt),
      status: row.status === "queued" || row.status === "running" || row.status === "failed" ? row.status : "success",
      endpoint: String(row.endpoint),
      account: String(row.account),
      model: String(row.model),
      prompt: String(row.prompt),
      ratio: typeof row.ratio === "string" ? row.ratio : undefined,
      size: typeof row.size === "string" ? row.size : undefined,
      quality: typeof row.quality === "string" ? row.quality : undefined,
      outputFormat: typeof row.outputFormat === "string" ? row.outputFormat : undefined,
      durationMs: Number(row.durationMs),
      waitDurationMs: calculateWaitDurationMs(Number(row.createdAt), typeof row.startedAt === "number" ? row.startedAt : undefined, String(row.status), now),
      request: light ? {} : (parseJsonObject(row.requestJson) ?? {}),
      responseSummary: light ? undefined : parseJsonObject(row.responseSummaryJson),
      error: typeof row.error === "string" ? row.error : undefined,
      referenceImages: parseJsonArray<GenerationReferenceAsset>(row.referenceImagesJson),
      images: parseJsonArray<GenerationImageAsset>(row.imagesJson),
    }));
  }

  async getGenerationHistoryItem(id: string, owner?: string): Promise<GenerationHistoryItem | null> {
    await this.init();
    this.deleteCoveredRunningGenerations(owner);
    const row = this.database
      .prepare(`
        SELECT id, owner, created_at AS createdAt, started_at AS startedAt, updated_at AS updatedAt, status, endpoint, account, model,
               prompt, ratio, size, quality, output_format AS outputFormat, duration_ms AS durationMs,
               request_json AS requestJson, response_summary_json AS responseSummaryJson, error,
               reference_images_json AS referenceImagesJson, images_json AS imagesJson
        FROM generation_history
        WHERE id = ?
          AND (? IS NULL OR owner = ?)
        LIMIT 1
      `)
      .get(id, owner ?? null, owner ?? null) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    const now = Date.now();
    return {
      id: String(row.id),
      owner: typeof row.owner === "string" ? row.owner : undefined,
      createdAt: Number(row.createdAt),
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
      updatedAt: Number(row.updatedAt),
      status: row.status === "queued" || row.status === "running" || row.status === "failed" ? row.status : "success",
      endpoint: String(row.endpoint),
      account: String(row.account),
      model: String(row.model),
      prompt: String(row.prompt),
      ratio: typeof row.ratio === "string" ? row.ratio : undefined,
      size: typeof row.size === "string" ? row.size : undefined,
      quality: typeof row.quality === "string" ? row.quality : undefined,
      outputFormat: typeof row.outputFormat === "string" ? row.outputFormat : undefined,
      durationMs: Number(row.durationMs),
      waitDurationMs: calculateWaitDurationMs(Number(row.createdAt), typeof row.startedAt === "number" ? row.startedAt : undefined, String(row.status), now),
      request: parseJsonObject(row.requestJson) ?? {},
      responseSummary: parseJsonObject(row.responseSummaryJson),
      error: typeof row.error === "string" ? row.error : undefined,
      referenceImages: parseJsonArray<GenerationReferenceAsset>(row.referenceImagesJson),
      images: parseJsonArray<GenerationImageAsset>(row.imagesJson),
    };
  }

  async clearGenerationHistory(owner?: string): Promise<void> {
    await this.init();
    if (!owner) {
      this.database.prepare("DELETE FROM generation_history").run();
      await fs.rm(getGenerationAssetsDir(), { recursive: true, force: true });
      await fs.mkdir(getGenerationAssetsDir(), { recursive: true });
      return;
    }
    const items = await this.listGenerationHistory(MAX_GENERATION_HISTORY, owner);
    this.database.prepare("DELETE FROM generation_history WHERE owner = ?").run(owner);
    await Promise.all(
      items.map((item) => fs.rm(path.join(getGenerationAssetsDir(), item.id), { recursive: true, force: true })),
    );
  }

  async getGenerationOwner(id: string): Promise<string | undefined> {
    await this.init();
    const row = this.database
      .prepare("SELECT owner FROM generation_history WHERE id = ?")
      .get(id) as { owner?: unknown } | undefined;
    return typeof row?.owner === "string" ? row.owner : undefined;
  }

  async getGenerationLimitUsage(owner: string, since: number): Promise<GenerationLimitUsage> {
    await this.init();
    this.deleteCoveredRunningGenerations(owner);
    const row = this.database
      .prepare(`
        SELECT COUNT(1) AS sinceCount, MAX(created_at) AS lastCreatedAt
        FROM generation_history
        WHERE owner = ?
          AND created_at >= ?
          AND status IN ('queued', 'running', 'success')
      `)
      .get(owner, since) as { sinceCount?: unknown; lastCreatedAt?: unknown } | undefined;

    const lastCreatedAt = typeof row?.lastCreatedAt === "number" ? row.lastCreatedAt : undefined;
    return {
      sinceCount: Number(row?.sinceCount ?? 0),
      lastCreatedAt,
    };
  }

  async listChatConversations(limit = 100, owner?: string): Promise<ChatConversation[]> {
    await this.init();
    const rows = this.database
      .prepare(`
        SELECT c.id, c.owner, c.title, c.model, c.created_at AS createdAt, c.updated_at AS updatedAt,
               (
                 SELECT COUNT(1)
                 FROM chat_messages count_message
                 WHERE count_message.conversation_id = c.id
                   AND (? IS NULL OR count_message.owner = ?)
               ) AS messageCount,
               (
                 SELECT content
                 FROM chat_messages latest
                 WHERE latest.conversation_id = c.id
                   AND (? IS NULL OR latest.owner = ?)
                 ORDER BY latest.created_at DESC, latest.rowid DESC
                 LIMIT 1
               ) AS lastMessage
        FROM chat_conversations c
        WHERE (? IS NULL OR c.owner = ?)
        ORDER BY c.updated_at DESC
        LIMIT ?
      `)
      .all(owner ?? null, owner ?? null, owner ?? null, owner ?? null, owner ?? null, owner ?? null, clampLimit(limit, MAX_CHAT_CONVERSATIONS)) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapChatConversation(row));
  }

  async createChatConversation(params: CreateChatConversationParams): Promise<ChatConversationDetail> {
    await this.init();
    const now = Date.now();
    const id = crypto.randomUUID();
    this.database
      .prepare(`
        INSERT INTO chat_conversations (id, owner, title, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, params.owner ?? null, normalizeChatTitle(params.title), params.model ?? null, now, now);
    const detail = await this.getChatConversation(id, params.owner);
    if (!detail) {
      throw new Error("创建聊天会话失败。");
    }
    this.pruneChatConversations(params.owner);
    return detail;
  }

  async getChatConversation(id: string, owner?: string, options?: ChatConversationMessagePageOptions): Promise<ChatConversationDetail | null> {
    await this.init();
    const row = this.database
      .prepare(`
        SELECT c.id, c.owner, c.title, c.model, c.created_at AS createdAt, c.updated_at AS updatedAt,
               (
                 SELECT COUNT(1)
                 FROM chat_messages count_message
                 WHERE count_message.conversation_id = c.id
                   AND (? IS NULL OR count_message.owner = ?)
               ) AS messageCount,
               (
                 SELECT content
                 FROM chat_messages latest
                 WHERE latest.conversation_id = c.id
                   AND (? IS NULL OR latest.owner = ?)
                 ORDER BY latest.created_at DESC, latest.rowid DESC
                 LIMIT 1
               ) AS lastMessage
        FROM chat_conversations c
        WHERE c.id = ? AND (? IS NULL OR c.owner = ?)
      `)
      .get(owner ?? null, owner ?? null, owner ?? null, owner ?? null, id, owner ?? null, owner ?? null) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const page = options?.messageLimit || options?.beforeMessageId
      ? this.getChatMessagePage(id, owner, options)
      : this.getAllChatMessages(id, owner);
    const conversation = this.mapChatConversation(row);

    return {
      ...conversation,
      messages: page.messages,
      hasMoreMessages: page.hasMoreMessages,
      nextBeforeMessageId: page.nextBeforeMessageId,
      loadedMessageCount: page.messages.length,
    };
  }

  async updateChatConversation(id: string, owner: string | undefined, params: { title?: string; model?: string }): Promise<ChatConversationDetail | null> {
    await this.init();
    const existing = await this.getChatConversation(id, owner);
    if (!existing) {
      return null;
    }
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE chat_conversations
        SET title = ?, model = ?, updated_at = ?
        WHERE id = ? AND (? IS NULL OR owner = ?)
      `)
      .run(
        typeof params.title === "string" ? normalizeChatTitle(params.title) : existing.title,
        typeof params.model === "string" ? params.model : existing.model ?? null,
        now,
        id,
        owner ?? null,
        owner ?? null,
      );
    return this.getChatConversation(id, owner);
  }

  async deleteChatConversation(id: string, owner?: string): Promise<boolean> {
    await this.init();
    const existing = await this.getChatConversation(id, owner);
    if (!existing) {
      return false;
    }
    this.database.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(id);
    this.database
      .prepare("DELETE FROM chat_conversations WHERE id = ? AND (? IS NULL OR owner = ?)")
      .run(id, owner ?? null, owner ?? null);
    return true;
  }

  async saveChatMessage(params: SaveChatMessageParams): Promise<ChatMessage> {
    await this.init();
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();
    const createdAt = params.createdAt ?? now;
    const status = params.status ?? "success";
    const metadata = mergeChatMetadata(params.metadata, params.attachments);
    this.database
      .prepare(`
        INSERT OR REPLACE INTO chat_messages
          (id, conversation_id, owner, role, content, status, model, error, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.conversationId,
        params.owner ?? null,
        params.role,
        params.content,
        status,
        params.model ?? null,
        params.error ?? null,
        createdAt,
        now,
        metadata ? JSON.stringify(metadata) : null,
      );
    this.touchChatConversation(params.conversationId, now);
    const message = await this.getChatMessage(id, params.owner);
    if (!message) {
      throw new Error("保存聊天消息失败。");
    }
    return message;
  }

  async updateChatMessage(id: string, owner: string | undefined, params: UpdateChatMessageParams): Promise<ChatMessage | null> {
    await this.init();
    const existing = await this.getChatMessage(id, owner);
    if (!existing) {
      return null;
    }
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE chat_messages
        SET content = ?, status = ?, model = ?, error = ?, updated_at = ?, metadata_json = ?
        WHERE id = ? AND (? IS NULL OR owner = ?)
      `)
      .run(
        typeof params.content === "string" ? params.content : existing.content,
        params.status ?? existing.status,
        typeof params.model === "string" ? params.model : existing.model ?? null,
        typeof params.error === "string" ? params.error : params.error === null ? null : existing.error ?? null,
        now,
        params.metadata === null ? null : params.metadata ? JSON.stringify(params.metadata) : existing.metadata ? JSON.stringify(existing.metadata) : null,
        id,
        owner ?? null,
        owner ?? null,
      );
    this.touchChatConversation(existing.conversationId, now);
    return this.getChatMessage(id, owner);
  }

  async deleteChatMessagesAfter(conversationId: string, messageId: string, owner?: string): Promise<number | null> {
    await this.init();
    const rows = this.database
      .prepare(`
        SELECT id
        FROM chat_messages
        WHERE conversation_id = ? AND (? IS NULL OR owner = ?)
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(conversationId, owner ?? null, owner ?? null) as Array<{ id?: unknown }>;
    const targetIndex = rows.findIndex((row) => row.id === messageId);
    if (targetIndex < 0) {
      return null;
    }

    const staleIds = rows
      .slice(targetIndex + 1)
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (staleIds.length === 0) {
      return 0;
    }

    const deleteMessage = this.database.prepare("DELETE FROM chat_messages WHERE id = ? AND (? IS NULL OR owner = ?)");
    for (const id of staleIds) {
      deleteMessage.run(id, owner ?? null, owner ?? null);
    }
    this.touchChatConversation(conversationId);
    return staleIds.length;
  }

  async getChatMessageById(id: string, owner?: string): Promise<ChatMessage | null> {
    await this.init();
    return this.getChatMessage(id, owner);
  }

  async listSuccessfulChatMessages(conversationId: string, owner?: string): Promise<ChatMessage[]> {
    await this.init();
    const rows = this.database
      .prepare(`
        SELECT id, conversation_id AS conversationId, owner, role, content, status, model, error,
               created_at AS createdAt, updated_at AS updatedAt, metadata_json AS metadataJson
        FROM chat_messages
        WHERE conversation_id = ?
          AND (? IS NULL OR owner = ?)
          AND status = 'success'
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(conversationId, owner ?? null, owner ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapChatMessage(row));
  }

  async saveGeneration(params: SaveGenerationParams): Promise<GenerationHistoryItem> {
    await this.init();
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();
    const outputFormat = params.response?.output_format ?? params.outputFormat ?? "png";
    const referenceImages = await this.persistReferences(id, params.referenceImages ?? []);
    const images = params.status === "success" ? await this.persistGeneratedImages(id, params.response?.data ?? [], outputFormat) : [];
    const responseSummary = params.responseSummary ?? (params.response
      ? {
          imageCount: images.length,
          outputFormat,
          quality: params.response.quality,
          size: params.response.size,
        }
      : undefined);

    const item: GenerationHistoryItem = {
      id,
      owner: params.owner,
      createdAt: params.createdAt ?? now,
      startedAt: params.startedAt,
      updatedAt: now,
      status: params.status,
      endpoint: params.endpoint,
      account: params.account,
      model: params.model,
      prompt: params.prompt,
      ratio: params.ratio,
      size: params.response?.size ?? params.size,
      quality: params.response?.quality ?? params.quality,
      outputFormat,
      durationMs: params.durationMs,
      waitDurationMs: calculateWaitDurationMs(params.createdAt ?? now, params.startedAt, params.status, now),
      request: params.request,
      responseSummary,
      error: params.error,
      referenceImages,
      images,
    };

    this.database
      .prepare(`
        INSERT OR REPLACE INTO generation_history
          (id, owner, created_at, started_at, updated_at, status, endpoint, account, model, prompt, ratio, size, quality,
           output_format, duration_ms, request_json, response_summary_json, error, reference_images_json, images_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.owner ?? null,
        item.createdAt,
        item.startedAt ?? null,
        item.updatedAt,
        item.status,
        item.endpoint,
        item.account,
        item.model,
        item.prompt,
        item.ratio ?? null,
        item.size ?? null,
        item.quality ?? null,
        item.outputFormat ?? null,
        item.durationMs,
        JSON.stringify(item.request),
        item.responseSummary ? JSON.stringify(item.responseSummary) : null,
        item.error ?? null,
        JSON.stringify(item.referenceImages),
        JSON.stringify(item.images),
      );
    if (item.status !== "queued" && item.status !== "running") {
      this.deleteCoveredRunningGenerations(item.owner, {
        id: item.id,
        owner: item.owner,
        endpoint: item.endpoint,
        prompt: item.prompt,
        createdAt: item.createdAt,
      });
    }
    this.prune("generation_history", "created_at", MAX_GENERATION_HISTORY);
    return item;
  }

  private deleteCoveredRunningGenerations(owner?: string, target?: GenerationDedupTarget): void {
    const oneHourMs = 60 * 60 * 1000;
    if (target) {
      this.database
        .prepare(`
          DELETE FROM generation_history
          WHERE status IN ('queued', 'running')
            AND id <> ?
            AND endpoint = ?
            AND prompt = ?
            AND (? IS NULL OR owner = ?)
            AND ABS(created_at - ?) <= ?
        `)
        .run(target.id, target.endpoint, target.prompt, target.owner ?? null, target.owner ?? null, target.createdAt, oneHourMs);
      return;
    }

    this.database
      .prepare(`
        DELETE FROM generation_history
        WHERE status IN ('queued', 'running')
          AND (? IS NULL OR owner = ?)
          AND EXISTS (
            SELECT 1
            FROM generation_history done
            WHERE done.status IN ('success', 'failed')
              AND done.id <> generation_history.id
              AND done.endpoint = generation_history.endpoint
              AND done.prompt = generation_history.prompt
              AND COALESCE(done.owner, '') = COALESCE(generation_history.owner, '')
              AND ABS(done.created_at - generation_history.created_at) <= ?
          )
      `)
      .run(owner ?? null, owner ?? null, oneHourMs);
  }

  private get database(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(getDatabasePath());
    }
    return this.db;
  }

  private prune(table: string, orderColumn: string, max: number): void {
    this.database.prepare(`
      DELETE FROM ${table}
      WHERE id NOT IN (
        SELECT id FROM ${table}
        ORDER BY ${orderColumn} DESC
        LIMIT ?
      )
    `).run(max);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      this.database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
  }

  private ensureDefaultUserGroups(): void {
    const now = Date.now();
    this.database
      .prepare(`
        INSERT OR IGNORE INTO gateway_user_groups (id, name, sort_order, image_limits_disabled, per_user_daily, per_user_hourly, min_interval_seconds, created_at, updated_at)
        VALUES (?, '普通用户组', 0, 0, NULL, NULL, NULL, ?, ?)
      `)
      .run(DEFAULT_USER_GROUP_ID, now, now);
    this.database
      .prepare(`
        INSERT OR IGNORE INTO gateway_user_groups (id, name, sort_order, image_limits_disabled, per_user_daily, per_user_hourly, min_interval_seconds, created_at, updated_at)
        VALUES (?, 'VIP 用户组', 100, 1, NULL, NULL, NULL, ?, ?)
      `)
      .run(DEFAULT_VIP_GROUP_ID, now, now);
    this.database.prepare("UPDATE gateway_users SET group_id = ? WHERE group_id IS NULL OR group_id = ''").run(DEFAULT_USER_GROUP_ID);
  }

  private async ensureUserGroupFallback(deletingId: string): Promise<string | null> {
    const fallback = this.database
      .prepare("SELECT id FROM gateway_user_groups WHERE id <> ? ORDER BY sort_order ASC, created_at ASC LIMIT 1")
      .get(deletingId) as { id?: unknown } | undefined;
    if (typeof fallback?.id === "string" && fallback.id) {
      return fallback.id;
    }
    return null;
  }

  private mapUserGroup(row: Record<string, unknown>): GatewayUserGroup {
    return {
      id: String(row.id),
      name: String(row.name),
      sortOrder: Number(row.sortOrder ?? 0),
      imageLimitsDisabled: Boolean(row.imageLimitsDisabled),
      perUserDaily: row.perUserDaily === null || row.perUserDaily === undefined ? undefined : Number(row.perUserDaily),
      perUserHourly: row.perUserHourly === null || row.perUserHourly === undefined ? undefined : Number(row.perUserHourly),
      minIntervalSeconds: row.minIntervalSeconds === null || row.minIntervalSeconds === undefined ? undefined : Number(row.minIntervalSeconds),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapUserRecord(row: Record<string, unknown>): GatewayUserRecord {
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: typeof row.displayName === "string" && row.displayName.trim() ? row.displayName.trim() : undefined,
      passwordHash: String(row.passwordHash),
      apiKeyHash: typeof row.apiKeyHash === "string" && row.apiKeyHash.trim() ? row.apiKeyHash.trim() : undefined,
      apiKeyConfigured: typeof row.apiKeyHash === "string" && Boolean(row.apiKeyHash.trim()),
      role: row.role === "admin" ? "admin" : "user",
      groupId: typeof row.groupId === "string" ? row.groupId : undefined,
      groupName: typeof row.groupName === "string" ? row.groupName : undefined,
      groupSortOrder: Number(row.groupSortOrder ?? 0),
      groupImageLimitsDisabled: Boolean(row.groupImageLimitsDisabled),
      groupPerUserDaily: row.groupPerUserDaily === null || row.groupPerUserDaily === undefined ? undefined : Number(row.groupPerUserDaily),
      groupPerUserHourly: row.groupPerUserHourly === null || row.groupPerUserHourly === undefined ? undefined : Number(row.groupPerUserHourly),
      groupMinIntervalSeconds: row.groupMinIntervalSeconds === null || row.groupMinIntervalSeconds === undefined ? undefined : Number(row.groupMinIntervalSeconds),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      disabled: Boolean(row.disabled),
    };
  }

  private mapChatConversation(row: Record<string, unknown>): ChatConversation {
    const lastMessage = typeof row.lastMessage === "string" ? chatPreview(row.lastMessage) : undefined;
    return {
      id: String(row.id),
      owner: typeof row.owner === "string" ? row.owner : undefined,
      title: String(row.title || "新对话"),
      model: typeof row.model === "string" ? row.model : undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      messageCount: Number(row.messageCount ?? 0),
      lastMessagePreview: lastMessage || undefined,
    };
  }

  private mapChatMessage(row: Record<string, unknown>): ChatMessage {
    const role = row.role === "assistant" ? "assistant" : "user";
    const status = row.status === "running" || row.status === "failed" ? row.status : "success";
    const metadata = parseJsonObject(row.metadataJson);
    return {
      id: String(row.id),
      conversationId: String(row.conversationId),
      owner: typeof row.owner === "string" ? row.owner : undefined,
      role,
      content: String(row.content ?? ""),
      attachments: parseChatAttachments(metadata),
      status,
      model: typeof row.model === "string" ? row.model : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      metadata,
    };
  }

  private getChatMessagePage(
    conversationId: string,
    owner?: string,
    options?: ChatConversationMessagePageOptions,
  ): { messages: ChatMessage[]; hasMoreMessages: boolean; nextBeforeMessageId?: string } {
    const limit = clampLimit(options?.messageLimit ?? DEFAULT_CHAT_MESSAGE_PAGE_SIZE, MAX_CHAT_MESSAGE_PAGE_SIZE);
    let beforeCreatedAt: number | null = null;
    let beforeRowid: number | null = null;

    if (options?.beforeMessageId) {
      const before = this.database
        .prepare(`
          SELECT created_at AS createdAt, rowid AS rowid
          FROM chat_messages
          WHERE id = ?
            AND conversation_id = ?
            AND (? IS NULL OR owner = ?)
        `)
        .get(options.beforeMessageId, conversationId, owner ?? null, owner ?? null) as { createdAt?: unknown; rowid?: unknown } | undefined;
      if (!before) {
        return { messages: [], hasMoreMessages: false };
      }
      beforeCreatedAt = Number(before.createdAt);
      beforeRowid = Number(before.rowid);
    }

    const rows = this.database
      .prepare(`
        SELECT id, conversation_id AS conversationId, owner, role, content, status, model, error,
               created_at AS createdAt, updated_at AS updatedAt, metadata_json AS metadataJson
        FROM chat_messages
        WHERE conversation_id = ?
          AND (? IS NULL OR owner = ?)
          AND (
            ? IS NULL
            OR created_at < ?
            OR (created_at = ? AND rowid < ?)
          )
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(
        conversationId,
        owner ?? null,
        owner ?? null,
        beforeCreatedAt,
        beforeCreatedAt,
        beforeCreatedAt,
        beforeRowid,
        limit + 1,
      ) as Array<Record<string, unknown>>;

    const hasMoreMessages = rows.length > limit;
    const pageRows = (hasMoreMessages ? rows.slice(0, limit) : rows).reverse();
    const messages = pageRows.map((row) => this.mapChatMessage(row));
    return {
      messages,
      hasMoreMessages,
      nextBeforeMessageId: hasMoreMessages ? messages[0]?.id : undefined,
    };
  }

  private getAllChatMessages(conversationId: string, owner?: string): { messages: ChatMessage[]; hasMoreMessages: boolean; nextBeforeMessageId?: string } {
    const rows = this.database
      .prepare(`
        SELECT id, conversation_id AS conversationId, owner, role, content, status, model, error,
               created_at AS createdAt, updated_at AS updatedAt, metadata_json AS metadataJson
        FROM chat_messages
        WHERE conversation_id = ? AND (? IS NULL OR owner = ?)
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(conversationId, owner ?? null, owner ?? null) as Array<Record<string, unknown>>;
    return {
      messages: rows.map((row) => this.mapChatMessage(row)),
      hasMoreMessages: false,
      nextBeforeMessageId: undefined,
    };
  }

  private async getChatMessage(id: string, owner?: string): Promise<ChatMessage | null> {
    const row = this.database
      .prepare(`
        SELECT id, conversation_id AS conversationId, owner, role, content, status, model, error,
               created_at AS createdAt, updated_at AS updatedAt, metadata_json AS metadataJson
        FROM chat_messages
        WHERE id = ? AND (? IS NULL OR owner = ?)
      `)
      .get(id, owner ?? null, owner ?? null) as Record<string, unknown> | undefined;
    return row ? this.mapChatMessage(row) : null;
  }

  private touchChatConversation(id: string, updatedAt = Date.now()): void {
    this.database
      .prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
  }

  private pruneChatConversations(owner?: string): void {
    const staleRows = this.database
      .prepare(`
        SELECT id
        FROM chat_conversations
        WHERE (? IS NULL OR owner = ?)
          AND id NOT IN (
            SELECT id
            FROM chat_conversations
            WHERE (? IS NULL OR owner = ?)
            ORDER BY updated_at DESC
            LIMIT ?
          )
      `)
      .all(owner ?? null, owner ?? null, owner ?? null, owner ?? null, MAX_CHAT_CONVERSATIONS) as Array<{ id?: unknown }>;
    for (const row of staleRows) {
      if (typeof row.id !== "string") {
        continue;
      }
      this.database.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(row.id);
      this.database.prepare("DELETE FROM chat_conversations WHERE id = ?").run(row.id);
    }
  }

  private async persistGeneratedImages(id: string, data: Array<{ b64_json?: string; revised_prompt?: string }>, format: string): Promise<GenerationImageAsset[]> {
    const mimeType = outputMimeType(format);
    const extension = extensionForMimeType(mimeType);
    const dir = path.join(getGenerationAssetsDir(), id);
    await fs.mkdir(dir, { recursive: true });

    const assets: GenerationImageAsset[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const b64 = data[index]?.b64_json ?? "";
      if (!b64) {
        continue;
      }
      const bytes = Buffer.from(b64, "base64");
      const filename = `generated-${index + 1}.${extension}`;
      const relativePath = `${id}/${filename}`;
      await fs.writeFile(path.join(dir, filename), bytes);
      const metadata: { width?: number; height?: number } = await sharp(bytes, { failOn: "none" }).metadata().catch(() => ({}));
      const preview = await this.createImagePreview(dir, id, filename, bytes);
      assets.push({
        filename,
        path: relativePath,
        url: `/_gateway/generations/images/${relativePath}`,
        mimeType,
        size: bytes.byteLength,
        width: metadata.width,
        height: metadata.height,
        ...preview,
      });
    }
    return assets;
  }

  private async createImagePreview(
    dir: string,
    id: string,
    originalFilename: string,
    bytes: Buffer,
  ): Promise<Pick<GenerationImageAsset, "previewFilename" | "previewPath" | "previewUrl" | "previewMimeType" | "previewSize">> {
    const previewFilename = `${path.parse(originalFilename).name}.preview.webp`;
    const previewRelativePath = `${id}/${previewFilename}`;
    const previewPath = path.join(dir, previewFilename);
    const targetBytes = Math.max(24 * 1024, Math.min(MAX_PREVIEW_BYTES, Math.floor(bytes.byteLength / 10)));

    try {
      const metadata = await sharp(bytes, { failOn: "none" }).metadata();
      const width = metadata.width ?? 1024;
      const height = metadata.height ?? 1024;
      const longestSide = Math.max(width, height);
      let scale = Math.min(1, Math.sqrt(targetBytes / Math.max(1, bytes.byteLength)));
      let quality = 78;
      let previewBytes: Buffer | null = null;

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const resizedLongestSide = Math.max(120, Math.round(longestSide * scale));
        previewBytes = await sharp(bytes, { failOn: "none" })
          .resize({
            width: width >= height ? resizedLongestSide : undefined,
            height: height > width ? resizedLongestSide : undefined,
            withoutEnlargement: true,
          })
          .webp({ quality, effort: 4 })
          .toBuffer();

        if (previewBytes.byteLength <= targetBytes) {
          break;
        }
        scale *= 0.72;
        quality = Math.max(28, quality - 8);
      }

      if (!previewBytes) {
        return {};
      }

      await fs.writeFile(previewPath, previewBytes);
      return {
        previewFilename,
        previewPath: previewRelativePath,
        previewUrl: `/_gateway/generations/images/${previewRelativePath}`,
        previewMimeType: "image/webp",
        previewSize: previewBytes.byteLength,
      };
    } catch (error) {
      console.warn("[gateway:db] failed to create image preview", {
        id,
        filename: originalFilename,
        message: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  private async persistReferences(id: string, references: Array<{ name?: string; value: string }>): Promise<GenerationReferenceAsset[]> {
    const dir = path.join(getGenerationAssetsDir(), id, "references");
    const assets: GenerationReferenceAsset[] = [];
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      const parsed = parseDataUrl(reference.value);
      if (!parsed) {
        assets.push({
          name: reference.name,
          sourceType: /^https?:\/\//i.test(reference.value) ? "url" : "file-id",
          source: reference.value,
        });
        continue;
      }

      await fs.mkdir(dir, { recursive: true });
      const extension = extensionForMimeType(parsed.mimeType);
      const safeName = sanitizeFileName(reference.name ?? `reference-${index + 1}.${extension}`);
      const filename = safeName.includes(".") ? safeName : `${safeName}.${extension}`;
      const relativePath = `${id}/references/${filename}`;
      await fs.writeFile(path.join(dir, filename), parsed.bytes);
      assets.push({
        name: reference.name ?? filename,
        path: relativePath,
        url: `/_gateway/generations/images/${relativePath}`,
        mimeType: parsed.mimeType,
        size: parsed.bytes.byteLength,
        sourceType: "data-url",
      });
    }
    return assets;
  }
}
