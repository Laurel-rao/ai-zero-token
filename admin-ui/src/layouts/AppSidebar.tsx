import appMark from "@/assets/app-mark.svg";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";

export function AppSidebar({ workspace }: { workspace: UseAdminWorkspaceResult }) {
  const { routes, activeRoute, goRoute, config } = workspace;
  const versionStatus = config?.versionStatus;
  const versionTone = versionStatus?.status === "update-available" ? "orange" : versionStatus?.status === "error" ? "red" : "green";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={appMark} alt="" />
        </div>
        <div>
          <strong>AI Zero Token</strong>
          <span>本地 AI 网关工作台</span>
        </div>
      </div>

      <nav className="nav" aria-label="主导航">
        {routes.map((route) => {
          const Icon = route.icon;
          return (
            <button className={`nav-item ${activeRoute === route.id ? "is-active" : ""}`} key={route.id} type="button" onClick={() => goRoute(route.id)}>
              <Icon size={16} />
              <span>{route.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={`sidebar-status tone-${versionTone}`}>
        <strong className="sidebar-version-line">
          <i className={`version-dot tone-${versionTone}`} />
          {versionStatus?.currentVersion || versionStatus?.latestVersion || "—"}
        </strong>
      </div>
    </aside>
  );
}
