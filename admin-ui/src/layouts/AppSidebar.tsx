import appMark from "@/assets/app-mark.svg";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";

export function AppSidebar({ workspace }: { workspace: UseAdminWorkspaceResult }) {
  const { routes, activeRoute, goRoute, config } = workspace;
  const versionStatus = config?.versionStatus;
  const versionTone = versionStatus?.status === "update-available" ? "orange" : versionStatus?.status === "error" ? "red" : "green";
  const topRoutes = routes.filter((route) => !route.parentId);
  const childRoutesByParent = routes.reduce<Record<string, typeof routes>>((groups, route) => {
    if (route.parentId) {
      groups[route.parentId] = [...(groups[route.parentId] || []), route];
    }
    return groups;
  }, {});

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
        {topRoutes.map((route) => {
          const Icon = route.icon;
          const childRoutes = childRoutesByParent[route.id] || [];
          const active = activeRoute === route.id || childRoutes.some((child) => child.id === activeRoute);
          return (
            <div className="nav-group" key={route.id}>
              <button className={`nav-item ${active ? "is-active" : ""}`} type="button" onClick={() => goRoute(route.id)}>
                <Icon size={16} />
                <span>{route.label}</span>
              </button>
              {childRoutes.length > 0 ? (
                <div className="nav-subitems" aria-label={`${route.label}子菜单`}>
                  {childRoutes.map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <button className={`nav-item nav-subitem ${activeRoute === child.id ? "is-active" : ""}`} key={child.id} type="button" onClick={() => goRoute(child.id)}>
                        <ChildIcon size={15} />
                        <span>{child.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
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
