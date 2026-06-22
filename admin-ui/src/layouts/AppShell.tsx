import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { AppOverlays } from "./AppOverlays";
import { RouteRenderer } from "./RouteRenderer";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";
import { Download, Package, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

const DESKTOP_RELEASES_URL = "https://github.com/fchangjun/AI-Zero-Token/releases";
const NPM_UPDATE_COMMAND = "npm install -g ai-zero-token";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "azt.sidebar.collapsed";

export function AppShell({ workspace }: { workspace: UseAdminWorkspaceResult }) {
  const versionStatus = workspace.config?.versionStatus;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // Ignore localStorage failures in restricted browser contexts.
    }
  }, [sidebarCollapsed]);

  return (
    <div className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <AppSidebar workspace={workspace} collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />

      <main className={`main route-${workspace.activeRoute}`}>
        {versionStatus?.status === "update-available" && (
          <section className="update-panel strong-update-panel">
            <div className="update-mark">
              <Sparkles size={18} />
            </div>
            <div className="update-copy">
              <div className="update-title-row">
                <strong>发现新版本</strong>
                <span>{versionStatus.currentVersion} → {versionStatus.latestVersion}</span>
              </div>
              <p>
                桌面端下载 GitHub Release；npm 用户执行 <code>{NPM_UPDATE_COMMAND}</code>
              </p>
            </div>
            <div className="update-actions">
              <a className="btn-primary" href={DESKTOP_RELEASES_URL} target="_blank" rel="noreferrer">
                <Download size={15} />
                桌面端更新
              </a>
              <button
                className="btn-secondary"
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(NPM_UPDATE_COMMAND).then(
                    () => workspace.setStatus("npm 更新命令已复制。"),
                    () => workspace.setStatus(NPM_UPDATE_COMMAND),
                  );
                }}
              >
                <Package size={15} />
                复制 npm 更新命令
              </button>
            </div>
          </section>
        )}
        <AppTopbar workspace={workspace} />
        <RouteRenderer workspace={workspace} />
      </main>

      <AppOverlays workspace={workspace} />
    </div>
  );
}
