import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Check, Copy, Download, ImagePlus, Images, Loader2, MoreHorizontal, Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { formatCompactTime, formatDuration } from "@/shared/lib/format";
import { userDisplayName } from "@/shared/lib/users";
import type { AdminConfig } from "@/shared/types";
import type { GenerateHistoryItem } from "./history-types";
import { failureSummary, generateStatusMeta, ratioClassName } from "./history-helpers";

export type HistoryMenuActionKey = "edit" | "reuse" | "copy" | "download" | "retry" | "detail";

export type HistoryTableProps = {
  items: GenerateHistoryItem[];
  isAdmin: boolean;
  config: AdminConfig | null;
  loading: boolean;
  bulkDownloading: boolean;
  selectedIds: Set<string>;
  allSelectableSelected: boolean;
  someSelectableSelected: boolean;
  onToggleSelect: (item: GenerateHistoryItem) => void;
  onToggleSelectAll: () => void;
  onOpenPreview: (item: GenerateHistoryItem, index: number) => void;
  onOpenDetail: (item: GenerateHistoryItem) => void;
  onMenuAction: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => void;
  actionHint?: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => string | undefined;
};

const MENU_ITEMS: Array<{ key: HistoryMenuActionKey; label: string; icon: typeof Pencil }> = [
  { key: "edit", label: "编辑首张", icon: Pencil },
  { key: "reuse", label: "再次使用", icon: RotateCcw },
  { key: "copy", label: "复制提示词", icon: Copy },
  { key: "download", label: "下载图片", icon: Download },
  { key: "retry", label: "重试", icon: RefreshCw },
  { key: "detail", label: "查看详情", icon: Images },
];

function menuItemsFor(item: GenerateHistoryItem) {
  const hasImages = item.images.length > 0;
  const failed = item.status === "failed" || item.status === "interrupted";
  return MENU_ITEMS
    .filter((entry) => (entry.key === "edit" || entry.key === "download" ? hasImages : true))
    .filter((entry) => (entry.key === "retry" ? failed : true))
    .map((entry) => (entry.key === "download" && item.images.length > 1
      ? { ...entry, label: `下载全部（${item.images.length} 张）` }
      : entry));
}

function specLabel(item: GenerateHistoryItem): string {
  const firstImage = item.images[0];
  const dimension = firstImage?.width && firstImage?.height ? `${firstImage.width}×${firstImage.height}` : item.ratio || item.size || "-";
  return item.images.length > 1 ? `${dimension} · ${item.images.length} 张` : dimension;
}

function RowMenu(props: {
  item: GenerateHistoryItem;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAction: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => void;
  actionHint?: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => string | undefined;
}) {
  const { item, open } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = props.onClose;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [close, open]);

  return (
    <div className="generate-history-row-menu" ref={rootRef}>
      <button
        className={`generate-history-icon-btn ${open ? "is-open" : ""}`}
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`更多操作：${item.prompt}`}
        title="更多操作"
        onClick={props.onToggle}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            props.onClose();
            triggerRef.current?.focus();
          }
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="generate-history-row-menu-panel" role="menu" aria-label="记录操作">
          {menuItemsFor(item).map((entry) => {
            const Icon = entry.icon;
            const hint = props.actionHint?.(entry.key, item);
            return (
              <button
                className="generate-history-row-menu-item"
                type="button"
                role="menuitem"
                key={entry.key}
                disabled={Boolean(hint)}
                title={hint}
                onClick={() => props.onAction(entry.key, item)}
              >
                <Icon size={15} aria-hidden="true" />
                {entry.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Shared grid-mode thumbnail strip; the list view uses its own single-thumb cell. */
export function HistoryPreviewThumb(props: {
  item: GenerateHistoryItem;
  onOpen: (item: GenerateHistoryItem, index: number) => void;
}) {
  const { item } = props;
  const visible = item.images.slice(0, 4);
  return (
    <div className={`generate-history-thumbs ${item.images.length > 1 ? "is-multiple" : ""}`}>
      {visible.length > 0 ? visible.map((image, index) => (
        <button
          className={`generate-history-thumb ${item.images.length === 1 ? ratioClassName(item.ratio || item.size) : ""}`}
          type="button"
          key={image.filename || index}
          onClick={() => props.onOpen(item, index)}
          title={`预览第 ${index + 1} 张生成图`}
          aria-label={`预览第 ${index + 1} 张生成图：${item.prompt}`}
        >
          <img src={image.previewUrl || image.url} alt={`${item.prompt} - 第 ${index + 1} 张`} loading="lazy" decoding="async" />
          {item.images.length > 1 ? <span>{index + 1}</span> : null}
        </button>
      )) : (
        <div className="generate-history-thumb is-empty" aria-hidden="true">
          <ImagePlus size={28} />
        </div>
      )}
      {item.images.length > 4 ? <span className="generate-history-more">+{item.images.length - 4}</span> : null}
    </div>
  );
}

export function HistoryTable(props: HistoryTableProps) {  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const closeMenu = useCallback(() => setOpenMenuId(null), []);

  useEffect(() => {
    if (openMenuId && !props.items.some((item) => item.id === openMenuId)) {
      closeMenu();
    }
  }, [closeMenu, openMenuId, props.items]);

  function handleGridKeyDown(event: ReactKeyboardEvent<HTMLTableElement>) {
    if (event.key === "Escape") {
      if (openMenuId) {
        event.stopPropagation();
        closeMenu();
      }
      return;
    }
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    const rows = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr.generate-history-table-row") ?? []);
    const index = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement));
    if (index < 0) return;
    const next = event.key === "ArrowUp" ? rows[index - 1] : rows[index + 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  function handleRowClick(event: ReactMouseEvent<HTMLTableRowElement>, item: GenerateHistoryItem) {
    closeMenu();
    if ((event.target as HTMLElement).closest("button, a, input, label")) {
      return;
    }
    props.onOpenDetail(item);
  }

  return (
    <div className="generate-history-table-wrap">
      <table className="generate-history-table" ref={tableRef} onKeyDown={handleGridKeyDown}>
        <caption className="generate-visually-hidden">
          {props.isAdmin ? "生图历史列表，可筛选全部用户" : "我的生图历史列表"}
        </caption>
        <colgroup>
          <col className="col-select" />
          <col className="col-preview" />
          <col className="col-status" />
          <col className="col-prompt" />
          <col className="col-time" />
          <col className="col-spec" />
          <col className="col-duration" />
          {props.isAdmin ? <col className="col-user" /> : null}
          <col className="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="generate-history-th is-select">
              <label className="generate-history-table-select-all" title="本页全选">
                <input
                  type="checkbox"
                  checked={props.allSelectableSelected}
                  ref={(element) => {
                    if (element) element.indeterminate = props.someSelectableSelected;
                  }}
                  onChange={props.onToggleSelectAll}
                  disabled={props.items.length === 0 || props.bulkDownloading}
                  aria-label="本页全选可下载记录"
                />
              </label>
            </th>
            <th scope="col" className="generate-history-th is-preview">预览</th>
            <th scope="col" className="generate-history-th is-status">状态</th>
            <th scope="col" className="generate-history-th is-prompt">提示词</th>
            <th scope="col" className="generate-history-th is-time">生成时间</th>
            <th scope="col" className="generate-history-th is-spec">规格</th>
            <th scope="col" className="generate-history-th is-duration">耗时</th>
            {props.isAdmin ? <th scope="col" className="generate-history-th is-user">用户</th> : null}
            <th scope="col" className="generate-history-th is-actions">
              <span className="generate-visually-hidden">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => {
            const statusMeta = generateStatusMeta(item.status);
            const selectable = item.status === "success" && item.images.length > 0;
            const selected = props.selectedIds.has(item.id);
            const summary = failureSummary(item.error);
            const firstImage = item.images[0];
            const waitDuration = item.waitDurationMs && item.waitDurationMs > 0 ? item.waitDurationMs : 0;

            return (
              <tr
                className={`generate-history-table-row ${selected ? "is-selected" : ""} ${summary ? "is-failed" : ""}`}
                key={item.id}
                tabIndex={0}
                aria-label={`${statusMeta.label}：${item.prompt}`}
                onClick={(event) => handleRowClick(event, item)}
              >
                <td className="generate-history-td is-select">
                  {selectable ? (
                    <label className="generate-history-row-select" title={selected ? "取消选择" : "选择此记录"}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => props.onToggleSelect(item)}
                        disabled={props.bulkDownloading}
                        aria-label={`${selected ? "取消选择" : "选择"}：${item.prompt}`}
                      />
                    </label>
                  ) : (
                    <span className="generate-history-select-placeholder" aria-hidden="true">·</span>
                  )}
                </td>

                <td className="generate-history-td is-preview">
                  <button
                    className="generate-history-row-thumb"
                    type="button"
                    onClick={() => props.onOpenPreview(item, 0)}
                    disabled={!firstImage}
                    title={firstImage ? (item.images.length > 1 ? `预览（共 ${item.images.length} 张）` : "预览生成图") : "没有可预览的生成图"}
                    aria-label={firstImage ? `预览生成图：${item.prompt}` : `没有可预览的生成图：${item.prompt}`}
                  >
                    {firstImage ? (
                      <img src={firstImage.previewUrl || firstImage.url} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <ImagePlus size={15} aria-hidden="true" />
                    )}
                    {item.images.length > 1 ? <span className="generate-history-row-thumb-count">+{item.images.length - 1}</span> : null}
                  </button>
                </td>

                <td className="generate-history-td is-status">
                  <span className={`generate-status generate-history-status ${statusMeta.className}`}>{statusMeta.label}</span>
                </td>

                <td className="generate-history-td is-prompt">
                  <div className="generate-history-prompt-cell">
                    <span className="generate-history-prompt" title={item.prompt} data-full-prompt={item.prompt}>
                      {item.prompt || "（无提示词）"}
                    </span>
                    {summary ? (
                      <button
                        className="generate-history-failure"
                        type="button"
                        title={`${summary}（点击查看完整诊断）`}
                        onClick={() => props.onOpenDetail(item)}
                        aria-label={`失败原因：${summary}，查看完整诊断`}
                      >
                        <span className="generate-history-failure-dot" aria-hidden="true" />
                        <span className="generate-history-failure-text">{summary}</span>
                      </button>
                    ) : null}
                  </div>
                </td>

                <td className="generate-history-td is-time">
                  <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString("zh-CN")}>
                    {formatCompactTime(item.createdAt)}
                  </time>
                </td>

                <td className="generate-history-td is-spec">
                  <span className="generate-history-ellipsis" title={specLabel(item)}>{specLabel(item)}</span>
                </td>

                <td className="generate-history-td is-duration">
                  <span className="generate-history-duration-main">{item.durationMs > 0 ? formatDuration(item.durationMs) : "-"}</span>
                  {waitDuration > 0 ? <span className="generate-history-duration-sub">等待 {formatDuration(waitDuration)}</span> : null}
                </td>

                {props.isAdmin ? (
                  <td className="generate-history-td is-user">
                    <span className="generate-history-ellipsis" title={item.owner || ""}>{userDisplayName(props.config, item.owner)}</span>
                  </td>
                ) : null}

                <td className="generate-history-td is-actions">
                  <div className="generate-history-row-actions">
                    {summary ? (
                      <button
                        className="generate-history-icon-btn is-primary"
                        type="button"
                        onClick={() => props.onMenuAction("retry", item)}
                        disabled={Boolean(props.actionHint?.("retry", item))}
                        title={props.actionHint?.("retry", item) ?? "沿用原提示词和生成参数重试"}
                        aria-label={`重试：${item.prompt}`}
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        className="generate-history-icon-btn"
                        type="button"
                        onClick={() => props.onMenuAction("download", item)}
                        disabled={!firstImage || Boolean(props.actionHint?.("download", item))}
                        title={firstImage
                          ? (item.images.length > 1 ? `下载全部 ${item.images.length} 张` : "下载图片")
                          : "没有可下载的生成图"}
                        aria-label={item.images.length > 1 ? `下载全部 ${item.images.length} 张：${item.prompt}` : `下载图片：${item.prompt}`}
                      >
                        <Download size={15} aria-hidden="true" />
                      </button>
                    )}
                    <RowMenu
                      item={item}
                      open={openMenuId === item.id}
                      onToggle={() => setOpenMenuId((current) => (current === item.id ? null : item.id))}
                      onClose={closeMenu}
                      onAction={(key, target) => {
                        closeMenu();
                        props.onMenuAction(key, target);
                      }}
                      actionHint={props.actionHint}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.loading ? (
        <div className="generate-history-table-loading" role="status">
          <Loader2 className="spin" size={18} />
          <span>正在读取服务端历史...</span>
        </div>
      ) : null}
      {!props.loading && props.selectedIds.size > 0 ? (
        <div className="generate-history-table-hint" role="status">
          <Check size={14} aria-hidden="true" />
          <span>已跨页选中 {props.selectedIds.size} 条记录</span>
        </div>
      ) : null}
    </div>
  );
}
