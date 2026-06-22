import { startTransition, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig, RequestLog } from "@/shared/types";
import type { BusyAction } from "@/shared/lib/app-types";
import { errorMessage } from "@/shared/lib/app-utils";
import { canAccessRoute, normalizeUserRole, readRouteFromHash, type AppRoute, type UserRole } from "@/routes/routes";
import { applyBranding } from "@/shared/lib/branding";

export type ModalImage = { src: string; meta: string; filename?: string; ratio?: string };
export type ManualLoginState = {
  loginId: string;
  message: string;
  authorizeUrl?: string;
} | null;

export type WorkspaceState = {
  currentUser: string | null;
  role: UserRole;
  config: AdminConfig | null;
  setConfig: Dispatch<SetStateAction<AdminConfig | null>>;
  busy: BusyAction;
  setBusy: Dispatch<SetStateAction<BusyAction>>;
  status: string;
  setStatus: Dispatch<SetStateAction<string>>;
  showEmails: boolean;
  setShowEmails: Dispatch<SetStateAction<boolean>>;
  accountModalOpen: boolean;
  setAccountModalOpen: Dispatch<SetStateAction<boolean>>;
  contactOpen: boolean;
  setContactOpen: Dispatch<SetStateAction<boolean>>;
  manualLogin: ManualLoginState;
  setManualLogin: Dispatch<SetStateAction<ManualLoginState>>;
  previewImage: ModalImage | null;
  setPreviewImage: Dispatch<SetStateAction<ModalImage | null>>;
  activeRoute: AppRoute;
  setActiveRoute: Dispatch<SetStateAction<AppRoute>>;
  dataOwnerFilter: string;
  setDataOwnerFilter: Dispatch<SetStateAction<string>>;
  requestLogs: RequestLog[];
  setRequestLogs: Dispatch<SetStateAction<RequestLog[]>>;
  refreshConfig: (options?: { runtime?: boolean; silent?: boolean }) => Promise<AdminConfig>;
};

const ACTIVE_PROFILE_REFRESH_MS = 15 * 1000;
const REQUEST_LOGS_REFRESH_MS = 5 * 1000;
const SHOW_EMAILS_STORAGE_KEY = "azt:settings:show-emails";

function readStoredShowEmails(): boolean {
  try {
    return window.localStorage.getItem(SHOW_EMAILS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useAdminWorkspaceState(auth?: { currentUser?: string | null; role?: UserRole }): WorkspaceState {
  const role = normalizeUserRole(auth?.role);
  const currentUser = auth?.currentUser ?? null;
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [busy, setBusy] = useState<BusyAction>("initial");
  const [status, setStatus] = useState("正在读取本地网关状态...");
  const [showEmails, setShowEmails] = useState(readStoredShowEmails);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [manualLogin, setManualLogin] = useState<ManualLoginState>(null);
  const [previewImage, setPreviewImage] = useState<ModalImage | null>(null);
  const [activeRoute, setActiveRoute] = useState<AppRoute>(() => readRouteFromHash(role));
  const [dataOwnerFilter, setDataOwnerFilter] = useState("");
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);

  const refreshConfig = useCallback(async (options?: { runtime?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setBusy(options?.runtime ? "runtime-refresh" : "refresh");
    }
    try {
      const next = await fetchJson<AdminConfig & { quotaSync?: { total: number; synced: number; failed: number; skipped?: number } }>(
        options?.runtime ? "/_gateway/admin/runtime-refresh" : "/_gateway/admin/config",
        options?.runtime
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ staleOnly: Boolean(options.silent) }),
            }
          : undefined,
      );
      setConfig(next);
      applyBranding(next.settings.branding);
      const sync = next.quotaSync;
      setStatus(
        options?.runtime && sync
          ? `状态和额度已刷新：${sync.synced}/${sync.total} 个账号成功${sync.failed ? `，${sync.failed} 个失败` : ""}${sync.skipped ? `，${sync.skipped} 个跳过` : ""}。`
          : options?.runtime
            ? "状态和额度已刷新。"
            : "网关状态已同步。",
      );
      return next;
    } catch (error) {
      setStatus(errorMessage(error));
      throw error;
    } finally {
      if (!options?.silent) {
        setBusy(null);
      }
    }
  }, []);

  const refreshRequestLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (role === "admin" && dataOwnerFilter) {
        params.set("owner", dataOwnerFilter);
      }
      const next = await fetchJson<{ data: RequestLog[] }>(`/_gateway/admin/request-logs${params.size ? `?${params.toString()}` : ""}`);
      setRequestLogs(next.data);
    } catch {
      // Request logs are diagnostic only; keep the rest of the console usable.
    }
  }, [dataOwnerFilter, role]);

  useEffect(() => {
    refreshConfig().catch(() => undefined);
    refreshRequestLogs().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshConfig({ silent: true }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshConfig, refreshRequestLogs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refreshRequestLogs().catch(() => undefined);
      }
    }, REQUEST_LOGS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshRequestLogs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_EMAILS_STORAGE_KEY, String(showEmails));
    } catch {
      // Ignore storage failures; the runtime state still updates.
    }
  }, [showEmails]);

  useEffect(() => {
    const handleHashChange = () => {
      const route = readRouteFromHash(role);
      startTransition(() => {
        setActiveRoute((current) => (current === route ? current : route));
      });
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [role]);

  useEffect(() => {
    const route = readRouteFromHash(role);
    setActiveRoute((current) => (canAccessRoute(current, role) ? current : route));
    if (window.location.hash !== `#${route}` && !canAccessRoute(readRouteFromHash("admin"), role)) {
      window.history.replaceState(null, "", `#${route}`);
    }
  }, [role]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && config?.settings.autoSwitch.enabled) {
        refreshConfig({ silent: true }).catch(() => undefined);
      }
    }, ACTIVE_PROFILE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [config?.settings.autoSwitch.enabled, refreshConfig]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setPreviewImage(null);
      setContactOpen(false);
      setAccountModalOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return {
    currentUser,
    role,
    config,
    setConfig,
    busy,
    setBusy,
    status,
    setStatus,
    showEmails,
    setShowEmails,
    accountModalOpen,
    setAccountModalOpen,
    contactOpen,
    setContactOpen,
    manualLogin,
    setManualLogin,
    previewImage,
    setPreviewImage,
    activeRoute,
    setActiveRoute,
    dataOwnerFilter,
    setDataOwnerFilter,
    requestLogs,
    setRequestLogs,
    refreshConfig,
  };
}
