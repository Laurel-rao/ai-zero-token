import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Archive, BarChart3, Camera, Clock3, Database, DollarSign, Loader2, RefreshCw, Sigma, Zap } from "lucide-react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, UsageAggregate, UsageDimensionRow, UsageResetResult, UsageSummary } from "@/shared/types";
import { formatDuration, formatFullTime } from "@/shared/lib/format";
import { errorMessage } from "@/shared/lib/app-utils";
import { StatCard } from "@/shared/components/StatCard";

function emptyAggregate(): UsageAggregate {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheCreationCostUsd: 0,
    cacheReadCostUsd: 0,
    estimatedCostUsd: 0,
    unknownTokenCount: 0,
    unknownTokenStatusCounts: {},
    imageCount: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    p95DurationMs: 0,
    durationBuckets: {},
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value || 0));
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  }
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  }
  return formatNumber(value);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `$${value.toFixed(5)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function summarizeLabel(aggregate: UsageAggregate): string {
  return `${formatNumber(aggregate.successCount)} 成功 / ${formatNumber(aggregate.failureCount)} 失败`;
}

function cacheHitLabel(aggregate: UsageAggregate): string {
  const inputTokens = aggregate.inputTokens || 0;
  const cacheReadTokens = aggregate.cacheReadTokens || 0;
  if (inputTokens <= 0 || cacheReadTokens <= 0) {
    return "缓存命中 0%";
  }
  return `缓存命中 ${Math.min(100, (cacheReadTokens / inputTokens) * 100).toFixed(1)}%`;
}

function tokenUsageStatusLabel(status: string): string {
  if (status === "captured") return "已捕获用量";
  if (status === "missing_terminal") return "缺少终态事件";
  if (status === "terminal_without_usage") return "终态无 usage";
  if (status === "parse_failed") return "SSE 解析失败";
  if (status === "upstream_error") return "上游错误";
  return "未返回 usage";
}

function unknownTokenReasonLabel(aggregate: UsageAggregate): string {
  const entries = Object.entries(aggregate.unknownTokenStatusCounts ?? {})
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return `未返回用量 ${formatNumber(aggregate.unknownTokenCount)} 次`;
  }
  const [status, count] = entries[0] ?? ["not_returned", 0];
  return `未返回用量 ${formatNumber(aggregate.unknownTokenCount)} 次，主要原因：${tokenUsageStatusLabel(status)} ${formatNumber(count)} 次`;
}

function ScopeCard(props: { title: string; detail: string; aggregate?: UsageAggregate }) {
  const aggregate = props.aggregate ?? emptyAggregate();
  return (
    <article className="usage-scope-card">
      <div>
        <span>{props.title}</span>
        <strong>{formatTokens(aggregate.totalTokens)} 已知 token</strong>
        <p>{props.detail}</p>
      </div>
      <dl>
        <div>
          <dt>新输入</dt>
          <dd>{formatTokens(aggregate.uncachedInputTokens)}</dd>
        </div>
        <div>
          <dt>缓存读</dt>
          <dd>{formatTokens(aggregate.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>估算费用</dt>
          <dd>{formatUsd(aggregate.estimatedCostUsd)}</dd>
        </div>
        <div>
          <dt>平均</dt>
          <dd>{formatDuration(aggregate.averageDurationMs)}</dd>
        </div>
        <div>
          <dt>P95</dt>
          <dd>{formatDuration(aggregate.p95DurationMs)}</dd>
        </div>
      </dl>
      <p className="usage-scope-footer">{summarizeLabel(aggregate)} · {cacheHitLabel(aggregate)} · {unknownTokenReasonLabel(aggregate)}</p>
    </article>
  );
}

function DimensionTable(props: { title: string; rows: UsageDimensionRow[]; empty: string }) {
  return (
    <section className="usage-table-card">
      <div className="usage-table-head">
        <h3>{props.title}</h3>
        <span>{props.rows.length} 项</span>
      </div>
      {props.rows.length === 0 ? (
        <div className="usage-empty">{props.empty}</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>维度</th>
                <th>请求</th>
                <th>失败</th>
                <th>新输入</th>
                <th>缓存读</th>
                <th>估算费用</th>
                <th>已知 token</th>
                <th>未返回用量</th>
                <th>图片</th>
                <th>平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{formatNumber(row.aggregate.requestCount)}</td>
                  <td>{formatNumber(row.aggregate.failureCount)}</td>
                  <td>{formatTokens(row.aggregate.uncachedInputTokens)}</td>
                  <td>{formatTokens(row.aggregate.cacheReadTokens)}</td>
                  <td>{formatUsd(row.aggregate.estimatedCostUsd)}</td>
                  <td>{formatTokens(row.aggregate.totalTokens)}</td>
                  <td>{formatNumber(row.aggregate.unknownTokenCount)}</td>
                  <td>{formatNumber(row.aggregate.imageCount)}</td>
                  <td>{formatDuration(row.aggregate.averageDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DailyTable(props: { rows: UsageSummary["daily"] }) {
  return (
    <section className="usage-table-card usage-daily-card">
      <div className="usage-table-head">
        <h3>每日趋势</h3>
        <span>最近 {props.rows.length} 天</span>
      </div>
      {props.rows.length === 0 ? (
        <div className="usage-empty">还没有历史用量。</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>请求</th>
                <th>成功</th>
                <th>失败</th>
                <th>新输入</th>
                <th>缓存读</th>
                <th>估算费用</th>
                <th>已知输入</th>
                <th>已知输出</th>
                <th>已知总 token</th>
                <th>未返回用量</th>
                <th>图片</th>
                <th>P95</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>{formatNumber(row.aggregate.requestCount)}</td>
                  <td>{formatNumber(row.aggregate.successCount)}</td>
                  <td>{formatNumber(row.aggregate.failureCount)}</td>
                  <td>{formatTokens(row.aggregate.uncachedInputTokens)}</td>
                  <td>{formatTokens(row.aggregate.cacheReadTokens)}</td>
                  <td>{formatUsd(row.aggregate.estimatedCostUsd)}</td>
                  <td>{formatTokens(row.aggregate.inputTokens)}</td>
                  <td>{formatTokens(row.aggregate.outputTokens)}</td>
                  <td>{formatTokens(row.aggregate.totalTokens)}</td>
                  <td>{formatNumber(row.aggregate.unknownTokenCount)}</td>
                  <td>{formatNumber(row.aggregate.imageCount)}</td>
                  <td>{formatDuration(row.aggregate.p95DurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function UsagePage(props: {
  config: AdminConfig | null;
  setStatus: Dispatch<SetStateAction<string>>;
}) {
  const [usage, setUsage] = useState<UsageSummary | null>(props.config?.usage ?? null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    setUsage(props.config?.usage ?? null);
  }, [props.config?.usage]);

  async function refreshUsage() {
    setLoading(true);
    try {
      const next = await fetchJson<UsageSummary>("/_gateway/admin/usage");
      setUsage(next);
      props.setStatus("用量统计已刷新。");
    } catch (error) {
      props.setStatus(`用量统计刷新失败: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function backupAndResetUsage() {
    if (!window.confirm("会先备份当前统计目录，然后清空用量记录并从 0 重新统计。确认继续？")) {
      return;
    }
    setResetting(true);
    try {
      const result = await fetchJson<UsageResetResult>("/_gateway/admin/usage/reset", { method: "POST" });
      setUsage(result.usage);
      props.setStatus(`用量统计已备份并清空：${result.backupDir}`);
    } catch (error) {
      props.setStatus(`用量统计清空失败: ${errorMessage(error)}`);
    } finally {
      setResetting(false);
    }
  }

  const summary = usage;
  const lifetime = summary?.lifetime ?? emptyAggregate();
  const today = summary?.today ?? emptyAggregate();
  const startup = summary?.startup ?? emptyAggregate();
  const failureRate = useMemo(() => {
    if (lifetime.requestCount === 0) return "0%";
    return `${((lifetime.failureCount / lifetime.requestCount) * 100).toFixed(1)}%`;
  }, [lifetime.failureCount, lifetime.requestCount]);

  return (
    <section className="usage-page">
      <div className="usage-actions">
        <div>
          <span>统计文件</span>
          <code>{summary?.storageDir || "~/.ai-zero-token/.state/usage"}</code>
        </div>
        <div className="usage-action-buttons">
          <button className="btn-secondary" type="button" onClick={() => void refreshUsage()} disabled={loading || resetting}>
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新统计
          </button>
          <button className="btn-danger" type="button" onClick={() => void backupAndResetUsage()} disabled={loading || resetting}>
            {resetting ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
            备份并清空
          </button>
        </div>
      </div>

      <section className="summary-grid desktop-summary-grid usage-summary-grid">
        <StatCard icon={Sigma} label="历史已知 token" value={formatTokens(lifetime.totalTokens)} detail={`新输入 ${formatTokens(lifetime.uncachedInputTokens)}，缓存读 ${formatTokens(lifetime.cacheReadTokens)}`} tone="blue" />
        <StatCard icon={Zap} label="今日已知 token" value={formatTokens(today.totalTokens)} detail={`${summary?.todayDate || "今天"} · ${cacheHitLabel(today)}`} tone="green" />
        <StatCard icon={BarChart3} label="本次启动已知 token" value={formatTokens(startup.totalTokens)} detail={`缓存读 ${formatTokens(startup.cacheReadTokens)} · 启动于 ${formatFullTime(summary?.startedAt)}`} tone="brand" />
        <StatCard icon={DollarSign} label="今日估算费用" value={formatUsd(today.estimatedCostUsd)} detail={`输入 ${formatUsd(today.inputCostUsd + today.cacheCreationCostUsd + today.cacheReadCostUsd)}，输出 ${formatUsd(today.outputCostUsd)}`} tone="green" />
        <StatCard icon={Camera} label="图片张数" value={formatNumber(lifetime.imageCount)} detail="历史累计生成或编辑图片" tone="orange" />
        <StatCard icon={Clock3} label="历史 P95" value={formatDuration(lifetime.p95DurationMs)} detail={`平均 ${formatDuration(lifetime.averageDurationMs)}`} tone="orange" />
        <StatCard icon={Database} label="失败率" value={failureRate} detail={`${formatNumber(lifetime.failureCount)} 次失败`} tone={lifetime.failureCount > 0 ? "orange" : "green"} />
      </section>

      <section className="usage-scope-grid">
        <ScopeCard title="今日用量" detail="当天 00:00 到现在" aggregate={today} />
        <ScopeCard title="本次启动" detail="当前网关进程启动后到现在" aggregate={startup} />
        <ScopeCard title="历史累计" detail="从开始记录以来的全部累计" aggregate={lifetime} />
      </section>

      <DailyTable rows={summary?.daily ?? []} />

      <section className="usage-dimension-grid">
        <DimensionTable title="按账号" rows={summary?.byAccount ?? []} empty="还没有账号维度数据。" />
        <DimensionTable title="按模型" rows={summary?.byModel ?? []} empty="还没有模型维度数据。" />
        <DimensionTable title="按接口" rows={summary?.byEndpoint ?? []} empty="还没有接口维度数据。" />
        <DimensionTable title="按用量捕获状态" rows={summary?.byTokenUsageStatus ?? []} empty="还没有用量捕获状态数据。" />
        <DimensionTable title="按错误" rows={summary?.byError ?? []} empty="还没有错误记录。" />
        <DimensionTable title="按生图链路" rows={summary?.byImageRoute ?? []} empty="还没有生图链路数据。" />
        <DimensionTable title="按来源" rows={summary?.bySource ?? []} empty="还没有来源维度数据。" />
      </section>
    </section>
  );
}
