import type { OAuthProfile } from "../types.js";
import { ConfigService } from "./config-service.js";

type ThrottleSettings = {
  enabled: boolean;
  minDelayMs: number;
  jitterMs: number;
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
  private readonly lastStartTimes = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {}

  private async getThrottleSettings(): Promise<ThrottleSettings> {
    const settings = await this.configService.getSettings();
    return {
      enabled: readBooleanEnv("AZT_CODEX_REQUEST_SERIALIZATION_ENABLED", settings.runtime.codexRequestSerializationEnabled),
      minDelayMs: Math.max(0, readNumberEnv("AZT_CODEX_REQUEST_MIN_DELAY_MS", settings.runtime.codexRequestMinDelayMs)),
      jitterMs: Math.max(0, readNumberEnv("AZT_CODEX_REQUEST_JITTER_MS", settings.runtime.codexRequestJitterMs)),
    };
  }

  async runForProfile<T>(
    profile: OAuthProfile,
    operation: () => Promise<T>,
    details?: { requestId?: string; route?: string; model?: string },
  ): Promise<T> {
    const settings = await this.getThrottleSettings();
    if (!settings.enabled) {
      return operation();
    }

    const queueKey = profile.profileId;
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
      return operation();
    });
    const tail = scheduled.then(() => undefined, () => undefined);
    this.queues.set(queueKey, tail);

    try {
      return await scheduled;
    } finally {
      if (this.queues.get(queueKey) === tail) {
        this.queues.delete(queueKey);
      }
    }
  }
}
