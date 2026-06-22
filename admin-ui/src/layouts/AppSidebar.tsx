import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";
import { getAppIconUrl, normalizeBranding } from "@/shared/lib/branding";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";

const NAV_OPEN_STORAGE_KEY = "azt.sidebar.openGroups";

export function AppSidebar({
  workspace,
  collapsed,
  onCollapsedChange,
}: {
  workspace: UseAdminWorkspaceResult;
  collapsed: boolean;
  onCollapsedChange: (value: boolean) => void;
}) {
  const { routes, activeRoute, goRoute, config } = workspace;
  const versionStatus = config?.versionStatus;
  const branding = normalizeBranding(config?.settings.branding);
  const versionTone = versionStatus?.status === "update-available" ? "orange" : versionStatus?.status === "error" ? "red" : "green";
  const topRoutes = routes.filter((route) => !route.parentId);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    try {
      const stored = window.localStorage.getItem(NAV_OPEN_STORAGE_KEY);
      return new Set(stored ? JSON.parse(stored) as string[] : ["settings"]);
    } catch {
      return new Set(["settings"]);
    }
  });
  const childRoutesByParent = routes.reduce<Record<string, typeof routes>>((groups, route) => {
    if (route.parentId) {
      groups[route.parentId] = [...(groups[route.parentId] || []), route];
    }
    return groups;
  }, {});

  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_OPEN_STORAGE_KEY, JSON.stringify([...openGroups]));
    } catch {
      // Ignore localStorage failures in restricted browser contexts.
    }
  }, [openGroups]);

  function toggleGroup(id: string) {
    setOpenGroups((items) => {
      const next = new Set(items);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="brand">
        <div className="brand-mark" title={collapsed ? branding.title : undefined}>
          <img src={getAppIconUrl(branding)} alt="" />
        </div>
        <div className="brand-copy">
          <strong>{branding.title}</strong>
          <span>本地 AI 网关工作台</span>
        </div>
        <button
          className="sidebar-collapse-btn"
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-pressed={collapsed}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="nav" aria-label="主导航">
        {topRoutes.map((route) => {
          const Icon = route.icon;
          const childRoutes = childRoutesByParent[route.id] || [];
          const hasActiveChild = childRoutes.some((child) => child.id === activeRoute);
          const active = activeRoute === route.id || hasActiveChild;
          const isOpen = hasActiveChild || openGroups.has(route.id);
          return (
            <div className={`nav-group ${childRoutes.length > 0 ? "has-children" : ""} ${isOpen ? "is-open" : ""}`} key={route.id}>
              <button className={`nav-item ${active ? "is-active" : ""}`} type="button" onClick={() => goRoute(route.id)} title={collapsed ? route.label : undefined}>
                <Icon className="nav-icon" size={16} />
                <span className="nav-label">{route.label}</span>
              </button>
              {childRoutes.length > 0 ? (
                <button
                  className="nav-group-toggle"
                  type="button"
                  onClick={() => toggleGroup(route.id)}
                  title={isOpen ? "收起菜单" : "展开菜单"}
                  aria-label={`${isOpen ? "收起" : "展开"}${route.label}子菜单`}
                  aria-expanded={isOpen}
                >
                  <ChevronDown size={14} />
                </button>
              ) : null}
              {childRoutes.length > 0 && isOpen ? (
                <div className="nav-subitems" aria-label={`${route.label}子菜单`}>
                  {childRoutes.map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <button className={`nav-item nav-subitem ${activeRoute === child.id ? "is-active" : ""}`} key={child.id} type="button" onClick={() => goRoute(child.id)}>
                        <ChildIcon className="nav-icon" size={15} />
                        <span className="nav-label">{child.label}</span>
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
