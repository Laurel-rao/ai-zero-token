import { useEffect, useMemo, useState } from "react";
import { Copy, Filter, Search } from "lucide-react";
import type { AdminConfig, RequestLog } from "@/shared/types";
import { copyText } from "@/shared/lib/app-utils";
import { formatDuration, formatTime } from "@/shared/lib/format";
import { formatJson } from "@/shared/lib/format";
import type { UserRole } from "@/routes/routes";

export function RequestLogs(props: {
  logs: RequestLog[];
  config: AdminConfig | null;
  currentUser: string | null;
  role: UserRole;
  dataOwnerFilter: string;
  setDataOwnerFilter: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [customOwner, setCustomOwner] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (props.logs.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !props.logs.some((item) => item.id === selectedId)) {
      setSelectedId(props.logs[0].id);
    }
  }, [props.logs, selectedId]);

  const sources = useMemo(() => Array.from(new Set(props.logs.map((item) => item.source || "管理页"))), [props.logs]);
  const methods = useMemo(() => Array.from(new Set(props.logs.map((item) => item.method))), [props.logs]);
  const userOptions = useMemo(() => {
    const names = new Set<string>();
    if (props.currentUser) {
      names.add(props.currentUser);
    }
    for (const log of props.logs) {
      if (log.owner) {
        names.add(log.owner);
      }
    }
    return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-CN"));
  }, [props.currentUser, props.logs]);

  const filteredLogs = useMemo(() => {
    const search = query.trim().toLowerCase();
    return props.logs.filter((item) => {
      const haystack = [item.time, item.method, item.endpoint, item.model, item.statusCode, item.durationMs, item.source].join(" ").toLowerCase();
      if (search && !haystack.includes(search)) return false;
      if (methodFilter !== "all" && item.method !== methodFilter) return false;
      if (sourceFilter !== "all" && (item.source || "管理页") !== sourceFilter) return false;
      if (statusFilter === "ok" && item.statusCode >= 400) return false;
      if (statusFilter === "error" && item.statusCode < 400) return false;
      return true;
    });
  }, [methodFilter, props.logs, query, sourceFilter, statusFilter]);

  const selectedLog = filteredLogs.find((item) => item.id === selectedId) || filteredLogs[0] || null;

  function copySelectedLog() {
    if (!selectedLog) return;
    const { account: _account, ...safeLog } = selectedLog;
    copyText(formatJson(safeLog))
      .then((ok) => {
        if (!ok) return;
      })
      .catch(() => undefined);
  }

  return (
    <section className="log-table-wrap" id="logs">
      <div className="section-head compact">
        <div>
          <h2>请求日志</h2>
          <p>记录网关最近收到的 API 请求，详情为安全摘要。</p>
        </div>
      </div>
      <div className="log-toolbar">
        <label className="search-box log-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索时间、接口、模型或状态" />
        </label>
        <label className="filter-chip">
          <Filter size={14} />
          <select value={methodFilter} onChange={(event) => setMethodFilter(event.target.value)}>
            <option value="all">全部方法</option>
            {methods.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-chip">
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
            <option value="all">全部来源</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-chip">
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
          </select>
        </label>
        {props.role === "admin" ? (
          <>
            <label className="filter-chip">
              <select value={props.dataOwnerFilter} onChange={(event) => props.setDataOwnerFilter(event.target.value)}>
                <option value="">我的数据</option>
                <option value="all">全部用户</option>
                {userOptions.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner === props.currentUser ? `${owner}（我）` : owner}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-chip log-owner-input">
              <input
                value={customOwner}
                onChange={(event) => setCustomOwner(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    props.setDataOwnerFilter(customOwner.trim());
                  }
                }}
                placeholder="输入用户名筛选"
              />
              <button type="button" onClick={() => props.setDataOwnerFilter(customOwner.trim())}>
                查看
              </button>
            </label>
          </>
        ) : null}
      </div>
      <div className="table-scroller">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>方法</th>
              <th>接口</th>
              {props.role === "admin" ? <th>用户</th> : null}
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={props.role === "admin" ? 8 : 7}>最近 API 请求会在这里显示。</td>
              </tr>
            ) : (
              filteredLogs.map((item) => (
                <tr key={item.id} className={item.id === selectedLog?.id ? "is-selected" : ""} onClick={() => setSelectedId(item.id)}>
                  <td>{formatTime(item.time)}</td>
                  <td>
                    <span className={`method-pill method-${item.method.toLowerCase()}`}>{item.method}</span>
                  </td>
                  <td>
                    <code>{item.endpoint}</code>
                  </td>
                  {props.role === "admin" ? <td>{item.owner || "-"}</td> : null}
                  <td>{item.model}</td>
                  <td>
                    <span className={`status-pill ${item.statusCode >= 400 ? "is-error" : "is-ok"}`}>{item.statusCode}</span>
                  </td>
                  <td>{formatDuration(item.durationMs)}</td>
                  <td>{item.source || "管理页"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="table-footer">当前展示 {filteredLogs.length} 条请求记录，最近总计 {props.logs.length} 条。</div>
      {selectedLog && (
        <div className="log-detail-panel">
          <div className="log-detail-head">
            <div>
              <h3>日志详情</h3>
              <p>{formatTime(selectedLog.time)} · {selectedLog.method} {selectedLog.endpoint}</p>
            </div>
            <button className="btn-secondary" type="button" onClick={copySelectedLog}>
              <Copy size={16} />
              复制详情
            </button>
          </div>
          <div className="log-detail-grid">
            <div className="log-detail-meta">
              {props.role === "admin" ? <div><span>用户</span><strong>{selectedLog.owner || "-"}</strong></div> : null}
              <div><span>模型</span><strong>{selectedLog.model}</strong></div>
              <div><span>状态</span><strong>{selectedLog.statusCode}</strong></div>
              <div><span>耗时</span><strong>{formatDuration(selectedLog.durationMs)}</strong></div>
              <div><span>来源</span><strong>{selectedLog.source || "管理页"}</strong></div>
            </div>
            <pre className="pre log-detail-pre">{formatJson(((log) => {
              const { account: _account, ...safeLog } = log;
              return safeLog;
            })(selectedLog))}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
