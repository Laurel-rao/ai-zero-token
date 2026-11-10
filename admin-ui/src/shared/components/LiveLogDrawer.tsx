import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { copyText } from "@/shared/lib/app-utils";

/**
 * 侧边栏「实时日志」抽屉：订阅 /_gateway/admin/logs/stream 的 SSE，
 * 展示网关进程内的 console 日志（企微回调、生图、聊天、HTTP 耗时等）。
 */

type GatewayLogLevel = "info" | "warn" | "error";

type GatewayLogEntry = {
  id: number;
  time: number;
  level: GatewayLogLevel;
  scope: string;
  message: string;
  detail?: string;
};

type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "forbidden" | "closed" | "error";

type LevelFilter = "all" | GatewayLogLevel;

const MAX_CLIENT_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 100;
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 15000, 15000] as const;
const AUTO_SCROLL_THRESHOLD_PX = 80;

const LEVEL_LABELS: Record<GatewayLogLevel, string> = {
  info: "信息",
  warn: "警告",
  error: "错误",
};

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatLogTime(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function scopeTone(scope: string): string {
  const normalized = scope.toLowerCase();
  if (normalized.includes("wecom")) return "wecom";
  if (normalized.includes("image")) return "image";
  if (normalized.includes("chat")) return "chat";
  if (normalized.startsWith("http")) return "http";
  if (normalized.includes("auth") || normalized.includes("oauth")) return "auth";
  if (normalized.includes("gateway")) return "gateway";
  return "other";
}

function parseSseBlocks(buffer: string, flush = false): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let index = rest.indexOf("\n\n");
  while (index >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const event = block
      .split("\n")
      .find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      events.push({ event, data });
    }
    index = rest.indexOf("\n\n");
  }
  if (flush && rest.trim()) {
    const event = rest
      .split("\n")
      .find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = rest
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      events.push({ event, data });
    }
    rest = "";
  }
  return { events, rest };
}

function parseLogEntry(payload: string): GatewayLogEntry | null {
  try {
    const parsed = JSON.parse(payload) as Partial<GatewayLogEntry>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.id !== "number" ||
      typeof parsed.time !== "number" ||
      (parsed.level !== "info" && parsed.level !== "warn" && parsed.level !== "error") ||
      typeof parsed.scope !== "string" ||
      typeof parsed.message !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      time: parsed.time,
      level: parsed.level,
      scope: parsed.scope,
      message: parsed.message,
      ...(typeof parsed.detail === "string" && parsed.detail ? { detail: parsed.detail } : {}),
    };
  } catch {
    return null;
  }
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connecting":
      return "正在连接";
    case "open":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "forbidden":
      return "无权限";
    case "closed":
      return "已断开";
    case "error":
      return "连接失败";
    default:
      return "未连接";
  }
}

export function LiveLogDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<GatewayLogEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [errorText, setErrorText] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showHttp, setShowHttp] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newSincePause, setNewSincePause] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<GatewayLogEntry[]>([]);
  const reconnectAttemptRef = useRef(0);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const openRef = useRef(open);
  autoScrollRef.current = autoScroll;
  openRef.current = open;

  const appendPending = useCallback((incoming: GatewayLogEntry[]) => {
    if (incoming.length === 0) {
      return;
    }
    const pending = pendingRef.current;
    pending.push(...incoming);
    if (pending.length > MAX_CLIENT_ENTRIES) {
      pending.splice(0, pending.length - MAX_CLIENT_ENTRIES);
    }
  }, []);

  const flushPending = useCallback(() => {
    if (pendingRef.current.length === 0) {
      return;
    }
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setEntries((current) => {
      const next = current.concat(incoming);
      return next.length > MAX_CLIENT_ENTRIES ? next.slice(next.length - MAX_CLIENT_ENTRIES) : next;
    });
    if (!autoScrollRef.current) {
      setNewSincePause((count) => count + incoming.length);
    }
  }, []);

  const scheduleReconnect = useCallback((reason: string) => {
    if (!openRef.current) {
      return;
    }
    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setConnection("closed");
      setErrorText(reason || "实时日志连接已断开，请点击重试。");
      return;
    }
    reconnectAttemptRef.current = attempt + 1;
    setConnection("reconnecting");
    setErrorText(reason);
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (openRef.current) {
        void connect();
      }
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setErrorText("");
    setConnection(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");
    try {
      const response = await fetch("/_gateway/admin/logs/stream", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setConnection("forbidden");
          setErrorText(response.status === 401 ? "登录状态已失效，请重新登录。" : "仅管理员可以查看实时日志。");
          return;
        }
        throw new Error(`实时日志接口返回 HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("当前浏览器不支持流式日志。");
      }
      reconnectAttemptRef.current = 0;
      setConnection("open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.event === "snapshot") {
            try {
              const payload = JSON.parse(event.data) as { entries?: unknown };
              const list = Array.isArray(payload.entries) ? payload.entries : [];
              const restored = list
                .map((item) => parseLogEntry(JSON.stringify(item)))
                .filter((item): item is GatewayLogEntry => Boolean(item));
              pendingRef.current = [];
              setEntries(restored.slice(-MAX_CLIENT_ENTRIES));
            } catch {
              // 快照解析失败时忽略，等待后续增量日志。
            }
          } else if (event.event === "log") {
            const entry = parseLogEntry(event.data);
            if (entry) {
              appendPending([entry]);
            }
          }
        }
      }
      if (!controller.signal.aborted) {
        scheduleReconnect("实时日志连接已断开。");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }, [appendPending, scheduleReconnect]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reconnectAttemptRef.current = 0;
    pendingRef.current = [];
    setEntries([]);
    setExpanded(new Set());
    setErrorText("");
    setLevelFilter("all");
    setScopeFilter("all");
    setSearch("");
    setShowHttp(false);
    setAutoScroll(true);
    setNewSincePause(0);
    setCopied(false);
    void connect();
    flushTimerRef.current = window.setInterval(flushPending, FLUSH_INTERVAL_MS);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      abortRef.current?.abort();
      abortRef.current = null;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (flushTimerRef.current !== null) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = [];
      previousFocusRef.current?.focus?.();
    };
  }, [connect, flushPending, open]);

  useEffect(() => {
    if (!open || !autoScroll) {
      return;
    }
    window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) {
        list.scrollTop = list.scrollHeight;
      }
    });
  }, [autoScroll, entries, open]);

  const scopes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
      .map(([scope, count]) => ({ scope, count }));
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (levelFilter !== "all" && entry.level !== levelFilter) {
        return false;
      }
      if (!showHttp && scopeTone(entry.scope) === "http") {
        return false;
      }
      if (scopeFilter !== "all" && entry.scope !== scopeFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return (
        entry.message.toLowerCase().includes(keyword) ||
        entry.scope.toLowerCase().includes(keyword) ||
        (entry.detail ?? "").toLowerCase().includes(keyword)
      );
    });
  }, [entries, levelFilter, scopeFilter, search, showHttp]);

  const handleScroll = useCallback(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom <= AUTO_SCROLL_THRESHOLD_PX) {
      if (!autoScrollRef.current) {
        setAutoScroll(true);
        setNewSincePause(0);
      }
    } else if (autoScrollRef.current) {
      setAutoScroll(false);
    }
  }, []);

  const toggleExpand = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const copyVisibleLogs = useCallback(async () => {
    const text = filteredEntries
      .map((entry) => `[${formatLogTime(entry.time)}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`)
      .join("\n");
    if (!text) {
      return;
    }
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [filteredEntries]);

  const clearLogs = useCallback(() => {
    pendingRef.current = [];
    setEntries([]);
    setExpanded(new Set());
    setNewSincePause(0);
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((current) => {
      if (!current) {
        setNewSincePause(0);
        window.requestAnimationFrame(() => {
          const list = listRef.current;
          if (list) {
            list.scrollTop = list.scrollHeight;
          }
        });
      }
      return !current;
    });
  }, []);

  const retryConnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    void connect();
  }, [connect]);

  if (!open) {
    return null;
  }

  return (
    <div className="live-log-layer">
      <button className="live-log-backdrop" type="button" aria-label="关闭实时日志" onClick={onClose} />
      <aside className="live-log-drawer" role="dialog" aria-modal="true" aria-label="实时日志">
        <header className="live-log-head">
          <div className="live-log-title">
            <Terminal size={16} />
            <strong>实时日志</strong>
            <span className={`live-log-conn is-${connection}`}>
              <i />
              {connectionLabel(connection)}
            </span>
          </div>
          <div className="live-log-head-actions">
            <button className="live-log-action" type="button" onClick={toggleAutoScroll} title={autoScroll ? "暂停自动滚动" : "恢复自动滚动"}>
              {autoScroll ? <Pause size={14} /> : <Play size={14} />}
              <span>{autoScroll ? "暂停滚动" : `继续滚动${newSincePause > 0 ? ` +${newSincePause}` : ""}`}</span>
            </button>
            <button className="live-log-action" type="button" onClick={() => void copyVisibleLogs()} title="复制当前筛选结果">
              <Copy size={14} />
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button className="live-log-action" type="button" onClick={clearLogs} title="清空当前面板日志">
              <Trash2 size={14} />
              <span>清空</span>
            </button>
            <button
              className="live-log-icon-button"
              type="button"
              onClick={retryConnect}
              title="重新连接"
              aria-label="重新连接"
              disabled={connection === "connecting"}
            >
              {connection === "connecting" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
            <button ref={closeButtonRef} className="live-log-icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭实时日志">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="live-log-toolbar">
          <div className="live-log-levels" role="group" aria-label="日志级别筛选">
            {(["all", "info", "warn", "error"] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={`live-log-level-chip ${levelFilter === level ? "is-active" : ""} level-${level}`}
                onClick={() => setLevelFilter(level)}
              >
                {level === "all" ? "全部" : LEVEL_LABELS[level]}
              </button>
            ))}
          </div>
          <select
            className="live-log-select"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
            aria-label="按模块筛选"
          >
            <option value="all">所有模块</option>
            {scopes.map((item) => (
              <option key={item.scope} value={item.scope}>
                {item.scope}（{item.count}）
              </option>
            ))}
          </select>
          <input
            className="live-log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索日志…"
            aria-label="搜索日志"
          />
          <label className="live-log-http-toggle" title="默认隐藏网络请求耗时日志">
            <input type="checkbox" checked={showHttp} onChange={(event) => setShowHttp(event.target.checked)} />
            <span>HTTP 耗时</span>
          </label>
        </div>

        {errorText ? (
          <div className="live-log-banner" role="status">
            {errorText}
          </div>
        ) : null}

        <div className="live-log-list" ref={listRef} onScroll={handleScroll}>
          {filteredEntries.length === 0 ? (
            <div className="live-log-empty">
              <Terminal size={22} />
              <strong>{entries.length === 0 ? "正在等待日志" : "当前筛选没有匹配的日志"}</strong>
              <span>{entries.length === 0 ? "触发一次请求或企业微信消息后，这里会实时出现日志。" : "调整级别、模块或清空搜索关键字再试。"}</span>
            </div>
          ) : (
            filteredEntries.map((entry) => {
              const isOpen = expanded.has(entry.id);
              return (
                <div
                  className={`live-log-row level-${entry.level} ${entry.detail ? "is-expandable" : ""} ${isOpen ? "is-open" : ""}`}
                  key={entry.id}
                  onClick={() => entry.detail && toggleExpand(entry.id)}
                >
                  <span className="live-log-time">{formatLogTime(entry.time)}</span>
                  <span className={`live-log-level level-${entry.level}`}>{LEVEL_LABELS[entry.level]}</span>
                  <span className={`live-log-scope tone-${scopeTone(entry.scope)}`}>{entry.scope}</span>
                  <span className="live-log-message">{entry.message}</span>
                  {entry.detail ? (
                    isOpen ? (
                      <pre className="live-log-detail">{entry.detail}</pre>
                    ) : (
                      <ChevronDown className="live-log-chevron" size={13} aria-hidden="true" />
                    )
                  ) : null}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        <footer className="live-log-foot">
          <span>共 {entries.length} 条 · 当前显示 {filteredEntries.length} 条</span>
          <span>仅当前进程内存，重启清空</span>
        </footer>
      </aside>
    </div>
  );
}
