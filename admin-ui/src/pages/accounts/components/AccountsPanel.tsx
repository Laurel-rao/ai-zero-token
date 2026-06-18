import { Code2, Globe2, Info, Loader2, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import type { AdminConfig, ProfileSummary } from "@/shared/types";
import {
  authStatusText,
  getPlanKey,
  getPlanType,
  imageCapability,
  isAuthInvalid,
  isCodexActiveProfile,
  primaryUsage,
  profileHealth,
  profileInitial,
  profileLabel,
  quotaBarTone,
  resetLabel,
  resetTime,
  secondaryUsage,
  usageCorner,
} from "@/shared/lib/profiles";
import type { AccountStatItem, BusyAction, ProfileFilter } from "@/shared/lib/app-types";
import { InfoRow } from "@/shared/components/InfoRow";
import { formatFullTime } from "@/shared/lib/format";

type ProfileAction = "activate" | "apply-codex" | "sync-quota" | "remove" | "export";

export function AccountsPanel(props: {
  config: AdminConfig | null;
  profiles: ProfileSummary[];
  accountStats: AccountStatItem[];
  showEmails: boolean;
  filter: ProfileFilter;
  selectedProfiles: Record<string, boolean>;
  detailProfileId: string | null;
  selectedCount: number;
  visibleCount: number;
  busy: BusyAction;
  onFilter: (filter: ProfileFilter) => void;
  onSelect: (profileId: string, checked: boolean) => void;
  onSelectVisible: () => void;
  onClearSelected: () => void;
  onOpenDetail: (profileId: string) => void;
  onAction: (action: ProfileAction, profile: ProfileSummary) => void;
  onLocate: () => void;
  onEditImageLimits: () => void;
  onExportSelected: () => void;
  onRemoveSelected: () => void;
  onAddAccount: () => void;
  onRefreshStatus: () => void;
  onClearAccounts: () => void;
}) {
  const codexAccountId = props.config?.codex?.accountId;
  const detailProfile = props.profiles.find((profile) => profile.profileId === props.detailProfileId) ?? null;

  return (
    <section className="card accounts-card" id="accounts">
      <div className="section-head">
        <div>
          <h2>账号管理</h2>
          <p>表格展示账号池，点击账号行查看详情和操作。</p>
        </div>
        <div className="section-actions">
          <button className="btn-secondary" type="button" onClick={props.onLocate}>
            定位当前账号
          </button>
          <button className="btn-secondary" type="button" onClick={props.onEditImageLimits}>
            <SlidersHorizontal size={16} />
            编辑生图限额
          </button>
          <button className="btn-secondary" type="button" onClick={props.onExportSelected}>
            导出所选
          </button>
          <button className="btn-secondary" type="button" onClick={props.onSelectVisible} disabled={props.visibleCount === 0}>
            全选筛选结果
          </button>
          <button className="btn-secondary" type="button" onClick={props.onClearSelected} disabled={props.selectedCount === 0}>
            取消选择
          </button>
          <button className="btn-danger" type="button" onClick={props.onRemoveSelected} disabled={props.selectedCount === 0 || props.busy === "bulk-remove"}>
            删除所选
          </button>
          <button className="btn-primary" type="button" onClick={props.onAddAccount}>
            导入 ChatGPT Session
          </button>
          <button className="btn-secondary" type="button" onClick={props.onRefreshStatus}>
            刷新状态
          </button>
          <button className="btn-danger" type="button" onClick={props.onClearAccounts}>
            清空账号
          </button>
        </div>
      </div>

      <div className="account-stat-strip" aria-label="账号池统计">
        {props.accountStats.map((item) => (
          <button
            className={`account-stat-pill tone-${item.tone} ${props.filter.status === item.key ? "is-active" : ""}`}
            key={item.key}
            type="button"
            onClick={() => props.onFilter({ ...props.filter, status: item.key })}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </button>
        ))}
      </div>

      <div className="filter-row">
        <label className="search-box">
          <Search size={16} />
          <input value={props.filter.search} onChange={(event) => props.onFilter({ ...props.filter, search: event.target.value })} placeholder="搜索邮箱、账号 ID 或 Profile ID" />
        </label>
        <select className="control" value={props.filter.status} onChange={(event) => props.onFilter({ ...props.filter, status: event.target.value as ProfileFilter["status"] })}>
          <option value="all">全部状态</option>
          <option value="available">可用</option>
          <option value="unavailable">不可用</option>
          <option value="active">使用中</option>
          <option value="api-active">API 使用中</option>
          <option value="codex-active">Codex 使用中</option>
          <option value="healthy">健康</option>
          <option value="warning">即将耗尽</option>
          <option value="unknown">待请求验证</option>
          <option value="exhausted">额度耗尽</option>
          <option value="invalid">登录/认证异常</option>
          <option value="login-invalid">登录失效</option>
          <option value="auth-error">认证异常</option>
          <option value="expired">已过期</option>
          <option value="free">Free</option>
          <option value="plus">Plus</option>
          <option value="pro-team">Pro/Team</option>
          <option value="auto-included">配置参与</option>
          <option value="auto-excluded">手动排除</option>
        </select>
        <select className="control" value={props.filter.sort} onChange={(event) => props.onFilter({ ...props.filter, sort: event.target.value as ProfileFilter["sort"] })}>
          <option value="quota-desc">默认排序</option>
          <option value="latency-asc">按额度更新时间</option>
          <option value="expiry-asc">按过期时间</option>
          <option value="name-asc">按名称排序</option>
          <option value="quota-asc">按剩余额度升序</option>
          <option value="plan-desc">按套餐排序</option>
          <option value="email-asc">按邮箱排序</option>
        </select>
        <span className="account-selected-count">已选择 {props.selectedCount} 个</span>
      </div>

      <div className="accounts-table-wrap">
        {props.profiles.length === 0 ? (
          <div className="empty-state">还没有匹配的账号。可以导入 ChatGPT session JSON 或调整筛选条件。</div>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th className="select-col">选择</th>
                <th>账号</th>
                <th>状态</th>
                <th>额度</th>
                <th>使用中</th>
                <th>重置时间</th>
                <th>生图</th>
                <th className="action-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {props.profiles.map((profile) => {
                const row = buildProfileRowState(profile, props, codexAccountId);
                return (
                  <tr
                    className={`${props.detailProfileId === profile.profileId ? "is-selected" : ""} ${row.authInvalid ? "is-auth-invalid" : ""}`}
                    data-profile-row={profile.profileId}
                    key={profile.profileId}
                    onClick={() => props.onOpenDetail(profile.profileId)}
                  >
                    <td className="select-col" onClick={(event) => event.stopPropagation()}>
                      <input
                        aria-label={`选择 ${row.label}`}
                        checked={Boolean(props.selectedProfiles[profile.profileId])}
                        onChange={(event) => props.onSelect(profile.profileId, event.target.checked)}
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <div className="account-cell">
                        <span className={`avatar plan-${getPlanKey(profile)}`}>{profileInitial(profile)}</span>
                        <div>
                          <strong>{row.label}</strong>
                          <span>{props.showEmails ? profile.profileId : maskProfileId(profile.profileId)}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="table-badge-stack">
                        <span className="badge brand">{getPlanType(profile)}</span>
                        <span className={`badge ${row.health.tone}`}>{row.health.label}</span>
                      </div>
                    </td>
                    <td>
                      <div className="quota-mini-stack">
                        <QuotaMini label={resetLabel(profile, "primary")} value={row.primary} tone={quotaBarTone(row.primary)} />
                        <QuotaMini label={resetLabel(profile, "secondary")} value={row.secondary} tone={quotaBarTone(row.secondary)} />
                      </div>
                    </td>
                    <td>
                      <UsagePills apiActive={profile.isActive} codexActive={row.codexActive} />
                    </td>
                    <td>
                      <div className="reset-cell">
                        <span>{resetTime(profile, "primary")}</span>
                        <span>{resetTime(profile, "secondary")}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${row.imageAbility.ok ? "green" : "orange"}`}>gpt-image-2</span>
                    </td>
                    <td className="action-col" onClick={(event) => event.stopPropagation()}>
                      <button aria-label="刷新额度" className="account-icon-btn" disabled={row.isBusy} onClick={() => props.onAction("sync-quota", profile)} title="刷新额度" type="button">
                        {row.refreshBusy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                      </button>
                      <button className="btn-secondary compact-action" type="button" onClick={() => props.onOpenDetail(profile.profileId)}>
                        {props.detailProfileId === profile.profileId ? "收起" : "详情"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detailProfile ? <AccountDetailPanel profile={detailProfile} props={props} codexAccountId={codexAccountId} /> : null}
    </section>
  );
}

function AccountDetailPanel({ profile, props, codexAccountId }: { profile: ProfileSummary; props: Parameters<typeof AccountsPanel>[0]; codexAccountId?: string }) {
  const row = buildProfileRowState(profile, props, codexAccountId);
  const corner = usageCorner(profile, row.codexActive);
  const exportAudit = profile.exportAudit;
  const exportAuditLabel = exportAudit?.exported ? `已导出 ${exportAudit.count} 次` : "未导出";

  return (
    <section className={`account-detail-panel plan-${getPlanKey(profile)} ${row.authInvalid ? "is-auth-invalid" : ""}`}>
      {corner && (
        <span className={`usage-corner ${corner.className}`}>
          <span>{corner.label}</span>
        </span>
      )}
      <div className="account-detail-head">
        <div className="account-cell">
          <span className={`avatar plan-${getPlanKey(profile)}`}>{profileInitial(profile)}</span>
          <div>
            <strong>{row.label}</strong>
            <span>{authStatusText(profile)}</span>
          </div>
        </div>
        <div className="table-badge-stack is-inline">
          <span className="badge brand">{getPlanType(profile)}</span>
          <span className={`badge ${row.health.tone}`}>{row.health.label}</span>
          <span className={`badge ${row.imageAbility.ok ? "green" : "orange"}`}>gpt-image-2</span>
          <span className={`badge ${exportAudit?.exported ? "orange" : "muted"}`}>{exportAuditLabel}</span>
        </div>
      </div>

      <div className="account-detail-metrics">
        <QuotaBar label={resetLabel(profile, "primary")} value={row.primary} tone={quotaBarTone(row.primary)} />
        <QuotaBar label={resetLabel(profile, "secondary")} value={row.secondary} tone={quotaBarTone(row.secondary)} />
      </div>

      <div className="usage-status-row detail-usage-row">
        <span className={`usage-status ${profile.isActive ? "is-active" : ""}`}>
          <Globe2 size={14} />
          <span>API</span>
          <span className={`usage-dot ${profile.isActive ? "active" : ""}`} />
          <span className="usage-state-text">{profile.isActive ? "使用中" : "未使用"}</span>
        </span>
        <span className={`usage-status ${row.codexActive ? "is-active" : ""}`}>
          <Code2 size={14} />
          <span>Codex</span>
          <span className={`usage-dot ${row.codexActive ? "active" : ""}`} />
          <span className="usage-state-text">{row.codexActive ? "使用中" : "未使用"}</span>
        </span>
      </div>

      <div className="meta-grid">
        <InfoRow label="套餐" value={getPlanType(profile)} />
        <InfoRow label="Account ID" value={profile.accountId} code />
        <InfoRow label="Codex 应用" value={row.codexApplyUnsupported ? row.codexApplyReason : "可应用到本机 Codex"} />
        <InfoRow label="Profile ID" value={profile.profileId} code />
        <InfoRow label="认证状态" value={authStatusText(profile)} />
        <InfoRow label="生图能力" value={row.imageAbility.ok ? "gpt-image-2 可用" : row.imageAbility.detail} />
        <InfoRow label="导出记录" value={formatExportAudit(exportAudit)} />
        <InfoRow label="5 小时重置" value={resetTime(profile, "primary")} />
        <InfoRow label="7 天重置" value={resetTime(profile, "secondary")} />
        <InfoRow label="过期时间" value={profile.expiresAt ? new Date(profile.expiresAt).toLocaleString("zh-CN") : "-"} />
        <InfoRow label="额度快照" value={profile.quota?.capturedAt ? new Date(profile.quota.capturedAt).toLocaleString("zh-CN") : "-"} />
      </div>

      <div className="account-actions">
        <button className={`btn-secondary ${profile.isActive ? "is-current" : ""}`} type="button" onClick={() => props.onAction("activate", profile)} disabled={profile.isActive || row.isBusy || row.authInvalid}>
          {row.authInvalid ? "网关不可用" : profile.isActive ? "网关使用中" : "应用网关"}
        </button>
        <span className={`codex-action-wrap ${row.codexApplyUnsupported ? "is-unsupported" : ""}`} title={row.codexApplyUnsupported ? row.codexApplyReason : undefined}>
          <button className={`btn-secondary ${row.codexActive ? "is-current codex" : ""}`} type="button" onClick={() => props.onAction("apply-codex", profile)} disabled={row.codexButtonDisabled}>
            <span>{row.codexButtonLabel}</span>
            {row.codexApplyUnsupported && <Info className="codex-disabled-icon" size={13} aria-hidden="true" />}
          </button>
        </span>
        <button className="btn-secondary" type="button" onClick={() => props.onAction("export", profile)} disabled={row.isBusy}>
          导出
        </button>
        <button className="btn-danger" type="button" onClick={() => props.onAction("remove", profile)} disabled={row.isBusy}>
          删除
        </button>
      </div>
    </section>
  );
}

function buildProfileRowState(profile: ProfileSummary, props: Pick<Parameters<typeof AccountsPanel>[0], "busy" | "showEmails">, codexAccountId?: string) {
  const health = profileHealth(profile);
  const primary = primaryUsage(profile);
  const secondary = secondaryUsage(profile);
  const codexActive = isCodexActiveProfile(profile, codexAccountId);
  const authInvalid = isAuthInvalid(profile);
  const isBusy = typeof props.busy === "string" && props.busy.startsWith("profile:") && props.busy.endsWith(profile.profileId);
  const refreshBusy = props.busy === `profile:sync-quota:${profile.profileId}`;
  const codexApplyUnsupported = profile.codexApplySupported === false;
  const codexApplyReason = profile.codexApplyReason || "该账号缺少真实 chatgpt_account_id，不能应用到本机 Codex。";
  const codexButtonDisabled = codexActive || isBusy || authInvalid || codexApplyUnsupported;
  const codexButtonLabel = authInvalid ? "Codex 不可用" : codexActive ? "Codex 使用中" : codexApplyUnsupported ? "仅网关可用" : "应用 Codex";
  const imageAbility = imageCapability(profile);
  return {
    label: profileLabel(profile, props.showEmails),
    health,
    primary,
    secondary,
    codexActive,
    authInvalid,
    isBusy,
    refreshBusy,
    codexApplyUnsupported,
    codexApplyReason,
    codexButtonDisabled,
    codexButtonLabel,
    imageAbility,
  };
}

function maskProfileId(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 12)}...${value.slice(-6)}`;
}

function formatExportAudit(audit: ProfileSummary["exportAudit"]): string {
  if (!audit?.exported) {
    return "未导出";
  }

  const kindLabel = audit.lastExportKind === "single" ? "单账号导出" : audit.lastExportKind === "batch" ? "批量导出" : "全部导出";
  return `${audit.count} 次，最近 ${formatFullTime(audit.lastExportedAt)}，方式 ${kindLabel}`;
}

function UsagePills(props: { apiActive: boolean; codexActive: boolean }) {
  return (
    <div className="usage-pill-stack">
      <span className={`usage-status ${props.apiActive ? "is-active" : ""}`}>
        <Globe2 size={14} />
        <span>API</span>
        <span className={`usage-dot ${props.apiActive ? "active" : ""}`} />
      </span>
      <span className={`usage-status ${props.codexActive ? "is-active" : ""}`}>
        <Code2 size={14} />
        <span>Codex</span>
        <span className={`usage-dot ${props.codexActive ? "active" : ""}`} />
      </span>
    </div>
  );
}

function QuotaMini(props: { label: string; value: number; tone: "blue" | "orange" | "red" }) {
  return (
    <div className="quota-mini">
      <div className="quota-mini-line">
        <span>{props.label}</span>
        <strong>{100 - props.value}%</strong>
      </div>
      <div className="progress-track">
        <div className={`progress-bar ${props.tone}`} style={{ width: `${props.value}%` }} />
      </div>
    </div>
  );
}

function QuotaBar(props: { label: string; value: number; tone: "blue" | "orange" | "red" }) {
  return (
    <div className="quota-row">
      <div className="quota-line">
        <span>{props.label} · 已用 {props.value}% / 剩余 {100 - props.value}%</span>
        <strong>剩余 {100 - props.value}%</strong>
      </div>
      <div className="progress-track">
        <div className={`progress-bar ${props.tone}`} style={{ width: `${props.value}%` }} />
      </div>
    </div>
  );
}
