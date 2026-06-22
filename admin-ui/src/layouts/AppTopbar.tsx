import { LogOut } from "lucide-react";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";
import { userDisplayName } from "@/shared/lib/users";

export function AppTopbar({ workspace }: { workspace: UseAdminWorkspaceResult }) {
  const { activeRoute, activeRouteMeta, pageDescriptions } = workspace;
  const roleLabel = workspace.role === "admin" ? "管理员" : "普通用户";

  return (
    <header className="topbar">
      <div className="page-title">
        <h1>{activeRoute === "launch" ? "启动页" : activeRouteMeta.label}</h1>
        <p>{pageDescriptions[activeRoute]}</p>
      </div>
      <div className="topbar-account">
        <span>{userDisplayName(workspace.config, workspace.currentUser) || "已登录"} · {roleLabel}</span>
        <button className="btn-secondary topbar-logout" type="button" onClick={() => void workspace.signOut()} disabled={workspace.busy === "logout"}>
          <LogOut size={15} />
          退出登录
        </button>
      </div>
    </header>
  );
}
