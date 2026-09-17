import { errorMessage } from "@/shared/lib/app-utils";
import type { GenerateHistoryItem } from "./history-types";
import { failureSummary } from "./history-helpers";

export type HistoryActionKey = "edit" | "reuse" | "copy" | "download" | "retry";

export type HistoryActionRuntime = {
  busy: boolean;
  canRetry: boolean;
  canEdit: boolean;
  canReuse: boolean;
  canCopy: boolean;
  canDownload: boolean;
  retryDisabledReason?: string;
  onEdit: (item: GenerateHistoryItem) => void;
  onReuse: (item: GenerateHistoryItem) => void;
  onCopy: (item: GenerateHistoryItem) => void;
  onDownload: (item: GenerateHistoryItem) => void;
  onRetry: (item: GenerateHistoryItem) => void;
  setStatus: (message: string) => void;
};

/** Single entry point so both the row button and the drawer footer reuse identical guards. */
export function runHistoryAction(key: HistoryActionKey, item: GenerateHistoryItem, runtime: HistoryActionRuntime): void {
  try {
    if (runtime.busy) {
      runtime.setStatus("正在打包下载，请稍候。");
      return;
    }
    switch (key) {
      case "edit":
        if (!runtime.canEdit) {
          runtime.setStatus(runtime.retryDisabledReason || "这条历史没有可编辑的生成图。");
          return;
        }
        runtime.onEdit(item);
        return;
      case "reuse":
        if (!runtime.canReuse) {
          runtime.setStatus("当前无法复用这条记录。");
          return;
        }
        runtime.onReuse(item);
        return;
      case "copy":
        if (!runtime.canCopy) {
          runtime.setStatus("这条记录没有可复制的提示词。");
          return;
        }
        runtime.onCopy(item);
        return;
      case "download":
        if (!runtime.canDownload) {
          runtime.setStatus("这条历史没有可下载的生成图。");
          return;
        }
        runtime.onDownload(item);
        return;
      case "retry":
        if (!runtime.canRetry) {
          runtime.setStatus(runtime.retryDisabledReason || `当前无法重试：${failureSummary(item.error) || "任务状态不支持重试"}`);
          return;
        }
        runtime.onRetry(item);
        return;
      default:
        return;
    }
  } catch (error) {
    runtime.setStatus(`操作失败：${errorMessage(error)}`);
  }
}
