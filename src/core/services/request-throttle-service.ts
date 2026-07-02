import type { OAuthProfile } from "../types.js";
import { ConfigService } from "./config-service.js";
import { RedisThrottleStore } from "./redis-throttle-store.js";

type ThrottleSettings = {
  enabled: boolean;
  maxConcurrency: number;
  minDelayMs: number;
  jitterMs: number;
};

type ProfileQueueState = {
  running: number;
  waiters: ProfileQueueWaiter[];
};

type ProfileQueueWaiter = {
  priority: number;
  enqueuedAt: number;
  resolve: () => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export class RequestThrottleService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly concurrencyQueues = new Map<string, ProfileQueueState>();
  private readonly lastStartTimes = new Map<string, number>();
  private readonly redisStore = RedisThrottleStore.fromEnv();

  constructor(private readonly configService: ConfigService) {}

  private async getThrottleSettings(): Promise<ThrottleSettings> {
    const settings = await this.configService.getSettings();
    return {
      enabled: readBooleanEnv("AZT_CODEX_REQUEST_SERIALIZATION_ENABLED", settings.runtime.codexRequestSerializationEnabled),
      maxConcurrency: Math.max(1, readNumberEnv("AZT_ACCOUNT_MAX_CONCURRENCY", settings.runtime.accountMaxConcurrency)),
      minDelayMs: Math.max(0, readNumberEnv("AZT_CODEX_REQUEST_MIN_DELAY_MS", settings.runtime.codexRequestMinDelayMs)),
      jitterMs: Math.max(0, readNumberEnv("AZT_CODEX_REQUEST_JITTER_MS", settings.runtime.codexRequestJitterMs)),
    };
  }

  private getProfileQueue(queueKey: string): ProfileQueueState {
    let queue = this.concurrencyQueues.get(queueKey);
    if (!queue) {
      queue = {
        running: 0,
        waiters: [],
      };
      this.concurrencyQueues.set(queueKey, queue);
    }
    return queue;
  }

  private async acquireProfileSlot(
    queueKey: string,
    maxConcurrency: number,
    details?: { requestId?: string; route?: string; model?: string; priority?: number; onQueued?: () => void | Promise<void> },
  ): Promise<() => void> {
    const queue = this.getProfileQueue(queueKey);
    let acquiredFromQueue = false;
    const priority = Number.isFinite(details?.priority) ? Number(details?.priority) : 0;
    if (queue.running >= maxConcurrency) {
      console.info("[gateway:throttle] queued Codex request", {
        profileId: queueKey,
        route: details?.route,
        model: details?.model,
        requestId: details?.requestId,
        priority,
        running: queue.running,
        queued: queue.waiters.length + 1,
        maxConcurrency,
      });
      await details?.onQueued?.();
      await new Promise<void>((resolve) => {
        queue.waiters.push({
          priority,
          enqueuedAt: Date.now(),
          resolve: () => {
            acquiredFromQueue = true;
            resolve();
          },
        });
        queue.waiters.sort((first, second) => second.priority - first.priority || first.enqueuedAt - second.enqueuedAt);
      });
    }

    if (!acquiredFromQueue) {
      queue.running += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = queue.waiters.shift();
      if (next) {
        next.resolve();
        return;
      }
      queue.running = Math.max(0, queue.running - 1);
      if (queue.running === 0) {
        this.concurrencyQueues.delete(queueKey);
      }
    };
  }

  private async acquireRedisProfileSlot(
    queueKey: string,
    maxConcurrency: number,
    details?: { requestId?: string; route?: string; model?: string; priority?: number; onQueued?: () => void | Promise<void> },
  ): Promise<{ token: string; release: () => Promise<void> }> {
    const redisStore = this.redisStore;
    if (!redisStore) {
      throw new Error("Redis throttle store is not configured.");
    }

    const token = redisStore.createLeaseToken(queueKey);
    let queued = false;
    while (true) {
      const result = await redisStore.tryAcquireSlot(queueKey, token, maxConcurrency);
      if (result.acquired) {
        return {
          token,
          release: async () => {
            await redisStore.releaseSlot(queueKey, token);
          },
        };
      }

      if (!queued) {
        queued = true;
        console.info("[gateway:throttle] queued Codex request in Redis", {
          profileId: queueKey,
          route: details?.route,
          model: details?.model,
          requestId: details?.requestId,
          priority: Number.isFinite(details?.priority) ? Number(details?.priority) : 0,
          running: result.running,
          maxConcurrency,
          retryAfterMs: result.retryAfterMs,
        });
        await details?.onQueued?.();
      }

      await sleep(redisStore.getPollDelayMs(result.retryAfterMs));
    }
  }

  private startRedisSlotHeartbeat(queueKey: string, token: string): () => void {
    const redisStore = this.redisStore;
    if (!redisStore) {
      return () => undefined;
    }

    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      void redisStore.refreshSlot(queueKey, token).catch((error) => {
        console.warn("[gateway:throttle] failed to refresh Redis throttle slot", {
          profileId: queueKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, redisStore.heartbeatIntervalMs);
    timer.unref();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async waitForRedisStartTurn(
    profile: OAuthProfile,
    settings: ThrottleSettings,
    details?: { requestId?: string; route?: string; model?: string },
  ): Promise<void> {
    const redisStore = this.redisStore;
    if (!redisStore || !settings.enabled) {
      return;
    }

    const queueKey = profile.profileId;
    while (true) {
      const jitterMs = settings.jitterMs > 0 ? Math.floor(Math.random() * settings.jitterMs) : 0;
      const reservation = await redisStore.reserveStart(queueKey, settings.minDelayMs, jitterMs);
      if (reservation.reserved) {
        return;
      }

      console.info("[gateway:throttle] delaying Codex request in Redis", {
        profileId: queueKey,
        route: details?.route,
        model: details?.model,
        requestId: details?.requestId,
        waitMs: reservation.waitMs,
      });
      await sleep(Math.max(50, Math.min(reservation.waitMs || redisStore.pollIntervalMs, redisStore.pollIntervalMs)));
    }
  }

  async runForProfile<T>(
    profile: OAuthProfile,
    operation: () => Promise<T>,
    details?: {
      requestId?: string;
      route?: string;
      model?: string;
      priority?: number;
      onQueued?: () => void | Promise<void>;
      onStart?: () => void | Promise<void>;
    },
  ): Promise<T> {
    const settings = await this.getThrottleSettings();
    const queueKey = profile.profileId;
    if (this.redisStore) {
      const slot = await this.acquireRedisProfileSlot(queueKey, settings.maxConcurrency, details);
      const stopHeartbeat = this.startRedisSlotHeartbeat(queueKey, slot.token);
      let released = false;
      const release = async () => {
        if (released) {
          return;
        }
        released = true;
        stopHeartbeat();
        try {
          await slot.release();
        } catch (error) {
          console.warn("[gateway:throttle] failed to release Redis throttle slot", {
            profileId: queueKey,
            route: details?.route,
            model: details?.model,
            requestId: details?.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      let started = false;
      const runOperation = async () => {
        if (!started) {
          started = true;
          await details?.onStart?.();
        }
        return operation();
      };

      try {
        await this.waitForRedisStartTurn(profile, settings, details);
        return await runOperation();
      } finally {
        await release();
      }
    }

    const release = await this.acquireProfileSlot(queueKey, settings.maxConcurrency, details);
    let started = false;
    const runOperation = async () => {
      if (!started) {
        started = true;
        await details?.onStart?.();
      }
      return operation();
    };

    if (!settings.enabled) {
      try {
        return await runOperation();
      } finally {
        release();
      }
    }

    if (settings.maxConcurrency > 1) {
      try {
        const jitterMs = settings.jitterMs > 0 ? Math.floor(Math.random() * settings.jitterMs) : 0;
        const earliestStartAt = (this.lastStartTimes.get(queueKey) ?? 0) + settings.minDelayMs + jitterMs;
        const waitMs = Math.max(0, earliestStartAt - Date.now());
        if (waitMs > 0) {
          console.info("[gateway:throttle] delaying Codex request", {
            profileId: profile.profileId,
            route: details?.route,
            model: details?.model,
            requestId: details?.requestId,
            waitMs,
          });
          await sleep(waitMs);
        }
        this.lastStartTimes.set(queueKey, Date.now());
        return await runOperation();
      } finally {
        release();
      }
    }

    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const scheduled = previous.catch(() => undefined).then(async () => {
      const jitterMs = settings.jitterMs > 0 ? Math.floor(Math.random() * settings.jitterMs) : 0;
      const earliestStartAt = (this.lastStartTimes.get(queueKey) ?? 0) + settings.minDelayMs + jitterMs;
      const waitMs = Math.max(0, earliestStartAt - Date.now());
      if (waitMs > 0) {
        console.info("[gateway:throttle] delaying Codex request", {
          profileId: profile.profileId,
          route: details?.route,
          model: details?.model,
          requestId: details?.requestId,
          waitMs,
        });
        await sleep(waitMs);
      }

      this.lastStartTimes.set(queueKey, Date.now());
      return runOperation();
    });
    const tail = scheduled.then(() => undefined, () => undefined);
    this.queues.set(queueKey, tail);

    try {
      return await scheduled;
    } finally {
      release();
      if (this.queues.get(queueKey) === tail) {
        this.queues.delete(queueKey);
      }
    }
  }
}
