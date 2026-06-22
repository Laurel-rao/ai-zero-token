import { Loader2 } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AdminConfig } from "@/shared/types";
import type { BusyAction } from "@/shared/lib/app-types";
import { errorMessage } from "@/shared/lib/app-utils";
import { fetchJson } from "@/shared/api";
import { formatJson } from "@/shared/lib/format";
import { DatabaseUsersPanel } from "./components/DatabaseUsersPanel";

type ImageLimitOverrideDraft = {
  username: string;
  perUserDaily: string;
  perUserHourly: string;
  minIntervalSeconds: string;
};

function countToDraft(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function overridesFromConfig(config: AdminConfig | null): ImageLimitOverrideDraft[] {
  return (config?.settings.image?.limits?.userOverrides || []).map((item) => ({
    username: item.username,
    perUserDaily: item.perUserDaily === undefined ? "" : String(item.perUserDaily),
    perUserHourly: item.perUserHourly === undefined ? "" : String(item.perUserHourly),
    minIntervalSeconds: item.minIntervalSeconds === undefined ? "" : String(item.minIntervalSeconds),
  }));
}

function parseLimit(value: string, label: string, max = 100_000): number | null {
  const parsed = Number.parseInt(value || "0", 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${label}必须是 0 到 ${max} 之间的整数，0 表示不限制。`);
  }
  return parsed;
}

export function SettingsUsersPage(props: {
  currentUser: string | null;
  config: AdminConfig | null;
  busy: BusyAction;
  setBusy: Dispatch<SetStateAction<BusyAction>>;
  setConfig: Dispatch<SetStateAction<AdminConfig | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
}) {
  const limits = props.config?.settings.image?.limits;
  const [imageLimitOverrides, setImageLimitOverrides] = useState<ImageLimitOverrideDraft[]>(() => overridesFromConfig(props.config));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) {
      return;
    }
    setImageLimitOverrides(overridesFromConfig(props.config));
  }, [dirty, props.config]);

  const imageLimitDefaults = {
    perUserDaily: countToDraft(limits?.perUserDaily),
    perUserHourly: countToDraft(limits?.perUserHourly),
    minIntervalSeconds: countToDraft(limits?.minIntervalSeconds),
  };

  function updateOverrides(next: ImageLimitOverrideDraft[]) {
    setImageLimitOverrides(next);
    setDirty(true);
  }

  async function saveUserLimits(nextOverrides = imageLimitOverrides) {
    if (!props.config) {
      props.setStatus("网关配置尚未加载完成。");
      return;
    }

    try {
      const seen = new Set<string>();
      const userOverrides = nextOverrides.map((item) => {
        const username = item.username.trim();
        if (!username) {
          throw new Error("用户限额覆盖缺少用户名。");
        }
        if (seen.has(username)) {
          throw new Error(`用户覆盖里重复配置了 ${username}。`);
        }
        seen.add(username);
        return {
          username,
          ...(item.perUserDaily.trim() ? { perUserDaily: parseLimit(item.perUserDaily, `${username} 的 24 小时生图上限`) ?? 0 } : {}),
          ...(item.perUserHourly.trim() ? { perUserHourly: parseLimit(item.perUserHourly, `${username} 的 1 小时生图上限`) ?? 0 } : {}),
          ...(item.minIntervalSeconds.trim() ? { minIntervalSeconds: parseLimit(item.minIntervalSeconds, `${username} 的最小间隔秒数`, 86_400) ?? 0 } : {}),
        };
      });

      props.setBusy("settings");
      const next = await fetchJson<AdminConfig>("/_gateway/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: formatJson({
          image: {
            limits: {
              enabled: Boolean(limits?.enabled),
              perUserDaily: limits?.perUserDaily ?? 0,
              perUserHourly: limits?.perUserHourly ?? 0,
              minIntervalSeconds: limits?.minIntervalSeconds ?? 0,
              userOverrides,
            },
          },
        }),
      });
      props.setConfig(next);
      setImageLimitOverrides(overridesFromConfig(next));
      setDirty(false);
      props.setStatus("用户限额设置已保存。");
    } catch (error) {
      props.setStatus(errorMessage(error));
    } finally {
      props.setBusy(null);
    }
  }

  return (
    <section className="settings-page settings-users-page">
      {dirty ? (
        <div className="settings-page-actions settings-inline-actions">
          <button className="btn-primary" type="button" onClick={() => void saveUserLimits()} disabled={props.busy === "settings"}>
            {props.busy === "settings" ? <Loader2 className="spin" size={16} /> : null}
            保存用户限额
          </button>
        </div>
      ) : null}

      <DatabaseUsersPanel
        currentUser={props.currentUser}
        imageLimitDefaults={imageLimitDefaults}
        imageLimitOverrides={imageLimitOverrides}
        onImageLimitOverridesChange={updateOverrides}
        onSaveImageLimitOverrides={saveUserLimits}
        setStatus={props.setStatus}
      />
    </section>
  );
}
