import { formatWithOptions } from "node:util";

/**
 * 网关进程内实时日志总线。
 *
 * 服务端大量诊断信息通过 console.log/warn/error 输出（企微回调、生图、聊天、
 * HTTP 请求耗时等），这里把这些输出同时收进一个环形缓冲，并允许管理端通过
 * SSE 订阅，实现「系统设置/侧边栏」里的实时日志面板。
 *
 * 约束：
 * - 只在内存里保留最近 MAX_LOG_ENTRIES 条，重启即清空（不落库，避免体积与隐私问题）；
 * - console 只包装一次，记录日志的过程中出现任何异常都必须吞掉，不能影响业务输出。
 */

export type GatewayLogLevel = "info" | "warn" | "error";

export type GatewayLogEntry = {
  id: number;
  time: number;
  level: GatewayLogLevel;
  /** 从日志行首 `[tag]` 提取的模块标签，例如 gateway:wecom、http、gateway:image。 */
  scope: string;
  message: string;
  /** console 输出里首行之外的其余内容（对象、多行堆栈等），可能为空。 */
  detail?: string;
};

const MAX_LOG_ENTRIES = 1000;
const MAX_ENTRY_CHARS = 4000;
const MAX_MESSAGE_CHARS = 600;
const MAX_SNAPSHOT_ENTRIES = 300;

const SCOPE_PATTERN = /^\[([^\]\r\n]{1,60})\]\s*/u;
const NON_PRINTABLE_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu;

type GatewayLogListener = (entry: GatewayLogEntry) => void;

function extractScope(message: string): string {
  const match = SCOPE_PATTERN.exec(message);
  const scope = match?.[1]?.trim().toLowerCase();
  return scope || "console";
}

function formatConsoleArgs(args: unknown[]): string {
  try {
    return formatWithOptions(
      {
        colors: false,
        depth: 3,
        breakLength: Infinity,
        maxArrayLength: 30,
        maxStringLength: 2000,
        compact: true,
      },
      ...args,
    );
  } catch {
    return args
      .map((item) => (typeof item === "string" ? item : String(item)))
      .join(" ");
  }
}

class GatewayLogBus {
  private readonly entries: GatewayLogEntry[] = [];
  private readonly listeners = new Set<GatewayLogListener>();
  private nextId = 1;

  record(level: GatewayLogLevel, args: unknown[]): void {
    try {
      const formatted = formatConsoleArgs(args)
        .replace(/\r\n/g, "\n")
        .replace(NON_PRINTABLE_PATTERN, "")
        .trim();
      if (!formatted) {
        return;
      }
      const truncated = formatted.length > MAX_ENTRY_CHARS
        ? `${formatted.slice(0, MAX_ENTRY_CHARS)}…`
        : formatted;
      const [firstLine = "", ...restLines] = truncated.split("\n");
      const message = firstLine.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!message) {
        return;
      }
      const detail = restLines.join("\n").trim();
      const scope = extractScope(message);
      const entry: GatewayLogEntry = {
        id: this.nextId,
        time: Date.now(),
        level,
        scope,
        message,
        ...(detail ? { detail } : {}),
      };
      this.nextId += 1;
      this.entries.push(entry);
      if (this.entries.length > MAX_LOG_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
      }
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // 单个订阅者异常不能影响其它订阅者。
        }
      }
    } catch {
      // 记录日志本身失败时静默，保持业务日志原样输出。
    }
  }

  snapshot(limit = MAX_SNAPSHOT_ENTRIES): GatewayLogEntry[] {
    const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_SNAPSHOT_ENTRIES;
    return this.entries.slice(Math.max(0, this.entries.length - count));
  }

  subscribe(listener: GatewayLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** 仅测试用：清空缓冲和订阅者。 */
  reset(): void {
    this.entries.length = 0;
    this.listeners.clear();
    this.nextId = 1;
  }
}

const CONSOLE_TEE_KEY = Symbol.for("ai-zero-token.gateway-log-console-tee");

let gatewayLogBusInstance: GatewayLogBus | null = null;

export function getGatewayLogBus(): GatewayLogBus {
  gatewayLogBusInstance ??= new GatewayLogBus();
  return gatewayLogBusInstance;
}

type ConsoleTeeFlag = typeof globalThis & {
  [CONSOLE_TEE_KEY]?: boolean;
};

/**
 * 把 console.log/info/warn/error 复制一份进日志总线。
 * 使用 Symbol 守卫，保证同一进程内多个 createApp()（测试/端口重试）只包装一次。
 */
export function installGatewayConsoleLogTee(): void {
  const flag = globalThis as ConsoleTeeFlag;
  if (flag[CONSOLE_TEE_KEY]) {
    return;
  }
  flag[CONSOLE_TEE_KEY] = true;
  const bus = getGatewayLogBus();
  const methods: Array<{ level: GatewayLogLevel; method: "log" | "info" | "warn" | "error" }> = [
    { level: "info", method: "log" },
    { level: "info", method: "info" },
    { level: "warn", method: "warn" },
    { level: "error", method: "error" },
  ];
  for (const { level, method } of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      bus.record(level, args);
      original(...args);
    };
  }
}
