import type { AdminConfig } from "@/shared/types";

export function userDisplayName(config: AdminConfig | null | undefined, username: string | null | undefined): string {
  if (!username) {
    return "-";
  }
  const user = config?.users?.find((item) => item.username === username);
  return user?.displayName?.trim() || username;
}

export function userOptionLabel(config: AdminConfig | null | undefined, username: string, currentUser?: string | null): string {
  const label = userDisplayName(config, username);
  const suffix = username === currentUser ? "（我）" : "";
  return label === username ? `${label}${suffix}` : `${label}${suffix} · ${username}`;
}
