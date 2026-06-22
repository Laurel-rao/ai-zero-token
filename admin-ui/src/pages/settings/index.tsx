import {
  ChevronDown,
  Gauge,
  Globe2,
  ImageIcon,
  KeyRound,
  Layers3,
  Loader2,
  MonitorCog,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, ProfileSummary } from "@/shared/types";
import type { BusyAction, SettingDraft } from "@/shared/lib/app-types";
import { errorMessage } from "@/shared/lib/app-utils";
import { formatDuration, formatFullTime, formatJson } from "@/shared/lib/format";
import { autoSwitchEligibility, getPlanType, isCodexActiveProfile, profileHealth, profileLabel } from "@/shared/lib/profiles";
import type { UserRole } from "@/routes/routes";
import { normalizeBranding } from "@/shared/lib/branding";

function countToDraft(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function createSettingsDraft(config: AdminConfig): SettingDraft {
  const imageLimits = config.settings.image?.limits;
  const branding = normalizeBranding(config.settings.branding);
  return {
    defaultModel: config.settings.defaultModel,
    brandingTitle: branding.title,
    brandingAppIconUrl: branding.appIconUrl,
    brandingFaviconUrl: branding.faviconUrl,
    proxyEnabled: config.settings.networkProxy.enabled,
    proxyUrl: config.settings.networkProxy.url,
    proxyNoProxy: config.settings.networkProxy.noProxy || "localhost,127.0.0.1,::1",
    autoSwitchEnabled: config.settings.autoSwitch.enabled,
    accountRotationEnabled: Boolean(config.settings.accountRotation?.enabled),
    autoSwitchExcludedProfileIds: config.settings.autoSwitch.excludedProfileIds || [],
    quotaSyncConcurrency: String(config.settings.runtime?.quotaSyncConcurrency || 3),
    accountMaxConcurrency: String(config.settings.runtime?.accountMaxConcurrency || 2),
    freeAccountWebGenerationEnabled: Boolean(config.settings.image?.freeAccountWebGenerationEnabled),
    imageLimitsEnabled: Boolean(imageLimits?.enabled),
    imageLimitDaily: countToDraft(imageLimits?.perUserDaily),
    imageLimitHourly: countToDraft(imageLimits?.perUserHourly),
    imageLimitMinIntervalSeconds: countToDraft(imageLimits?.minIntervalSeconds),
    imageLimitUserOverrides: (imageLimits?.userOverrides || []).map((item) => ({
      username: item.username,
      perUserDaily: item.perUserDaily === undefined ? "" : String(item.perUserDaily),
      perUserHourly: item.perUserHourly === undefined ? "" : String(item.perUserHourly),
      minIntervalSeconds: item.minIntervalSeconds === undefined ? "" : String(item.minIntervalSeconds),
    })),
    wecomEnabled: Boolean(config.settings.wecom?.enabled),
    wecomCorpId: config.settings.wecom?.corpId || "",
    wecomAgentId: config.settings.wecom?.agentId || "",
    wecomSecret: config.settings.wecom?.secret || "",
  };
}

function profileSearchText(profile: ProfileSummary): string {
  return [profileLabel(profile, true), profile.email || "", profile.accountId, profile.codexAccountId || "", profile.profileId, getPlanType(profile)].join(" ").toLowerCase();
}

type SettingSectionId = "model" | "branding" | "wecom" | "proxy" | "runtime" | "limits" | "rotation" | "display";

type SettingSectionMeta = {
  id: SettingSectionId;
  title: string;
  description: string;
  icon: LucideIcon;
  tone: "violet" | "emerald" | "blue" | "indigo" | "green" | "orange" | "amber" | "slate";
  status: string;
  statusTone?: "success" | "info" | "warn" | "muted";
  metrics?: string[];
};

function enabledLabel(value: boolean): string {
  return value ? "已启用" : "未启用";
}

function limitLabel(value: string, suffix = ""): string {
  const normalized = value.trim();
  if (!normalized || normalized === "0") {
    return "不限";
  }
  return `${normalized}${suffix}`;
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
    brandingTitle: "AI Zero Token",
    brandingAppIconUrl: "",
    brandingFaviconUrl: "",
    proxyEnabled: false,
    proxyUrl: "",
    proxyNoProxy: "localhost,127.0.0.1,::1",
    autoSwitchEnabled: false,
    accountRotationEnabled: false,
    autoSwitchExcludedProfileIds: [],
    quotaSyncConcurrency: "3",
    accountMaxConcurrency: "2",
    freeAccountWebGenerationEnabled: false,
    imageLimitsEnabled: false,
    imageLimitDaily: "0",
    imageLimitHourly: "0",
    imageLimitMinIntervalSeconds: "0",
    imageLimitUserOverrides: [],
    wecomEnabled: false,
    wecomCorpId: "",
    wecomAgentId: "",
    wecomSecret: "",
  });
  const [settingsDirtyFields, setSettingsDirtyFields] = useState<Set<keyof SettingDraft>>(() => new Set());
  const [autoSwitchSearch, setAutoSwitchSearch] = useState("");
  const [openSections, setOpenSections] = useState<Set<SettingSectionId>>(() => new Set(["model"]));
  const settingsDirty = settingsDirtyFields.size > 0;

  useEffect(() => {
    if (!props.config || settingsDirty) {
      return;
    }
    setSettingsDraft(createSettingsDraft(props.config));
  }, [props.config, settingsDirty]);

  useEffect(() => {
    if (sessionStorage.getItem("azt:settings-scroll-target") !== "image-limits") {
      return;
    }
    sessionStorage.removeItem("azt:settings-scroll-target");
    window.setTimeout(() => {
      document.getElementById("image-limits")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

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
  const modelCount = props.config?.modelCatalog.modelCount || props.config?.models.length || 0;
  const modelAutoRefresh = props.config?.modelAutoRefresh;
  const wecomConfigured = Boolean(settingsDraft.wecomEnabled && settingsDraft.wecomCorpId.trim() && settingsDraft.wecomAgentId.trim());
  const selectedModel = settingsDraft.defaultModel || props.config?.settings.defaultModel || "-";
  const brandingPreviewIcon = settingsDraft.brandingAppIconUrl || settingsDraft.brandingFaviconUrl;
  const modelAutoRefreshStatus = modelAutoRefresh?.running
    ? "自动同步中"
    : modelAutoRefresh?.lastError && (!modelAutoRefresh.lastSuccessAt || (modelAutoRefresh.lastFailureAt ?? 0) > modelAutoRefresh.lastSuccessAt)
      ? "最近同步失败"
      : modelAutoRefresh?.enabled
        ? "每小时自动同步"
        : "未启用自动同步";
  const modelAutoRefreshDetail = [
    modelAutoRefresh?.intervalMs ? `周期 ${formatDuration(modelAutoRefresh.intervalMs)}` : "",
    modelAutoRefresh?.lastSuccessAt ? `最近成功 ${formatFullTime(modelAutoRefresh.lastSuccessAt)}` : "",
    modelAutoRefresh?.nextRunAt ? `下次 ${formatFullTime(modelAutoRefresh.nextRunAt)}` : "",
  ].filter(Boolean).join(" · ");
  const settingsSections: SettingSectionMeta[] = [
    {
      id: "model",
      title: "模型配置",
      description: "选择默认文本模型及同步模型目录",
      icon: Layers3,
      tone: "violet",
      status: selectedModel,
      statusTone: "success",
      metrics: [`${modelCount} 个模型`, props.config?.modelCatalog.source ? `来源 ${props.config.modelCatalog.source}` : "来源 -", modelAutoRefreshStatus],
    },
    {
      id: "branding",
      title: "系统外观",
      description: "设置管理台标题、侧边栏图标和网站 favicon",
      icon: ImageIcon,
      tone: "blue",
      status: settingsDraft.brandingTitle || "AI Zero Token",
      statusTone: "info",
      metrics: [brandingPreviewIcon ? "已配置图标" : "使用默认图标"],
    },
    {
      id: "wecom",
      title: "账号与登录",
      description: "企业微信登录与账号运行入口",
      icon: UsersRound,
      tone: "emerald",
      status: settingsDraft.wecomEnabled ? (wecomConfigured ? "企业微信已启用" : "待补齐配置") : "企业微信未启用",
      statusTone: settingsDraft.wecomEnabled ? (wecomConfigured ? "success" : "warn") : "muted",
      metrics: [`${props.config?.profiles.length || 0} 个账号`, `${autoSwitchExcludedCount} 个排除`],
    },
    {
      id: "proxy",
      title: "代理与网络",
      description: "上游代理设置与网络请求配置",
      icon: Globe2,
      tone: "indigo",
      status: settingsDraft.proxyEnabled ? "代理已启用" : "未启用代理",
      statusTone: settingsDraft.proxyEnabled ? "info" : "muted",
      metrics: [settingsDraft.proxyUrl || "未填写代理地址"],
    },
    {
      id: "runtime",
      title: "账号运行策略",
      description: "自动切换、请求轮换与并发控制",
      icon: ShieldCheck,
      tone: "green",
      status: settingsDraft.accountRotationEnabled || settingsDraft.autoSwitchEnabled ? "已启用" : "未启用",
      statusTone: settingsDraft.accountRotationEnabled || settingsDraft.autoSwitchEnabled ? "success" : "muted",
      metrics: [`单账号并发 ${settingsDraft.accountMaxConcurrency}`, `额度刷新 ${settingsDraft.quotaSyncConcurrency}`],
    },
    {
      id: "limits",
      title: "生成限制",
      description: "请求频率与用量限制配置",
      icon: Gauge,
      tone: "orange",
      status: settingsDraft.imageLimitsEnabled ? "已启用" : "未启用",
      statusTone: settingsDraft.imageLimitsEnabled ? "success" : "muted",
      metrics: [`24h ${limitLabel(settingsDraft.imageLimitDaily)}`, `1h ${limitLabel(settingsDraft.imageLimitHourly)}`],
    },
    {
      id: "rotation",
      title: "不参与自动轮换名单",
      description: "设置不参与自动切换的账号列表",
      icon: KeyRound,
      tone: "amber",
      status: `${autoSwitchExcludedCount} 个账号`,
      statusTone: autoSwitchExcludedCount > 0 ? "info" : "muted",
      metrics: [`可轮换 ${autoSwitchRuntimeReadyCount}`, `不可用 ${autoSwitchBlockedCount}`],
    },
    {
      id: "display",
      title: "显示设置",
      description: "界面显示与脱敏模式设置",
      icon: MonitorCog,
      tone: "slate",
      status: props.showEmails ? "脱敏模式：开启" : "脱敏模式：关闭",
      statusTone: props.showEmails ? "info" : "muted",
      metrics: ["仅影响前端展示"],
    },
  ];

  function toggleSection(sectionId: SettingSectionId) {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  function renderSectionHeader(section: SettingSectionMeta) {
    const Icon = section.icon;
    const isOpen = openSections.has(section.id);
    return (
      <button className="settings-config-header" type="button" onClick={() => toggleSection(section.id)} aria-expanded={isOpen}>
        <span className={`settings-config-icon tone-${section.tone}`}>
          <Icon size={25} />
        </span>
        <span className="settings-config-copy">
          <strong>{section.title}</strong>
          <span>{section.description}</span>
        </span>
        <span className="settings-config-meta">
          <span className={`settings-status-chip tone-${section.statusTone || "muted"}`}>{section.status}</span>
          {section.metrics?.map((metric) => (
            <span className="settings-metric" key={metric}>
              {metric}
            </span>
          ))}
        </span>
        <ChevronDown className={`settings-config-chevron ${isOpen ? "is-open" : ""}`} size={20} />
      </button>
    );
  }

  async function saveSettings(options?: { restart?: boolean }) {
    const hasDirtyField = (...fields: Array<keyof SettingDraft>) => fields.some((field) => settingsDirtyFields.has(field));
    const parseLimit = (value: string, label: string, max = 100_000): number | null => {
      const parsed = Number.parseInt(value || "0", 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
        props.setStatus(`${label}必须是 0 到 ${max} 之间的整数，0 表示不限制。`);
        return null;
      }
      return parsed;
    };
    const quotaSyncConcurrency = Number.parseInt(settingsDraft.quotaSyncConcurrency, 10);
    if (hasDirtyField("quotaSyncConcurrency") && (!Number.isInteger(quotaSyncConcurrency) || quotaSyncConcurrency < 1 || quotaSyncConcurrency > 32)) {
      props.setStatus("全局额度刷新并发数必须是 1 到 32 之间的整数。");
      return;
    }
    const accountMaxConcurrency = Number.parseInt(settingsDraft.accountMaxConcurrency, 10);
    if (hasDirtyField("accountMaxConcurrency") && (!Number.isInteger(accountMaxConcurrency) || accountMaxConcurrency < 1 || accountMaxConcurrency > 32)) {
      props.setStatus("每账号最大并发数必须是 1 到 32 之间的整数。");
      return;
    }
    const imageLimitDaily = parseLimit(settingsDraft.imageLimitDaily, "24 小时生图上限");
    if (imageLimitDaily === null) return;
    const imageLimitHourly = parseLimit(settingsDraft.imageLimitHourly, "1 小时生图上限");
    if (imageLimitHourly === null) return;
    const imageLimitMinIntervalSeconds = parseLimit(settingsDraft.imageLimitMinIntervalSeconds, "最小间隔秒数", 86_400);
    if (imageLimitMinIntervalSeconds === null) return;

    const imageLimitUserOverrides: Array<{
      username: string;
      perUserDaily?: number;
      perUserHourly?: number;
      minIntervalSeconds?: number;
    }> = [];
    const seenOverrideUsers = new Set<string>();
    for (const [index, item] of settingsDraft.imageLimitUserOverrides.entries()) {
      const username = item.username.trim();
      if (!username) {
        props.setStatus(`第 ${index + 1} 条用户覆盖缺少用户名。`);
        return;
      }
      if (seenOverrideUsers.has(username)) {
        props.setStatus(`用户覆盖里重复配置了 ${username}。`);
        return;
      }
      seenOverrideUsers.add(username);
      const override: {
        username: string;
        perUserDaily?: number;
        perUserHourly?: number;
        minIntervalSeconds?: number;
      } = { username };
      if (item.perUserDaily.trim()) {
        const parsed = parseLimit(item.perUserDaily, `${username} 的 24 小时生图上限`);
        if (parsed === null) return;
        override.perUserDaily = parsed;
      }
      if (item.perUserHourly.trim()) {
        const parsed = parseLimit(item.perUserHourly, `${username} 的 1 小时生图上限`);
        if (parsed === null) return;
        override.perUserHourly = parsed;
      }
      if (item.minIntervalSeconds.trim()) {
        const parsed = parseLimit(item.minIntervalSeconds, `${username} 的最小间隔秒数`, 86_400);
        if (parsed === null) return;
        override.minIntervalSeconds = parsed;
      }
      imageLimitUserOverrides.push(override);
    }

    const payload: {
      defaultModel?: string;
      branding?: { title?: string; appIconUrl?: string; faviconUrl?: string };
      networkProxy?: { enabled: boolean; url: string; noProxy: string };
      autoSwitch?: { enabled?: boolean; excludedProfileIds?: string[] };
      accountRotation?: { enabled?: boolean; strategy?: "round_robin" };
      runtime?: { quotaSyncConcurrency?: number; accountMaxConcurrency?: number };
      image?: {
        freeAccountWebGenerationEnabled?: boolean;
        limits?: {
          enabled: boolean;
          perUserDaily: number;
          perUserHourly: number;
          minIntervalSeconds: number;
          userOverrides: Array<{
            username: string;
            perUserDaily?: number;
            perUserHourly?: number;
            minIntervalSeconds?: number;
          }>;
        };
      };
      wecom?: { enabled?: boolean; corpId?: string; agentId?: string; secret?: string };
    } = {};

    if (hasDirtyField("defaultModel")) {
      payload.defaultModel = settingsDraft.defaultModel;
    }
    if (hasDirtyField("brandingTitle", "brandingAppIconUrl", "brandingFaviconUrl")) {
      payload.branding = {};
      if (hasDirtyField("brandingTitle")) {
        payload.branding.title = settingsDraft.brandingTitle;
      }
      if (hasDirtyField("brandingAppIconUrl")) {
        payload.branding.appIconUrl = settingsDraft.brandingAppIconUrl;
      }
      if (hasDirtyField("brandingFaviconUrl")) {
        payload.branding.faviconUrl = settingsDraft.brandingFaviconUrl;
      }
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
    if (hasDirtyField("accountRotationEnabled")) {
      payload.accountRotation = {
        enabled: settingsDraft.accountRotationEnabled,
        strategy: "round_robin",
      };
    }
    if (hasDirtyField("quotaSyncConcurrency", "accountMaxConcurrency")) {
      payload.runtime = {};
      if (hasDirtyField("quotaSyncConcurrency")) {
        payload.runtime.quotaSyncConcurrency = quotaSyncConcurrency;
      }
      if (hasDirtyField("accountMaxConcurrency")) {
        payload.runtime.accountMaxConcurrency = accountMaxConcurrency;
      }
    }
    if (
      hasDirtyField(
        "freeAccountWebGenerationEnabled",
        "imageLimitsEnabled",
        "imageLimitDaily",
        "imageLimitHourly",
        "imageLimitMinIntervalSeconds",
        "imageLimitUserOverrides",
      )
    ) {
      payload.image = {};
      if (hasDirtyField("freeAccountWebGenerationEnabled")) {
        payload.image.freeAccountWebGenerationEnabled = settingsDraft.freeAccountWebGenerationEnabled;
      }
      if (hasDirtyField("imageLimitsEnabled", "imageLimitDaily", "imageLimitHourly", "imageLimitMinIntervalSeconds", "imageLimitUserOverrides")) {
        payload.image.limits = {
          enabled: settingsDraft.imageLimitsEnabled,
          perUserDaily: imageLimitDaily,
          perUserHourly: imageLimitHourly,
          minIntervalSeconds: imageLimitMinIntervalSeconds,
          userOverrides: imageLimitUserOverrides,
        };
      }
    }
    if (hasDirtyField("wecomEnabled", "wecomCorpId", "wecomAgentId", "wecomSecret")) {
      payload.wecom = {
        enabled: settingsDraft.wecomEnabled,
        ...(hasDirtyField("wecomCorpId") ? { corpId: settingsDraft.wecomCorpId } : {}),
        ...(hasDirtyField("wecomAgentId") ? { agentId: settingsDraft.wecomAgentId } : {}),
        ...(hasDirtyField("wecomSecret") ? { secret: settingsDraft.wecomSecret } : {}),
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
      <div className="settings-config-list">
        <section className={`settings-config-card ${openSections.has("model") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[0])}
          {openSections.has("model") ? (
            <div className="settings-config-body">
              <div className="settings-form-grid two-columns">
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
                <div className="settings-info-box">
                  <span>模型目录</span>
                  <strong>{props.config?.modelCatalog.source || "-"}</strong>
                  <p>
                    当前可用 {modelCount} 个模型。服务器每 1 小时自动同步 Codex 模型，也可手动立即同步。
                    {modelAutoRefreshDetail ? ` ${modelAutoRefreshDetail}。` : ""}
                    {modelAutoRefresh?.lastError ? ` 最近错误：${modelAutoRefresh.lastError}` : ""}
                  </p>
                  <div className="settings-inline-actions">
                    <button className="btn-secondary" type="button" onClick={refreshModels} disabled={props.busy === "models"}>
                      {props.busy === "models" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                      同步 Codex 模型
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("branding") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[1])}
          {openSections.has("branding") ? (
            <div className="settings-config-body">
              <div className="settings-form-grid three-columns">
                <label className="field">
                  <span>网站标题</span>
                  <input className="input" value={settingsDraft.brandingTitle} onChange={(event) => markSettingsDirty({ brandingTitle: event.target.value })} placeholder="AI Zero Token" />
                </label>
                <label className="field">
                  <span>设置图标 URL</span>
                  <input className="input" value={settingsDraft.brandingAppIconUrl} onChange={(event) => markSettingsDirty({ brandingAppIconUrl: event.target.value })} placeholder="https://example.com/logo.svg" />
                </label>
                <label className="field">
                  <span>网站 ico URL</span>
                  <input className="input" value={settingsDraft.brandingFaviconUrl} onChange={(event) => markSettingsDirty({ brandingFaviconUrl: event.target.value })} placeholder="https://example.com/favicon.ico" />
                </label>
              </div>
              <div className="settings-brand-preview">
                <span className="settings-brand-preview-mark">
                  {brandingPreviewIcon ? <img src={brandingPreviewIcon} alt="" /> : <ImageIcon size={22} />}
                </span>
                <div>
                  <strong>{settingsDraft.brandingTitle || "AI Zero Token"}</strong>
                  <span>{brandingPreviewIcon || "当前使用默认应用图标"}</span>
                </div>
              </div>
              <p className="settings-status-note">支持 SVG、PNG、ICO 或可访问的图片 URL；保存后当前页面标题和图标会立即刷新。</p>
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("wecom") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[2])}
          {openSections.has("wecom") ? (
            <div className="settings-config-body">
              <label className="settings-toggle-row">
                <input type="checkbox" checked={settingsDraft.wecomEnabled} onChange={(event) => markSettingsDirty({ wecomEnabled: event.target.checked })} />
                <span>
                  <strong>启用企业微信扫码登录</strong>
                  <em>扫码成功后会按企业微信 UserId 自动创建普通用户，用户名格式为 wxwork:UserId。</em>
                </span>
              </label>
              <div className="settings-form-grid three-columns">
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
              </div>
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("proxy") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[3])}
          {openSections.has("proxy") ? (
            <div className="settings-config-body">
              <label className="settings-toggle-row">
                <input type="checkbox" checked={settingsDraft.proxyEnabled} onChange={(event) => markSettingsDirty({ proxyEnabled: event.target.checked })} />
                <span>
                  <strong>启用 OAuth、模型刷新和接口转发代理</strong>
                  <em>适用于本机代理或内网代理场景。</em>
                </span>
              </label>
              <div className="settings-form-grid two-columns">
                <label className="field">
                  <span>代理地址</span>
                  <input className="input" value={settingsDraft.proxyUrl} onChange={(event) => markSettingsDirty({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" />
                </label>
                <label className="field">
                  <span>No Proxy</span>
                  <input className="input" value={settingsDraft.proxyNoProxy} onChange={(event) => markSettingsDirty({ proxyNoProxy: event.target.value })} />
                </label>
              </div>
              <div className="settings-inline-actions">
                <button className="btn-secondary" type="button" onClick={testProxy} disabled={props.busy === "proxy"}>
                  {props.busy === "proxy" ? <Loader2 className="spin" size={16} /> : <Network size={16} />}
                  测试代理
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("runtime") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[4])}
          {openSections.has("runtime") ? (
            <div className="settings-config-body">
              <div className="settings-toggle-grid">
                <label className="settings-toggle-row">
                  <input type="checkbox" checked={settingsDraft.accountRotationEnabled} onChange={(event) => markSettingsDirty({ accountRotationEnabled: event.target.checked })} />
                  <span>
                    <strong>按请求轮换可用账号</strong>
                    <em>使用顺序轮询策略，并复用“不参与自动轮换名单”。</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input type="checkbox" checked={settingsDraft.autoSwitchEnabled} onChange={(event) => markSettingsDirty({ autoSwitchEnabled: event.target.checked })} />
                  <span>
                    <strong>额度耗尽后自动切换账号</strong>
                    <em>当前 API 账号额度耗尽后切换到下一个仍有额度的账号。</em>
                  </span>
                </label>
              </div>
              <div className="settings-form-grid two-columns">
                <label className="field">
                  <span>每账号最大并发数</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    max={32}
                    min={1}
                    type="number"
                    value={settingsDraft.accountMaxConcurrency}
                    onChange={(event) => markSettingsDirty({ accountMaxConcurrency: event.target.value })}
                  />
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
              </div>
              {props.status ? <p className="settings-status-note">{props.status}</p> : null}
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("limits") ? "is-open" : ""}`} id="image-limits">
          {renderSectionHeader(settingsSections[5])}
          {openSections.has("limits") ? (
            <div className="settings-config-body">
              <label className="settings-toggle-row">
                <input type="checkbox" checked={settingsDraft.imageLimitsEnabled} onChange={(event) => markSettingsDirty({ imageLimitsEnabled: event.target.checked })} />
                <span>
                  <strong>启用登录用户生图限额</strong>
                  <em>对图片生成和图片编辑请求生效，0 表示不限制；未登录 API Key 请求不计入用户限额。</em>
                </span>
              </label>
              <div className="settings-form-grid three-columns">
                <label className="field">
                  <span>每用户 24 小时上限</span>
                  <input className="input" inputMode="numeric" min={0} type="number" value={settingsDraft.imageLimitDaily} onChange={(event) => markSettingsDirty({ imageLimitDaily: event.target.value })} />
                </label>
                <label className="field">
                  <span>每用户 1 小时上限</span>
                  <input className="input" inputMode="numeric" min={0} type="number" value={settingsDraft.imageLimitHourly} onChange={(event) => markSettingsDirty({ imageLimitHourly: event.target.value })} />
                </label>
                <label className="field">
                  <span>两次生图最小间隔（秒）</span>
                  <input className="input" inputMode="numeric" min={0} max={86400} type="number" value={settingsDraft.imageLimitMinIntervalSeconds} onChange={(event) => markSettingsDirty({ imageLimitMinIntervalSeconds: event.target.value })} />
                </label>
              </div>
              <p className="settings-status-note">单个数据库用户的覆盖值可在“用户管理”页面直接编辑；留空表示继承这里的全局限额。</p>
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("rotation") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[6])}
          {openSections.has("rotation") ? (
            <div className="settings-config-body">
              <div className="auto-switch-counts" aria-label="自动轮换账号统计">
                <span className="count-pill is-included">可轮换 {autoSwitchRuntimeReadyCount} 个</span>
                <span className="count-pill is-blocked">不可用 {autoSwitchBlockedCount} 个</span>
                <span className="count-pill is-excluded">手动排除 {autoSwitchExcludedCount} 个</span>
              </div>
              <p className="settings-status-note">勾选表示手动排除。该名单同时作用于按请求轮换和额度耗尽后的自动切换。</p>
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
            </div>
          ) : null}
        </section>

        <section className={`settings-config-card ${openSections.has("display") ? "is-open" : ""}`}>
          {renderSectionHeader(settingsSections[7])}
          {openSections.has("display") ? (
            <div className="settings-config-body">
              <label className="settings-toggle-row">
                <input type="checkbox" checked={props.showEmails} onChange={(event) => props.setShowEmails(event.target.checked)} />
                <span>
                  <strong>脱敏模式</strong>
                  <em>开启后账号邮箱将以脱敏形式展示。</em>
                </span>
              </label>
            </div>
          ) : null}
        </section>
      </div>

      <div className={`settings-save-bar ${settingsDirty ? "is-dirty" : ""}`}>
        <div>
          <strong>{settingsDirty ? "有未保存的设置" : "设置已同步"}</strong>
          <span>{settingsDirty ? "保存后才会写入网关配置。" : "展开配置卡片可继续调整策略。"}</span>
        </div>
        <button className="btn-secondary" type="button" onClick={() => void saveSettings()} disabled={props.busy === "settings" || props.busy === "restart" || !settingsDirty}>
          {props.busy === "settings" ? <Loader2 className="spin" size={16} /> : null}
          保存设置
        </button>
        <button className="btn-primary" type="button" onClick={() => void saveSettings({ restart: true })} disabled={props.busy === "settings" || props.busy === "restart" || !settingsDirty || !props.config?.restartSupported}>
          {props.busy === "restart" ? <Loader2 className="spin" size={16} /> : null}
          保存并重启网关
        </button>
      </div>
    </section>
  );
}
