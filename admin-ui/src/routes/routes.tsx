import { BarChart3, BookOpenText, Home, Image, ImageUp, LayoutDashboard, ListChecks, Settings, ShieldCheck, UserCog, Users, Wifi, type LucideIcon } from "lucide-react";

export type AppRoute = "launch" | "overview" | "accounts" | "generate" | "usage" | "tester" | "image-bed" | "docs" | "network" | "logs" | "settings" | "settings-users";
export type UserRole = "admin" | "user";

export type NavRoute = {
  id: AppRoute;
  label: string;
  icon: LucideIcon;
  parentId?: AppRoute;
};

export const routes: NavRoute[] = [
  { id: "launch", label: "启动页", icon: Home },
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "accounts", label: "账号管理", icon: Users },
  { id: "generate", label: "生图", icon: Image },
  { id: "usage", label: "用量统计", icon: BarChart3 },
  { id: "tester", label: "接口测试", icon: ShieldCheck },
  { id: "image-bed", label: "图床上传", icon: ImageUp },
  { id: "docs", label: "使用文档", icon: BookOpenText },
  { id: "network", label: "网络检测", icon: Wifi },
  { id: "logs", label: "请求日志", icon: ListChecks },
  { id: "settings", label: "系统设置", icon: Settings },
  { id: "settings-users", label: "用户管理", icon: UserCog, parentId: "settings" },
];

const userRoutes = new Set<AppRoute>(["generate", "logs"]);

export function normalizeUserRole(role?: string | null): UserRole {
  return role === "user" ? "user" : "admin";
}

export function visibleRoutesForRole(role?: string | null): NavRoute[] {
  const normalized = normalizeUserRole(role);
  return normalized === "user" ? routes.filter((route) => userRoutes.has(route.id)) : routes;
}

export function canAccessRoute(route: AppRoute, role?: string | null): boolean {
  return normalizeUserRole(role) === "admin" || userRoutes.has(route);
}

export function defaultRouteForRole(role?: string | null): AppRoute {
  return normalizeUserRole(role) === "user" ? "generate" : "accounts";
}

export function routeFromHashValue(value: string, role?: string | null): AppRoute {
  const route = routes.some((item) => item.id === value) ? (value as AppRoute) : defaultRouteForRole(role);
  return canAccessRoute(route, role) ? route : defaultRouteForRole(role);
}

export function readRouteFromHash(role?: string | null): AppRoute {
  const value = window.location.hash.replace(/^#\/?/, "");
  return routeFromHashValue(value, role);
}
