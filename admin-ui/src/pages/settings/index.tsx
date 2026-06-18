import { Loader2, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, ProfileSummary } from "@/shared/types";
import type { BusyAction, SettingDraft } from "@/shared/lib/app-types";
import { errorMessage } from "@/shared/lib/app-utils";
import { formatJson } from "@/shared/lib/format";
import { autoSwitchEligibility, getPlanType, isCodexActiveProfile, profileHealth, profileLabel } from "@/shared/lib/profiles";
import { DatabaseUsersPanel } from "./components/DatabaseUsersPanel";
import type { UserRole } from "@/routes/routes";

function createSettingsDraft(config: AdminConfig): SettingDraft {
  return {
    defaultModel: config.settings.defaultModel,
    proxyEnabled: config.settings.networkProxy.enabled,
    proxyUrl: config.settings.networkProxy.url,
    proxyNoProxy: config.settings.networkProxy.noProxy || "localhost,127.0.0.1,::1",
    autoSwitchEnabled: config.settings.autoSwitch.enabled,
    autoSwitchExcludedProfileIds: config.settings.autoSwitch.excludedProfileIds || [],
    quotaSyncConcurrency: String(config.settings.runtime?.quotaSyncConcurrency || 3),
    freeAccountWebGenerationEnabled: Boolean(config.settings.image?.freeAccountWebGenerationEnabled),
    wecomEnabled: Boolean(config.settings.wecom?.enabled),
    wecomCorpId: config.settings.wecom?.corpId || "",
    wecomAgentId: config.settings.wecom?.agentId || "",
    wecomSecret: config.settings.wecom?.secret || "",
    serverPort: String(config.settings.server.port || 8787),
  };
}

function profileSearchText(profile: ProfileSummary): string {
  return [profileLabel(profile, true), profile.email || "", profile.accountId, profile.codexAccountId || "", profile.profileId, getPlanType(profile)].join(" ").toLowerCase();
}

export function SettingsPage(props: {
  showEmails: boolean;
  setShowEmails: Dispatch<SetStateAction<boolean>>;
  currentUser: string | null;
  role: UserRole;
  config: AdminConfig | null;
  busy: BusyAction;
  status: string;
  setBusy: Dispatch<SetStateAction<BusyAction>>;
  setConfig: Dispatch<SetStateAction<AdminConfig | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  refreshConfig: (options?: { runtime?: boolean; silent?: boolean }) => Promise<AdminConfig>;
}) {
  const [settingsDraft, setSettingsDraft] = useState<SettingDraft>({
    defaultModel: "",
    proxyEnabled: false,
    proxyUrl: "",
    proxyNoProxy: "localhost,127.0.0.1,::1",
    autoSwitchEnabled: false,
    autoSwitchExcludedProfileIds: [],
    quotaSyncConcurrency: "3",
    freeAccountWebGenerationEnabled: false,
    wecomEnabled: false,
    wecomCorpId: "",
    wecomAgentId: "",
    wecomSecret: "",
    serverPort: "8787",
  });
  const [settingsDirtyFields, setSettingsDirtyFields] = useState<Set<keyof SettingDraft>>(() => new Set());
  const [autoSwitchSearch, setAutoSwitchSearch] = useState("");
  const settingsDirty = settingsDirtyFields.size > 0;

  useEffect(() => {
    if (!props.config || settingsDirty) {
      return;
    }
    setSettingsDraft(createSettingsDraft(props.config));
  }, [props.config, settingsDirty]);

  function markSettingsDirty(next: Partial<SettingDraft>) {
    setSettingsDraft((draft) => ({ ...draft, ...next }));
    setSettingsDirtyFields((current) => {
      const updated = new Set(current);
      for (const key of Object.keys(next) as Array<keyof SettingDraft>) {
        updated.add(key);
      }
      return updated;
    });
  }

  function toggleAutoSwitchExcludedProfile(profileId: string, excluded: boolean) {
    const nextSet = new Set(settingsDraft.autoSwitchExcludedProfileIds);
    if (excluded) {
      nextSet.add(profileId);
    } else {
      nextSet.delete(profileId);
    }
    markSettingsDirty({ autoSwitchExcludedProfileIds: Array.from(nextSet) });
  }

  const excludedProfileIds = useMemo(() => new Set(settingsDraft.autoSwitchExcludedProfileIds), [settingsDraft.autoSwitchExcludedProfileIds]);
  const autoSwitchProfiles = useMemo(() => {
    const query = autoSwitchSearch.trim().toLowerCase();
    return (props.config?.profiles || []).filter((profile) => !query || profileSearchText(profile).includes(query));
  }, [autoSwitchSearch, props.config?.profiles]);
  const autoSwitchTotalCount = props.config?.profiles.length || 0;
  const autoSwitchExcludedCount = (props.config?.profiles || []).filter((profile) => excludedProfileIds.has(profile.profileId)).length;
  const autoSwitchRuntimeReadyCount = (props.config?.profiles || []).filter(
    (profile) => !excludedProfileIds.has(profile.profileId) && autoSwitchEligibility(profile).key === "ready",
  ).length;
  const autoSwitchBlockedCount = Math.max(0, autoSwitchTotalCount - autoSwitchExcludedCount - autoSwitchRuntimeReadyCount);

  async function saveSettings(options?: { restart?: boolean }) {
    const hasDirtyField = (...fields: Array<keyof SettingDraft>) => fields.some((field) => settingsDirtyFields.has(field));
    const serverPort = Number.parseInt(settingsDraft.serverPort, 10);
    if (hasDirtyField("serverPort") && (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535)) {
      props.setStatus("端口必须是 1 到 65535 之间的整数。");
      return;
    }
    const quotaSyncConcurrency = Number.parseInt(settingsDraft.quotaSyncConcurrency, 10);
    if (hasDirtyField("quotaSyncConcurrency") && (!Number.isInteger(quotaSyncConcurrency) || quotaSyncConcurrency < 1 || quotaSyncConcurrency > 32)) {
      props.setStatus("全局额度刷新并发数必须是 1 到 32 之间的整数。");
      return;
    }

    const payload: {
      defaultModel?: string;
      networkProxy?: { enabled: boolean; url: string; noProxy: string };
      autoSwitch?: { enabled?: boolean; excludedProfileIds?: string[] };
      runtime?: { quotaSyncConcurrency: number };
      image?: { freeAccountWebGenerationEnabled: boolean };
      wecom?: { enabled?: boolean; corpId?: string; agentId?: string; secret?: string };
      server?: { port: number };
    } = {};

    if (hasDirtyField("defaultModel")) {
      payload.defaultModel = settingsDraft.defaultModel;
    }
    if (hasDirtyField("proxyEnabled", "proxyUrl", "proxyNoProxy")) {
      payload.networkProxy = {
        enabled: settingsDraft.proxyEnabled,
        url: settingsDraft.proxyUrl,
        noProxy: settingsDraft.proxyNoProxy,
      };
    }
    if (hasDirtyField("autoSwitchEnabled", "autoSwitchExcludedProfileIds")) {
      payload.autoSwitch = {};
      if (hasDirtyField("autoSwitchEnabled")) {
        payload.autoSwitch.enabled = settingsDraft.autoSwitchEnabled;
      }
      if (hasDirtyField("autoSwitchExcludedProfileIds")) {
        payload.autoSwitch.excludedProfileIds = settingsDraft.autoSwitchExcludedProfileIds;
      }
    }
    if (hasDirtyField("quotaSyncConcurrency")) {
      payload.runtime = {
        quotaSyncConcurrency,
      };
    }
    if (hasDirtyField("freeAccountWebGenerationEnabled")) {
      payload.image = {
        freeAccountWebGenerationEnabled: settingsDraft.freeAccountWebGenerationEnabled,
      };
    }
    if (hasDirtyField("wecomEnabled", "wecomCorpId", "wecomAgentId", "wecomSecret")) {
      payload.wecom = {
        enabled: settingsDraft.wecomEnabled,
        ...(hasDirtyField("wecomCorpId") ? { corpId: settingsDraft.wecomCorpId } : {}),
        ...(hasDirtyField("wecomAgentId") ? { agentId: settingsDraft.wecomAgentId } : {}),
        ...(hasDirtyField("wecomSecret") ? { secret: settingsDraft.wecomSecret } : {}),
      };
    }
    if (hasDirtyField("serverPort")) {
      payload.server = {
        port: serverPort,
      };
    }

    const busyAction: BusyAction = options?.restart ? "restart" : "settings";
    props.setBusy(busyAction);
    try {
      const next = await fetchJson<AdminConfig>("/_gateway/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: formatJson(payload),
      });
      props.setConfig(next);
      setSettingsDirtyFields(new Set());
      if (options?.restart) {
        props.setStatus("设置已保存，正在重启本地网关...");
        await fetchJson<{ ok: boolean; restarting?: boolean }>("/_gateway/admin/restart", { method: "POST" });
        props.setStatus("本地网关正在重启，页面会自动恢复。");
      } else {
        props.setStatus("设置已保存。");
      }
    } catch (error) {
      props.setStatus(errorMessage(error));
    } finally {
      props.setBusy(null);
    }
  }

  async function testProxy() {
    props.setBusy("proxy");
    try {
      const result = await fetchJson<{ status: number; elapsedMs: number }>("/_gateway/admin/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: formatJson({
          networkProxy: {
            enabled: settingsDraft.proxyEnabled,
            url: settingsDraft.proxyUrl,
            noProxy: settingsDraft.proxyNoProxy,
          },
        }),
      });
      props.setStatus(`代理测试通过: HTTP ${result.status}，耗时 ${result.elapsedMs} ms。`);
    } catch (error) {
      props.setStatus(`代理测试失败: ${errorMessage(error)}`);
    } finally {
      props.setBusy(null);
    }
  }

  async function refreshModels() {
    props.setBusy("models");
    try {
      const result = await fetchJson<{
        catalog?: { modelCount?: number; source?: string; fetchedAt?: string };
      }>("/_gateway/models/refresh", { method: "POST" });
      await props.refreshConfig({ silent: true });
      const count = result.catalog?.modelCount ?? 0;
      props.setStatus(count > 0 ? `Codex 模型列表已从网络同步，共 ${count} 个。` : "Codex 模型列表已从网络同步。");
    } catch (error) {
      props.setStatus(errorMessage(error));
    } finally {
      props.setBusy(null);
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-page-head settings-page-head-actions-only">
        <div className="settings-page-actions">
          <button className="btn-secondary" type="button" onClick={refreshModels} disabled={props.busy === "models"}>
            {props.busy === "models" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            同步 Codex 模型
          </button>
        </div>
      </div>

      <div className="settings-grid">
        <section className="settings-section">
          <h4>模型</h4>
          <label className="field">
            <span>默认文本模型</span>
            <select className="control" value={settingsDraft.defaultModel} onChange={(event) => markSettingsDirty({ defaultModel: event.target.value })}>
              {(props.config?.models || []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">模型列表来源：{props.config?.modelCatalog.source || "-"}，共 {props.config?.modelCatalog.modelCount || 0} 个。</p>
        </section>

        <section className="settings-section wecom-section">
          <h4>企业微信登录</h4>
          <label className="switch-line">
            <input type="checkbox" checked={settingsDraft.wecomEnabled} onChange={(event) => markSettingsDirty({ wecomEnabled: event.target.checked })} />
            <span>启用企业微信扫码登录</span>
          </label>
          <label className="field">
            <span>企业 ID</span>
            <input className="input" value={settingsDraft.wecomCorpId} onChange={(event) => markSettingsDirty({ wecomCorpId: event.target.value })} placeholder="wwxxxxxxxxxxxxxxxx" />
          </label>
          <label className="field">
            <span>AgentID</span>
            <input className="input" value={settingsDraft.wecomAgentId} onChange={(event) => markSettingsDirty({ wecomAgentId: event.target.value })} placeholder="1000002" />
          </label>
          <label className="field">
            <span>Secret</span>
            <input className="input" type="password" value={settingsDraft.wecomSecret} onChange={(event) => markSettingsDirty({ wecomSecret: event.target.value })} placeholder="企业微信应用 Secret" />
          </label>
          <p className="hint">扫码成功后会按企业微信 UserId 自动创建普通用户，用户名格式为 wxwork:UserId。</p>
        </section>

        <section className="settings-section">
          <h4>上游代理</h4>
          <label className="switch-line">
            <input type="checkbox" checked={settingsDraft.proxyEnabled} onChange={(event) => markSettingsDirty({ proxyEnabled: event.target.checked })} />
            <span>启用 OAuth、模型刷新和接口转发代理</span>
          </label>
          <label className="field">
            <span>代理地址</span>
            <input className="input" value={settingsDraft.proxyUrl} onChange={(event) => markSettingsDirty({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" />
          </label>
          <label className="field">
            <span>No Proxy</span>
            <input className="input" value={settingsDraft.proxyNoProxy} onChange={(event) => markSettingsDirty({ proxyNoProxy: event.target.value })} />
          </label>
          <button className="btn-secondary" type="button" onClick={testProxy} disabled={props.busy === "proxy"}>
            测试代理
          </button>
        </section>

        <section className="settings-section">
          <h4>端口</h4>
          <label className="field">
            <span>网关端口</span>
            <input className="input" inputMode="numeric" type="number" min={1} max={65535} value={settingsDraft.serverPort} onChange={(event) => markSettingsDirty({ serverPort: event.target.value })} />
          </label>
          <p className="hint">修改后重启本地网关生效，桌面窗口不会退出。若端口被占用，启动时会自动顺延到下一个可用端口。</p>
        </section>

        <section className="settings-section">
          <h4>账号运行策略</h4>
          <label className="switch-line">
            <input type="checkbox" checked={settingsDraft.autoSwitchEnabled} onChange={(event) => markSettingsDirty({ autoSwitchEnabled: event.target.checked })} />
            <span>当前 API 账号额度耗尽后自动切换到下一个仍有额度的账号</span>
          </label>
          <label className="field">
            <span>全局额度刷新并发数</span>
            <input
              className="input"
              inputMode="numeric"
              max={32}
              min={1}
              type="number"
              value={settingsDraft.quotaSyncConcurrency}
              onChange={(event) => markSettingsDirty({ quotaSyncConcurrency: event.target.value })}
            />
          </label>
          <p className="hint">手动刷新全部账号额度时使用，默认 3。账号很多可以调高，遇到限流或失败增多时调低。</p>
          <p className="hint">{props.status}</p>
        </section>

        <section className="settings-section auto-switch-exclusion-section">
          <div className="auto-switch-exclusion-head">
            <div>
              <h4>不参与自动轮换名单</h4>
              <p className="hint">勾选表示手动排除。登录不可用或额度耗尽的账号即使未勾选，也不会被实际自动轮换选中。</p>
            </div>
            <div className="auto-switch-counts" aria-label="自动轮换账号统计">
              <span className="count-pill is-included">可轮换 {autoSwitchRuntimeReadyCount} 个</span>
              <span className="count-pill is-blocked">不可用 {autoSwitchBlockedCount} 个</span>
              <span className="count-pill is-excluded">手动排除 {autoSwitchExcludedCount} 个</span>
            </div>
          </div>

          <label className="auto-switch-search">
            <Search size={16} />
            <input value={autoSwitchSearch} onChange={(event) => setAutoSwitchSearch(event.target.value)} placeholder="搜索邮箱、账号 ID 或 Profile ID" />
          </label>

          <div className="auto-switch-profile-list">
            {autoSwitchProfiles.length === 0 ? (
              <div className="auto-switch-empty">还没有匹配的账号。</div>
            ) : (
              autoSwitchProfiles.map((profile) => {
                const excluded = excludedProfileIds.has(profile.profileId);
                const eligibility = autoSwitchEligibility(profile);
                const health = profileHealth(profile);
                const codexActive = isCodexActiveProfile(profile, props.config?.codex.accountId);
                const disabledReason = eligibility.key === "ready" ? "" : eligibility.label;
                const stateClass = excluded ? "is-excluded" : eligibility.key === "ready" ? "is-included" : "is-blocked";
                const stateLabel = excluded ? "手动排除" : eligibility.label;
                return (
                  <label className={`auto-switch-profile-row ${excluded ? "is-excluded" : ""}`} key={profile.profileId}>
                    <input type="checkbox" checked={excluded} onChange={(event) => toggleAutoSwitchExcludedProfile(profile.profileId, event.target.checked)} />
                    <span className="auto-switch-profile-main">
                      <strong>{profileLabel(profile, props.showEmails)}</strong>
                      <span>
                        {getPlanType(profile)} · {health.label}
                        {profile.isActive ? " · 当前 API 使用中" : ""}
                        {codexActive ? " · Codex 使用中" : ""}
                        {disabledReason ? ` · ${disabledReason}` : ""}
                      </span>
                    </span>
                    <span className={`auto-switch-state-pill ${stateClass}`}>{stateLabel}</span>
                  </label>
                );
              })
            )}
          </div>
        </section>

        <section className="settings-section">
          <h4>显示</h4>
          <label className="switch-line">
            <input type="checkbox" checked={props.showEmails} onChange={(event) => props.setShowEmails(event.target.checked)} />
            <span>脱敏模式</span>
          </label>
          <p className="hint">开启后账号邮箱将以脱敏形式展示。</p>
        </section>

        {props.role === "admin" ? <DatabaseUsersPanel currentUser={props.currentUser} setStatus={props.setStatus} /> : null}
      </div>

      <div className="settings-page-actions settings-page-footer-actions">
        <button className="btn-secondary" type="button" onClick={() => void saveSettings()} disabled={props.busy === "settings" || props.busy === "restart" || !settingsDirty}>
          保存设置
        </button>
        <button className="btn-primary" type="button" onClick={() => void saveSettings({ restart: true })} disabled={props.busy === "settings" || props.busy === "restart" || !settingsDirty || !props.config?.restartSupported}>
          保存并重启网关
        </button>
      </div>
    </section>
  );
}
