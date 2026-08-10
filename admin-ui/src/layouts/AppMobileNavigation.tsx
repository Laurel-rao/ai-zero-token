import { useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, LogOut, X } from "lucide-react";
import type { UseAdminWorkspaceResult } from "@/hooks/useAdminWorkspace";
import type { AppRoute } from "@/routes/routes";
import { getAppIconUrl, normalizeBranding } from "@/shared/lib/branding";
import { userDisplayName } from "@/shared/lib/users";

const ADMIN_PRIMARY_ROUTES: AppRoute[] = ["overview", "chat", "generate", "logs"];
const USER_PRIMARY_ROUTES: AppRoute[] = ["chat", "generate", "logs", "settings"];

const ROUTE_SECTIONS: Array<{ title: string; routes: AppRoute[] }> = [
  { title: "AI 工作区", routes: ["chat", "generate", "overview", "usage"] },
  { title: "管理与工具", routes: ["accounts", "tester", "image-bed", "logs", "network", "docs", "launch"] },
  { title: "系统", routes: ["settings", "settings-users", "settings-groups"] },
];

export function AppMobileNavigation({ workspace }: { workspace: UseAdminWorkspaceResult }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const branding = normalizeBranding(workspace.config?.settings.branding);
  const primaryRouteIds = workspace.role === "admin" ? ADMIN_PRIMARY_ROUTES : USER_PRIMARY_ROUTES;
  const routeMap = useMemo(() => new Map(workspace.routes.map((route) => [route.id, route])), [workspace.routes]);
  const primaryRoutes = primaryRouteIds.flatMap((id) => {
    const route = routeMap.get(id);
    return route ? [route] : [];
  });
  const secondaryRouteIds = new Set(workspace.routes.map((route) => route.id).filter((id) => !primaryRouteIds.includes(id)));
  const secondaryRouteActive = secondaryRouteIds.has(workspace.activeRoute);
  const accountName = userDisplayName(workspace.config, workspace.currentUser) || "已登录用户";

  useEffect(() => {
    setMenuOpen(false);
  }, [workspace.activeRoute]);

  useEffect(() => {
    document.body.classList.toggle("is-mobile-nav-open", menuOpen);
    document.documentElement.classList.toggle("is-mobile-nav-open", menuOpen);
    if (!menuOpen) {
      return undefined;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("is-mobile-nav-open");
      document.documentElement.classList.remove("is-mobile-nav-open");
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  function openRoute(route: AppRoute) {
    setMenuOpen(false);
    workspace.goRoute(route);
  }

  function openMenu() {
    menuOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
    window.requestAnimationFrame(() => menuOpenerRef.current?.focus());
  }

  return (
    <>
      <header className="mobile-app-header">
        <div className="mobile-app-identity">
          <img src={getAppIconUrl(branding)} alt={`${branding.title} 图标`} />
          <div>
            <span>{branding.title}</span>
            <strong>{workspace.activeRouteMeta.label}</strong>
          </div>
        </div>
        <button
          className="mobile-account-button"
          type="button"
          onClick={openMenu}
          aria-label="打开全部功能和账号菜单"
          aria-expanded={menuOpen}
        >
          <span>{accountName.slice(0, 1).toUpperCase()}</span>
        </button>
      </header>

      <nav className="mobile-bottom-nav" aria-label="手机端主导航">
        {primaryRoutes.map((route) => {
          const Icon = route.icon;
          const active = workspace.activeRoute === route.id;
          return (
            <button
              className={`mobile-bottom-nav-item ${active ? "is-active" : ""}`}
              type="button"
              key={route.id}
              onClick={() => openRoute(route.id)}
              aria-current={active ? "page" : undefined}
            >
              <span className="mobile-bottom-nav-icon"><Icon size={21} strokeWidth={active ? 2.4 : 2} /></span>
              <span>{route.label}</span>
            </button>
          );
        })}
        <button
          className={`mobile-bottom-nav-item ${menuOpen || secondaryRouteActive ? "is-active" : ""}`}
          type="button"
          onClick={openMenu}
          aria-expanded={menuOpen}
          aria-controls="mobile-function-sheet"
        >
          <span className="mobile-bottom-nav-icon"><Grid2X2 size={21} /></span>
          <span>全部</span>
        </button>
      </nav>

      {menuOpen ? (
        <div className="mobile-sheet-layer">
          <button className="mobile-sheet-backdrop" type="button" onClick={closeMenu} aria-label="关闭全部功能" />
          <section id="mobile-function-sheet" className="mobile-function-sheet" role="dialog" aria-modal="true" aria-label="全部功能">
            <div className="mobile-sheet-handle" aria-hidden="true" />
            <header className="mobile-sheet-header">
              <div>
                <strong>全部功能</strong>
                <span>切换工作区或管理账号</span>
              </div>
              <button ref={closeButtonRef} type="button" onClick={closeMenu} aria-label="关闭全部功能">
                <X size={20} />
              </button>
            </header>

            <div className="mobile-account-card">
              <span className="mobile-account-avatar">{accountName.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{accountName}</strong>
                <span>{workspace.role === "admin" ? "管理员" : "普通用户"} · {workspace.config?.versionStatus?.currentVersion || "AI Zero Token"}</span>
              </div>
            </div>

            <div className="mobile-function-sections">
              {ROUTE_SECTIONS.map((section) => {
                const sectionRoutes = section.routes.flatMap((id) => {
                  const route = routeMap.get(id);
                  return route ? [route] : [];
                });
                if (sectionRoutes.length === 0) {
                  return null;
                }
                return (
                  <section className="mobile-function-section" key={section.title}>
                    <h2>{section.title}</h2>
                    <div className="mobile-function-grid">
                      {sectionRoutes.map((route) => {
                        const Icon = route.icon;
                        const active = workspace.activeRoute === route.id;
                        return (
                          <button
                            className={active ? "is-active" : ""}
                            type="button"
                            key={route.id}
                            onClick={() => openRoute(route.id)}
                            aria-current={active ? "page" : undefined}
                            aria-label={route.label}
                          >
                            <span><Icon size={20} /></span>
                            <strong>{route.label}</strong>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>

            <button className="mobile-sign-out" type="button" onClick={() => void workspace.signOut()} disabled={workspace.busy === "logout"}>
              <LogOut size={18} />
              {workspace.busy === "logout" ? "正在退出…" : "退出登录"}
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
