import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { AppOverlays } from "./AppOverlays";
import { RouteRenderer } from "./RouteRenderer";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";
import { useEffect, useState } from "react";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "azt.sidebar.collapsed";

export function AppShell({ workspace }: { workspace: UseAdminWorkspaceResult }) {
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
        <AppTopbar workspace={workspace} />
        <RouteRenderer workspace={workspace} />
      </main>

      <AppOverlays workspace={workspace} />
    </div>
  );
}
