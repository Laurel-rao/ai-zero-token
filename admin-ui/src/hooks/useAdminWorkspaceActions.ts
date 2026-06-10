import { startTransition, useCallback } from "react";
import { fetchJson } from "@/shared/api";
import type { AdminConfig } from "@/shared/types";
import { errorMessage } from "@/shared/lib/app-utils";
import type { AppRoute } from "@/routes/routes";
import type { WorkspaceState } from "./useAdminWorkspaceState";

export type WorkspaceActions = {
  login: () => Promise<void>;
  submitManualLogin: (input: string) => Promise<void>;
  cancelManualLogin: () => Promise<void>;
  logout: () => Promise<void>;
  goRoute: (route: AppRoute) => void;
  copyBaseUrl: () => void;
};

type ManualLoginResult = {
  login: {
    status: "manual_required";
    loginId: string;
    message: string;
  };
  config: AdminConfig;
};

function isManualLoginResult(value: AdminConfig | ManualLoginResult): value is ManualLoginResult {
  return "login" in value && value.login.status === "manual_required";
}

export function useAdminWorkspaceActions(state: WorkspaceState): WorkspaceActions {
  const login = useCallback(async () => {
    state.setBusy("login");
    state.setStatus("正在打开 OAuth 登录...");
    try {
      const result = await fetchJson<AdminConfig | ManualLoginResult>("/_gateway/admin/login", { method: "POST" });
      if (isManualLoginResult(result)) {
        state.setConfig(result.config);
        state.setManualLogin({
          loginId: result.login.loginId,
          message: result.login.message,
        });
        state.setAccountModalOpen(true);
        state.setStatus(result.login.message);
        return;
      }

      const next = result;
      state.setConfig(next);
      state.setAccountModalOpen(false);
      state.setStatus("登录完成，账号状态已同步。");
    } catch (error) {
      state.setStatus(errorMessage(error));
    } finally {
      state.setBusy(null);
    }
  }, [state]);

  const submitManualLogin = useCallback(async (input: string) => {
    const pending = state.manualLogin;
    const manualInput = input.trim();
    if (!pending) {
      state.setStatus("没有等待中的 OAuth 登录，请重新点击登录。");
      return;
    }
    if (!manualInput) {
      state.setStatus("请粘贴完整回调 URL 或 authorization code。");
      return;
    }

    state.setBusy("login-manual");
    state.setStatus("正在提交手动授权结果...");
    try {
      const next = await fetchJson<AdminConfig>("/_gateway/admin/login/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: pending.loginId, input: manualInput }),
      });
      state.setConfig(next);
      state.setManualLogin(null);
      state.setAccountModalOpen(false);
      state.setStatus("登录完成，账号状态已同步。");
    } catch (error) {
      state.setStatus(errorMessage(error));
    } finally {
      state.setBusy(null);
    }
  }, [state]);

  const cancelManualLogin = useCallback(async () => {
    const pending = state.manualLogin;
    if (!pending) {
      state.setManualLogin(null);
      return;
    }

    state.setBusy("login-manual");
    try {
      const next = await fetchJson<AdminConfig>("/_gateway/admin/login/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: pending.loginId }),
      });
      state.setConfig(next);
      state.setManualLogin(null);
      state.setStatus("已取消 OAuth 登录。");
    } catch (error) {
      state.setStatus(errorMessage(error));
    } finally {
      state.setBusy(null);
    }
  }, [state]);

  const logout = useCallback(async () => {
    if (!window.confirm("确认清空本地保存的所有账号？")) {
      return;
    }
    state.setBusy("logout");
    state.setStatus("正在清空账号...");
    try {
      const next = await fetchJson<AdminConfig>("/_gateway/admin/logout", { method: "POST" });
      state.setConfig(next);
      state.setRequestLogs([]);
      state.setStatus("账号已清空。");
    } catch (error) {
      state.setStatus(errorMessage(error));
    } finally {
      state.setBusy(null);
    }
  }, [state]);

  const goRoute = useCallback((route: AppRoute) => {
    const nextHash = `#${route}`;
    startTransition(() => {
      state.setActiveRoute(route);
    });
    if (window.location.hash !== nextHash) {
      window.location.hash = route;
    }
  }, [state]);

  const copyBaseUrl = useCallback(() => {
    const value = state.config?.baseUrl || "http://127.0.0.1:8787/v1";
    navigator.clipboard.writeText(value).then(
      () => state.setStatus("Base URL 已复制。"),
      () => state.setStatus(value),
    );
  }, [state]);

  return {
    login,
    submitManualLogin,
    cancelManualLogin,
    logout,
    goRoute,
    copyBaseUrl,
  };
}
