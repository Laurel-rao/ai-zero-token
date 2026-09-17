import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Images, Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { formatCompactTime, formatDuration, formatJson } from "@/shared/lib/format";
import { userDisplayName } from "@/shared/lib/users";
import { copyText, errorMessage } from "@/shared/lib/app-utils";
import type { AdminConfig } from "@/shared/types";
import type { GenerateHistoryItem } from "./history-types";
import type { HistoryMenuActionKey } from "./HistoryTable";
import { failureDetailLines, failureSummary, generateStatusMeta } from "./history-helpers";

export type HistoryDetailTab = "overview" | "diagnostics";

export type HistoryDetailDrawerProps = {
  item: GenerateHistoryItem;
  isAdmin: boolean;
  config: AdminConfig | null;
  onClose: () => void;
  onOpenPreview: (item: GenerateHistoryItem, index: number) => void;
  onClickAction: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => void;
  onLoadFullRecord: (item: GenerateHistoryItem) => Promise<GenerateHistoryItem | null>;
  copiedPromptId: string | null;
  actionHint?: (key: HistoryMenuActionKey, item: GenerateHistoryItem) => string | undefined;
};

export function HistoryDetailDrawer(props: HistoryDetailDrawerProps) {
  const { item } = props;
  const [tab, setTab] = useState<HistoryDetailTab>("overview");
  const [fullItem, setFullItem] = useState<GenerateHistoryItem | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // The drawer may be reused when the selected record changes; stale diagnostics must not leak.
  useEffect(() => {
    setFullItem(null);
    setLoadError(null);
    setLoadingFull(false);
    setCopyFailed(false);
    setTab("overview");
  }, [item.id]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus();
    // A modal opened from the drawer (image preview) owns the keyboard while it is mounted.
    const hasHigherLayer = () => Boolean(document.querySelector(".modal-backdrop"));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (hasHigherLayer()) {
        return;
      }
      if (event.key === "Escape") {
        props.onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusables = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) {
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === drawerRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const statusMeta = generateStatusMeta(item.status);
  const summary = failureSummary(item.error);
  const detailLines = failureDetailLines(item.error);
  const record = fullItem ?? item;

  async function copyErrorText() {
    const ok = await copyText(item.error ?? "");
    setCopyFailed(!ok);
  }

  const diagnosticsJson = useMemo(() => {
    const request = record.request && Object.keys(record.request).length > 0 ? record.request : undefined;
    if (!request && !record.responseSummary) {
      return null;
    }
    return formatJson({ request, responseSummary: record.responseSummary });
  }, [record]);

  async function ensureFullRecord() {
    if (!props.onLoadFullRecord || fullItem || loadingFull) {
      return;
    }
    setLoadingFull(true);
    setLoadError(null);
    try {
      const next = await props.onLoadFullRecord(item);
      setFullItem(next);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoadingFull(false);
    }
  }

  function selectTab(next: HistoryDetailTab) {
    setTab(next);
    if (next === "diagnostics") {
      void ensureFullRecord();
    }
  }

  return (
    <div className="history-detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside
        className="history-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`生图记录详情：${item.prompt}`}
        tabIndex={-1}
        ref={drawerRef}
      >
        <header className="history-detail-head">
          <div>
            <strong>记录详情</strong>
            <span>{formatCompactTime(item.createdAt)} · {item.id.slice(0, 12)}</span>
          </div>
          <button className="btn-secondary" type="button" onClick={props.onClose} aria-label="关闭详情">关闭</button>
        </header>

        <div className="history-detail-tabs" role="tablist" aria-label="详情分区">
          <button
            className={tab === "overview" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            onClick={() => selectTab("overview")}
          >
            概览
          </button>
          <button
            className={tab === "diagnostics" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={tab === "diagnostics"}
            onClick={() => selectTab("diagnostics")}
          >
            完整诊断
          </button>
        </div>

        <div className="history-detail-body">
          {tab === "overview" ? (
            <>
              <section className="history-detail-block">
                <div className="history-detail-block-head">
                  <strong>状态</strong>
                  <span className={`generate-status ${statusMeta.className}`}>{statusMeta.label}</span>
                </div>
                {summary ? <p className="history-detail-failure-summary">{summary}</p> : null}
              </section>

              <section className="history-detail-block">
                <div className="history-detail-block-head">
                  <strong>提示词</strong>
                  <button className="btn-secondary" type="button" onClick={() => props.onClickAction("copy", item)}>
                    <Copy size={15} />
                    {props.copiedPromptId === item.id ? "已复制" : "复制"}
                  </button>
                </div>
                <p className="history-detail-prompt">{item.prompt || "（无提示词）"}</p>
              </section>

              <section className="history-detail-block">
                <div className="history-detail-block-head"><strong>生成图</strong></div>
                {item.images.length > 0 ? (
                  <div className="history-detail-images">
                    {item.images.map((image, index) => (
                      <button
                        className="history-detail-image"
                        type="button"
                        key={image.filename || index}
                        onClick={() => props.onOpenPreview(item, index)}
                        title={`预览第 ${index + 1} 张`}
                        aria-label={`预览第 ${index + 1} 张生成图`}
                      >
                        <img src={image.previewUrl || image.url} alt="" loading="lazy" decoding="async" />
                        <span>{index + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="history-detail-empty">这条记录没有生成图。</p>
                )}
              </section>

              <section className="history-detail-block">
                <div className="history-detail-block-head"><strong>请求信息</strong></div>
                <dl className="history-detail-fields">
                  <div><dt>生成时间</dt><dd>{formatCompactTime(item.createdAt)}</dd></div>
                  <div><dt>耗时</dt><dd>{item.durationMs > 0 ? formatDuration(item.durationMs) : "-"}</dd></div>
                  {item.waitDurationMs && item.waitDurationMs > 0
                    ? <div><dt>排队等待</dt><dd>{formatDuration(item.waitDurationMs)}</dd></div>
                    : null}
                  <div><dt>接口</dt><dd>{item.endpoint}</dd></div>
                  <div><dt>模型</dt><dd>{item.model}</dd></div>
                  <div><dt>规格</dt><dd>{item.size || item.ratio || "-"}</dd></div>
                  <div><dt>质量 / 格式</dt><dd>{item.quality || "-"} / {item.outputFormat || "-"}</dd></div>
                  {props.isAdmin ? <div><dt>用户</dt><dd>{userDisplayName(props.config, item.owner)}</dd></div> : null}
                  <div><dt>参考图</dt><dd>{item.referenceImages.length > 0 ? `${item.referenceImages.length} 张` : "无（纯文本生成）"}</dd></div>
                </dl>
              </section>
            </>
          ) : (
            <>
              <section className="history-detail-block">
                <div className="history-detail-block-head">
                  <strong>失败原因（原始）</strong>
                  {item.error ? (
                    <button className="btn-secondary" type="button" onClick={() => void copyErrorText()}>
                      <Copy size={15} />
                      {copyFailed ? "复制失败" : "复制"}
                    </button>
                  ) : null}
                </div>
                {detailLines.length > 0 ? (
                  <pre className="history-detail-pre">{detailLines.join("\n")}</pre>
                ) : (
                  <p className="history-detail-empty">这条记录没有失败信息。</p>
                )}
              </section>

              <section className="history-detail-block">
                <div className="history-detail-block-head"><strong>请求参数与响应摘要</strong></div>
                {loadError ? <p className="history-detail-empty">读取完整记录失败：{loadError}</p> : null}
                {loadingFull ? (
                  <p className="history-detail-empty">正在读取完整记录...</p>
                ) : diagnosticsJson ? (
                  <pre className="history-detail-pre">{diagnosticsJson}</pre>
                ) : (
                  <p className="history-detail-empty">这条记录没有保存请求参数或响应摘要。</p>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="history-detail-footer">
          <button
            className="btn-secondary"
            type="button"
            onClick={() => props.onClickAction("download", item)}
            disabled={Boolean(props.actionHint?.("download", item))}
            title={props.actionHint?.("download", item)}
          >
            <Download size={15} />
            {item.images.length > 1 ? `下载全部 ${item.images.length} 张` : "下载图片"}
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => props.onClickAction("edit", item)}
            disabled={Boolean(props.actionHint?.("edit", item))}
            title={props.actionHint?.("edit", item)}
          >
            <Pencil size={15} />
            编辑首张
          </button>
          <button className="btn-secondary" type="button" onClick={() => props.onClickAction("reuse", item)}>
            <RotateCcw size={15} />
            再次使用
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={() => props.onClickAction("retry", item)}
            disabled={Boolean(props.actionHint?.("retry", item))}
            title={props.actionHint?.("retry", item)}
          >
            <RefreshCw size={15} />
            重试
          </button>
          {item.images.length === 0 ? <span className="history-detail-footnote"><Images size={13} aria-hidden="true" />无生成图，仅可重试或复用提示词</span> : null}
        </footer>
      </aside>
    </div>
  );
}
