import type { OAuthProfile } from "../types.js";
import { ConfigService } from "./config-service.js";

type ThrottleSettings = {
  enabled: boolean;
  maxConcurrency: number;
  minDelayMs: number;
  jitterMs: number;
};

type ProfileQueueState = {
  running: number;
  waiters: Array<() => void>;
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
    details?: { requestId?: string; route?: string; model?: string; onQueued?: () => void | Promise<void> },
  ): Promise<() => void> {
    const queue = this.getProfileQueue(queueKey);
    let acquiredFromQueue = false;
    if (queue.running >= maxConcurrency) {
      console.info("[gateway:throttle] queued Codex request", {
        profileId: queueKey,
        route: details?.route,
        model: details?.model,
        requestId: details?.requestId,
        running: queue.running,
        queued: queue.waiters.length + 1,
        maxConcurrency,
      });
      await details?.onQueued?.();
      await new Promise<void>((resolve) => {
        queue.waiters.push(() => {
          acquiredFromQueue = true;
          resolve();
        });
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
        next();
        return;
      }
      queue.running = Math.max(0, queue.running - 1);
      if (queue.running === 0) {
        this.concurrencyQueues.delete(queueKey);
      }
    };
  }

  async runForProfile<T>(
    profile: OAuthProfile,
    operation: () => Promise<T>,
    details?: {
      requestId?: string;
      route?: string;
      model?: string;
      onQueued?: () => void | Promise<void>;
      onStart?: () => void | Promise<void>;
    },
  ): Promise<T> {
    const settings = await this.getThrottleSettings();
    const queueKey = profile.profileId;
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
