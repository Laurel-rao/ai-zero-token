import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

type RedisCommandArgument = string | number;
type RedisReply = string | number | null | RedisReply[];

type RedisConnectionOptions = {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  database?: number;
  commandTimeoutMs: number;
};

type PendingCommand = {
  resolve: (reply: RedisReply) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type RedisThrottleAcquireResult = {
  acquired: boolean;
  running: number;
  retryAfterMs: number;
};

export type RedisThrottleStartReservation = {
  reserved: boolean;
  waitMs: number;
  lastStartMs: number;
};

const ACQUIRE_SLOT_SCRIPT = `
local runningKey = KEYS[1]
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local ttlMs = tonumber(ARGV[1])
local maxConcurrency = tonumber(ARGV[2])
local token = ARGV[3]

redis.call("ZREMRANGEBYSCORE", runningKey, "-inf", nowMs)

if redis.call("ZSCORE", runningKey, token) then
  redis.call("ZADD", runningKey, "XX", nowMs + ttlMs, token)
  redis.call("PEXPIRE", runningKey, ttlMs)
  return {1, redis.call("ZCARD", runningKey), 0}
end

local running = redis.call("ZCARD", runningKey)
if running < maxConcurrency then
  redis.call("ZADD", runningKey, nowMs + ttlMs, token)
  redis.call("PEXPIRE", runningKey, ttlMs)
  return {1, running + 1, 0}
end

local oldest = redis.call("ZRANGE", runningKey, 0, 0, "WITHSCORES")
local retryAfterMs = ttlMs
if oldest[2] then
  retryAfterMs = math.max(1, tonumber(oldest[2]) - nowMs)
end
redis.call("PEXPIRE", runningKey, math.max(ttlMs, retryAfterMs))
return {0, running, retryAfterMs}
`;

const RELEASE_SLOT_SCRIPT = `
local runningKey = KEYS[1]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])

local removed = redis.call("ZREM", runningKey, token)
local running = redis.call("ZCARD", runningKey)
if running == 0 then
  redis.call("DEL", runningKey)
else
  redis.call("PEXPIRE", runningKey, ttlMs)
end

return {removed, running}
`;

const REFRESH_SLOT_SCRIPT = `
local runningKey = KEYS[1]
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local ttlMs = tonumber(ARGV[1])
local token = ARGV[2]

if redis.call("ZSCORE", runningKey, token) then
  redis.call("ZADD", runningKey, "XX", nowMs + ttlMs, token)
  redis.call("PEXPIRE", runningKey, ttlMs)
  return 1
end

return 0
`;

const RESERVE_START_SCRIPT = `
local lastStartKey = KEYS[1]
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local minDelayMs = tonumber(ARGV[1])
local jitterMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])

local lastStartMs = tonumber(redis.call("GET", lastStartKey)) or 0
local earliestStartMs = lastStartMs + minDelayMs + jitterMs
if earliestStartMs > nowMs then
  redis.call("PEXPIRE", lastStartKey, ttlMs)
  return {0, earliestStartMs - nowMs, lastStartMs}
end

redis.call("SET", lastStartKey, nowMs, "PX", ttlMs)
return {1, 0, nowMs}
`;

class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisReplyError";
  }
}

class RedisProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisProtocolError";
  }
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function encodeCommand(args: RedisCommandArgument[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(String(arg));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

function findLineEnd(buffer: Buffer, offset: number): number {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}

function parseIntegerLine(buffer: Buffer, start: number, end: number): number {
  const parsed = Number.parseInt(buffer.subarray(start, end).toString("utf8"), 10);
  if (!Number.isFinite(parsed)) {
    throw new RedisProtocolError("Invalid Redis integer reply.");
  }
  return parsed;
}

function parseReply(buffer: Buffer, offset = 0): { value: RedisReply | RedisReplyError; offset: number } | null {
  if (offset >= buffer.length) {
    return null;
  }

  const prefix = buffer[offset];
  if (prefix === 43 || prefix === 45 || prefix === 58) {
    const lineEnd = findLineEnd(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }

    const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
    const nextOffset = lineEnd + 2;
    if (prefix === 43) {
      return { value: line, offset: nextOffset };
    }
    if (prefix === 45) {
      return { value: new RedisReplyError(line), offset: nextOffset };
    }
    return { value: parseIntegerLine(buffer, offset + 1, lineEnd), offset: nextOffset };
  }

  if (prefix === 36) {
    const lineEnd = findLineEnd(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }

    const length = parseIntegerLine(buffer, offset + 1, lineEnd);
    const dataStart = lineEnd + 2;
    if (length === -1) {
      return { value: null, offset: dataStart };
    }
    const dataEnd = dataStart + length;
    if (buffer.length < dataEnd + 2) {
      return null;
    }
    return {
      value: buffer.subarray(dataStart, dataEnd).toString("utf8"),
      offset: dataEnd + 2,
    };
  }

  if (prefix === 42) {
    const lineEnd = findLineEnd(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }

    const length = parseIntegerLine(buffer, offset + 1, lineEnd);
    let nextOffset = lineEnd + 2;
    if (length === -1) {
      return { value: null, offset: nextOffset };
    }

    const values: RedisReply[] = [];
    for (let index = 0; index < length; index += 1) {
      const parsed = parseReply(buffer, nextOffset);
      if (!parsed) {
        return null;
      }
      if (parsed.value instanceof RedisReplyError) {
        throw parsed.value;
      }
      values.push(parsed.value);
      nextOffset = parsed.offset;
    }
    return { value: values, offset: nextOffset };
  }

  throw new RedisProtocolError(`Unsupported Redis reply prefix: ${String.fromCharCode(prefix)}.`);
}

function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("AZT_REDIS_URL must use redis:// or rediss://.");
  }

  const database = url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : undefined;
  if (database !== undefined && (!Number.isFinite(database) || database < 0)) {
    throw new Error("AZT_REDIS_URL has an invalid database path.");
  }

  return {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number.parseInt(url.port, 10) : url.protocol === "rediss:" ? 6380 : 6379,
    tls: url.protocol === "rediss:",
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
    commandTimeoutMs: readPositiveNumberEnv("AZT_REDIS_COMMAND_TIMEOUT_MS", 5000),
  };
}

function replyNumber(reply: RedisReply, fallback = 0): number {
  if (typeof reply === "number") {
    return reply;
  }
  if (typeof reply === "string") {
    const parsed = Number(reply);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function replyArray(reply: RedisReply): RedisReply[] {
  return Array.isArray(reply) ? reply : [];
}

class RedisClient {
  private socket?: net.Socket | tls.TLSSocket;
  private connecting?: Promise<void>;
  private ready = false;
  private buffer = Buffer.alloc(0);
  private readonly pending: PendingCommand[] = [];

  constructor(private readonly options: RedisConnectionOptions) {}

  async command(args: RedisCommandArgument[]): Promise<RedisReply> {
    await this.ensureConnected();
    return this.sendCommand(args);
  }

  private async ensureConnected(): Promise<void> {
    if (this.ready && this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    this.destroyCurrent(new Error("Redis connection replaced."));

    const socket = this.options.tls
      ? tls.connect({
          host: this.options.host,
          port: this.options.port,
          servername: this.options.host,
        })
      : net.connect({
          host: this.options.host,
          port: this.options.port,
        });

    this.socket = socket;
    this.ready = false;
    this.buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      if (this.socket === socket) {
        this.handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    socket.on("error", (error) => {
      if (this.socket === socket) {
        this.handleSocketError(error);
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.handleSocketClose();
      }
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("secureConnect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onClose = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("Redis connection closed before it was ready."));
      };

      if (this.options.tls) {
        socket.once("secureConnect", onConnect);
      } else {
        socket.once("connect", onConnect);
      }
      socket.once("error", onError);
      socket.once("close", onClose);
    });

    try {
      if (this.options.password) {
        if (this.options.username) {
          await this.sendCommand(["AUTH", this.options.username, this.options.password]);
        } else {
          await this.sendCommand(["AUTH", this.options.password]);
        }
      }
      if (this.options.database !== undefined && this.options.database > 0) {
        await this.sendCommand(["SELECT", this.options.database]);
      }
      this.ready = true;
    } catch (error) {
      this.destroyCurrent(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private sendCommand(args: RedisCommandArgument[]): Promise<RedisReply> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("Redis connection is not available."));
    }

    return new Promise<RedisReply>((resolve, reject) => {
      const command: PendingCommand = { resolve, reject };
      command.timer = setTimeout(() => {
        this.removePending(command);
        this.destroyCurrent(new Error(`Redis command timed out after ${this.options.commandTimeoutMs}ms.`));
        reject(new Error(`Redis command timed out after ${this.options.commandTimeoutMs}ms.`));
      }, this.options.commandTimeoutMs);
      if (typeof command.timer === "object" && "unref" in command.timer) {
        command.timer.unref();
      }

      this.pending.push(command);
      try {
        socket.write(encodeCommand(args));
      } catch (error) {
        this.removePending(command);
        if (command.timer) {
          clearTimeout(command.timer);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.pending.length > 0) {
        const parsed = parseReply(this.buffer);
        if (!parsed) {
          return;
        }
        this.buffer = this.buffer.subarray(parsed.offset);
        const pending = this.pending.shift();
        if (!pending) {
          continue;
        }
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (parsed.value instanceof RedisReplyError) {
          pending.reject(parsed.value);
        } else {
          pending.resolve(parsed.value);
        }
      }
    } catch (error) {
      this.destroyCurrent(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleSocketError(error: Error): void {
    this.destroyCurrent(error);
  }

  private handleSocketClose(): void {
    this.destroyCurrent(new Error("Redis connection closed."));
  }

  private removePending(command: PendingCommand): void {
    const index = this.pending.indexOf(command);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  }

  private destroyCurrent(error: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const command of this.pending.splice(0)) {
      if (command.timer) {
        clearTimeout(command.timer);
      }
      command.reject(error);
    }
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  }
}

export class RedisThrottleStore {
  private readonly client: RedisClient;
  readonly slotTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;

  static fromEnv(): RedisThrottleStore | null {
    const redisUrl = process.env.AZT_REDIS_URL?.trim();
    if (!redisUrl) {
      return null;
    }

    const keyPrefix = process.env.AZT_REDIS_KEY_PREFIX?.trim() || "azt";
    return new RedisThrottleStore({
      redisUrl,
      keyPrefix,
      slotTtlMs: readPositiveNumberEnv("AZT_REDIS_THROTTLE_SLOT_TTL_MS", 10 * 60 * 1000),
      pollIntervalMs: readPositiveNumberEnv("AZT_REDIS_THROTTLE_POLL_MS", 250),
    });
  }

  constructor(options: { redisUrl: string; keyPrefix: string; slotTtlMs: number; pollIntervalMs: number }) {
    this.client = new RedisClient(parseRedisUrl(options.redisUrl));
    this.slotTtlMs = options.slotTtlMs;
    this.heartbeatIntervalMs = Math.max(1000, Math.floor(this.slotTtlMs / 3));
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs);
    this.keyPrefix = options.keyPrefix.replace(/:+$/u, "") || "azt";
  }

  private readonly keyPrefix: string;

  createLeaseToken(profileId: string): string {
    return `${process.pid}:${profileId}:${Date.now()}:${crypto.randomUUID()}`;
  }

  getPollDelayMs(retryAfterMs: number): number {
    return Math.min(Math.max(50, retryAfterMs), this.pollIntervalMs) + Math.floor(Math.random() * 50);
  }

  async tryAcquireSlot(profileId: string, token: string, maxConcurrency: number): Promise<RedisThrottleAcquireResult> {
    const reply = replyArray(
      await this.client.command([
        "EVAL",
        ACQUIRE_SLOT_SCRIPT,
        1,
        this.runningKey(profileId),
        this.slotTtlMs,
        maxConcurrency,
        token,
      ]),
    );

    return {
      acquired: replyNumber(reply[0]) === 1,
      running: replyNumber(reply[1]),
      retryAfterMs: Math.max(1, replyNumber(reply[2], this.pollIntervalMs)),
    };
  }

  async releaseSlot(profileId: string, token: string): Promise<void> {
    await this.client.command(["EVAL", RELEASE_SLOT_SCRIPT, 1, this.runningKey(profileId), token, this.slotTtlMs]);
  }

  async refreshSlot(profileId: string, token: string): Promise<boolean> {
    const reply = await this.client.command([
      "EVAL",
      REFRESH_SLOT_SCRIPT,
      1,
      this.runningKey(profileId),
      this.slotTtlMs,
      token,
    ]);
    return replyNumber(reply) === 1;
  }

  async reserveStart(profileId: string, minDelayMs: number, jitterMs: number): Promise<RedisThrottleStartReservation> {
    const reply = replyArray(
      await this.client.command([
        "EVAL",
        RESERVE_START_SCRIPT,
        1,
        this.lastStartKey(profileId),
        minDelayMs,
        jitterMs,
        Math.max(this.slotTtlMs, minDelayMs + jitterMs + 60_000),
      ]),
    );

    return {
      reserved: replyNumber(reply[0]) === 1,
      waitMs: Math.max(0, replyNumber(reply[1])),
      lastStartMs: replyNumber(reply[2]),
    };
  }

  private runningKey(profileId: string): string {
    return `${this.keyPrefix}:request-throttle:${encodeURIComponent(profileId)}:running`;
  }

  private lastStartKey(profileId: string): string {
    return `${this.keyPrefix}:request-throttle:${encodeURIComponent(profileId)}:lastStart`;
  }
}
