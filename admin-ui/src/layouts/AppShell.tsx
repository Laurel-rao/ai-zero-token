import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { AppOverlays } from "./AppOverlays";
import { RouteRenderer } from "./RouteRenderer";
import { AppMobileNavigation } from "./AppMobileNavigation";
import { LiveLogDrawer } from "@/shared/components/LiveLogDrawer";
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
  const [liveLogOpen, setLiveLogOpen] = useState(false);
  const canViewLiveLog = workspace.role === "admin";

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // Ignore localStorage failures in restricted browser contexts.
    }
  }, [sidebarCollapsed]);

  return (
    <div className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""} ${workspace.activeRoute === "chat" ? "is-chat-route" : ""}`}>
      <AppSidebar
        workspace={workspace}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        onOpenLiveLog={canViewLiveLog ? () => setLiveLogOpen(true) : undefined}
      />
      <AppMobileNavigation workspace={workspace} onOpenLiveLog={canViewLiveLog ? () => setLiveLogOpen(true) : undefined} />

      <main className={`main route-${workspace.activeRoute}`}>
        <AppTopbar workspace={workspace} />
        <RouteRenderer workspace={workspace} />
      </main>

      <AppOverlays workspace={workspace} />
      {canViewLiveLog ? <LiveLogDrawer open={liveLogOpen} onClose={() => setLiveLogOpen(false)} /> : null}
    </div>
  );
}
