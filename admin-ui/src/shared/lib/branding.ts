import defaultAppMark from "@/assets/app-mark.svg";
import type { GatewaySettings } from "@/shared/types";

export type BrandingSettings = GatewaySettings["branding"];

export const DEFAULT_BRANDING: BrandingSettings = {
  title: "AI Zero Token",
  appIconUrl: "",
  faviconUrl: "",
};

export function normalizeBranding(branding?: Partial<BrandingSettings> | null): BrandingSettings {
  return {
    title: branding?.title?.trim() || DEFAULT_BRANDING.title,
    appIconUrl: branding?.appIconUrl?.trim() || DEFAULT_BRANDING.appIconUrl,
    faviconUrl: branding?.faviconUrl?.trim() || DEFAULT_BRANDING.faviconUrl,
  };
}

export function getAppIconUrl(branding?: Partial<BrandingSettings> | null): string {
  return normalizeBranding(branding).appIconUrl || defaultAppMark;
}

export function applyBranding(branding?: Partial<BrandingSettings> | null) {
  const normalized = normalizeBranding(branding);
  document.title = normalized.title;

  const href = normalized.faviconUrl || normalized.appIconUrl || defaultAppMark;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}
