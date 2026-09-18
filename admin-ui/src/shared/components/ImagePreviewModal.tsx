import { Check, ChevronLeft, ChevronRight, Copy, Download, LoaderCircle, Maximize2, Minimize2, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Modal } from "./Modal";
import type { ModalImage, ModalImageItem } from "@/shared/lib/app-types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.25;

/** Smallest stage the modal is allowed to shrink to, so controls stay usable. */
const MIN_STAGE_EDGE = 160;
/** Viewport gutter kept around the dialog on every side; mirrors the CSS `calc(100vw - 40px)`. */
const VIEWPORT_GUTTER = 20;
/** The modal card keeps a 1px border on each side. */
const CARD_BORDER = 2;
/** Sub-pixel slack so a rounded size never triggers a scrollbar. */
const FIT_SLACK = 1;
/** Widest the preview dialog grows to, even on very wide displays; keep in sync with image-preview.css. */
const PREVIEW_MAX_WIDTH = 1360;
/** Narrowest dialog worth rendering, so the header toolbar still has room. */
const MIN_CARD_WIDTH = 360;
/** Space reserved for the header metadata so it stays readable instead of collapsing. */
const META_MIN_WIDTH = 150;

function parseAspectRatio(value?: string): number | null {
  const normalized = value?.trim();
  const match = normalized?.match(/^(\d+(?:\.\d+)?)\s*[:xX/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

/** Fit a box of the given width/height ratio into the available space, keeping the ratio intact. */
function fitInside(availableWidth: number, availableHeight: number, ratio: number): { width: number; height: number } {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const maxWidth = Math.max(1, availableWidth);
  const maxHeight = Math.max(1, availableHeight);
  let height = maxHeight;
  let width = height * safeRatio;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / safeRatio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("图片格式转换失败"));
    }, "image/png");
  });
}

async function convertImageToPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") {
    return blob;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器无法处理图片格式");
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      return canvasToPng(canvas);
    } catch {
      // Safari and some embedded browsers cannot decode every format with createImageBitmap.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = objectUrl;
    });
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0);
    return canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function ImagePreviewModal(props: { image: ModalImage; onClose: () => void }) {
  const gallery = useMemo<ModalImageItem[]>(() => {
    const items = props.image.gallery?.length ? props.image.gallery : [props.image];
    return items.map((item) => ({
      src: item.src,
      meta: item.meta,
      filename: item.filename,
      ratio: item.ratio,
      placeholderSrc: item.placeholderSrc,
    }));
  }, [props.image]);
  const initialIndex = Math.min(Math.max(props.image.index ?? 0, 0), Math.max(gallery.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const activeImage = gallery[activeIndex] ?? gallery[0] ?? props.image;
  const hasGalleryNavigation = gallery.length > 1;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
  const hasPlaceholder = Boolean(activeImage.placeholderSrc && activeImage.placeholderSrc !== activeImage.src);
  const [imageLoaded, setImageLoaded] = useState(!hasPlaceholder);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** Measured natural ratio of the decoded file; preferred over the declared ratio when available. */
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
  /** Natural pixel size, used to avoid upscaling a small image beyond 100%. */
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  /** Stage box computed from the live viewport so the image always fills the available space. */
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  /** Dialog width that hugs the fitted image, clamped to the viewport. */
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  const placeholderStyle = hasPlaceholder && !imageLoaded
    ? { backgroundImage: `url("${activeImage.placeholderSrc}")` }
    : undefined;
  const declaredRatio = useMemo(() => parseAspectRatio(activeImage.ratio), [activeImage.ratio]);
  const displayRatio = naturalRatio ?? declaredRatio ?? 1;
  const stageStyle = useMemo<CSSProperties | undefined>(() => {
    if (isFullscreen || !stageSize) {
      return undefined;
    }
    return { width: `${stageSize.width}px`, height: `${stageSize.height}px` };
  }, [isFullscreen, stageSize]);
  const imageStyle = useMemo<CSSProperties>(() => {
    const transform = `rotate(${rotation}deg) scale(${zoom})`;
    // A quarter turn swaps the footprint, so the element is sized on swapped axes
    // and the rotated result exactly fills the stage it was fitted for.
    if (isQuarterTurn && !isFullscreen && stageSize) {
      return { width: `${stageSize.height}px`, height: `${stageSize.width}px`, maxWidth: "none", maxHeight: "none", transform };
    }
    return { transform };
  }, [isFullscreen, isQuarterTurn, rotation, stageSize, zoom]);
  const modalStyle = useMemo<CSSProperties | undefined>(() => {
    if (isFullscreen || !cardWidth) {
      return undefined;
    }
    return { "--preview-card-width": `${cardWidth}px` } as CSSProperties;
  }, [isFullscreen, cardWidth]);

  const resetView = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  const showCopyFeedback = (tone: "success" | "error", message: string) => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopyFeedback({ tone, message });
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, tone === "success" ? 2200 : 4200);
  };

  const copyActiveImage = async () => {
    if (isCopying) {
      return;
    }
    if (!window.isSecureContext) {
      showCopyFeedback("error", "当前页面不是安全环境，请使用 HTTPS 后复制");
      return;
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      showCopyFeedback("error", "当前浏览器不支持复制图片");
      return;
    }

    setIsCopying(true);
    setCopyFeedback(null);
    try {
      const pngBlob = fetch(activeImage.src, { credentials: "include" }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`图片读取失败（${response.status}）`);
        }
        const sourceBlob = await response.blob();
        if (!sourceBlob.type.startsWith("image/")) {
          throw new Error("读取到的内容不是图片");
        }
        return convertImageToPng(sourceBlob);
      });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
      showCopyFeedback("success", "图片已复制，可直接粘贴");
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "复制失败，请检查浏览器剪贴板权限";
      showCopyFeedback("error", message);
    } finally {
      setIsCopying(false);
    }
  };

  const updateZoom = (nextZoom: number) => {
    const clamped = clampZoom(nextZoom);
    setZoom(clamped);
    if (clamped <= 1) {
      setOffset({ x: 0, y: 0 });
    }
  };

  const showPrevious = () => {
    if (!hasGalleryNavigation) {
      return;
    }
    setActiveIndex((value) => (value - 1 + gallery.length) % gallery.length);
  };

  const showNext = () => {
    if (!hasGalleryNavigation) {
      return;
    }
    setActiveIndex((value) => (value + 1) % gallery.length);
  };

  useEffect(() => {
    setActiveIndex(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    resetView();
    setImageLoaded(!hasPlaceholder);
    setImageLoadFailed(false);
    setCopyFeedback(null);
  }, [activeImage.src, hasPlaceholder]);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  // Reset the measured ratio whenever another image becomes active.
  useEffect(() => {
    setNaturalRatio(null);
    setNaturalSize(null);
  }, [activeImage.src]);

  // Keep the stage in sync with the visible viewport instead of a fixed pixel size.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const body = stage?.parentElement;
    if (!stage || !body) {
      return;
    }
    const header = body.previousElementSibling instanceof HTMLElement ? body.previousElementSibling : null;
    const backdrop = body.closest(".modal-backdrop");
    const card = body.closest(".modal-card");

    let frame = 0;

    const measure = () => {
      frame = 0;
      if (isFullscreen) {
        return;
      }
      const bodyStyle = window.getComputedStyle(body);
      const paddingX = px(bodyStyle.paddingLeft) + px(bodyStyle.paddingRight);
      const paddingY = px(bodyStyle.paddingTop) + px(bodyStyle.paddingBottom);
      // Derive the budget from the backdrop's content box and the header only.
      // It never depends on the stage, so the computation cannot feed back into itself.
      const backdropStyle = backdrop ? window.getComputedStyle(backdrop) : null;
      const outerX = backdropStyle ? px(backdropStyle.paddingLeft) + px(backdropStyle.paddingRight) : VIEWPORT_GUTTER * 2;
      const outerY = backdropStyle ? px(backdropStyle.paddingTop) + px(backdropStyle.paddingBottom) : VIEWPORT_GUTTER * 2;
      const availableWidth = (backdrop?.clientWidth ?? window.innerWidth) - outerX;
      const availableHeight = (backdrop?.clientHeight ?? window.innerHeight) - outerY;
      const maxCardWidth = Math.min(PREVIEW_MAX_WIDTH, availableWidth);
      const maxStageWidth = maxCardWidth - CARD_BORDER - paddingX;
      const maxStageHeight = availableHeight - CARD_BORDER - (header?.getBoundingClientRect().height ?? 0) - paddingY;
      const rotationRatio = isQuarterTurn ? 1 / displayRatio : displayRatio;
      const fitted = fitInside(maxStageWidth, maxStageHeight, rotationRatio);
      // Never upscale past 100%: a small image keeps its natural size, and the
      // dialog then hugs that smaller box instead of leaving dead space around it.
      const naturalBox = naturalSize && !isQuarterTurn
        ? { width: naturalSize.width, height: naturalSize.height }
        : naturalSize
          ? { width: naturalSize.height, height: naturalSize.width }
          : null;
      const capped = naturalBox
        ? { width: Math.min(fitted.width, naturalBox.width), height: Math.min(fitted.height, naturalBox.height) }
        : fitted;
      // Prefer the fitted box; only fall back to the minimum edge when it still fits.
      const width = Math.max(1, Math.min(Math.max(capped.width - FIT_SLACK, MIN_STAGE_EDGE), maxStageWidth));
      const height = Math.max(1, Math.min(Math.max(capped.height - FIT_SLACK, MIN_STAGE_EDGE), maxStageHeight));
      // The dialog hugs the image, but must still be wide enough to keep the title
      // and the whole toolbar on one line (the meta text alone may ellipsize).
      const toolbar = header?.querySelector<HTMLElement>(".image-preview-toolbar");
      const closeButton = header?.querySelector<HTMLElement>("button.btn-secondary");
      const title = header?.querySelector<HTMLElement>("h3");
      const headerStyle = header ? window.getComputedStyle(header) : null;
      const headerChrome = headerStyle
        ? px(headerStyle.paddingLeft) + px(headerStyle.paddingRight) + px(headerStyle.columnGap) * 2
        : 0;
      const minHeaderWidth = (title?.scrollWidth ?? 0) + (toolbar?.scrollWidth ?? 0) + (closeButton?.getBoundingClientRect().width ?? 0) + headerChrome;
      const requiredWidth = Math.max(MIN_CARD_WIDTH, width + paddingX + CARD_BORDER);
      // Reserve some room for the metadata line so it stays readable; it ellipsizes
      // inside that space instead of pushing the toolbar out.
      const cardWidth = Math.min(Math.max(requiredWidth, minHeaderWidth + META_MIN_WIDTH), maxCardWidth);

      setStageSize((current) => (current && current.width === width && current.height === height ? current : { width, height }));
      setCardWidth((current) => (current === cardWidth ? current : cardWidth));
    };

    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("orientationchange", schedule);
    // Also react to header wrapping and toolbar reflow, not just viewport resizes.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(body);
    if (header) {
      observer?.observe(header);
    }
    if (backdrop) {
      observer?.observe(backdrop);
    }
    if (card) {
      observer?.observe(card);
    }

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      observer?.disconnect();
    };
  }, [displayRatio, isFullscreen, isQuarterTurn, naturalSize, copyFeedback, hasGalleryNavigation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isFullscreen) {
          setIsFullscreen(false);
          return;
        }
        props.onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        updateZoom(zoom + ZOOM_STEP);
      }
      if (event.key === "-") {
        event.preventDefault();
        updateZoom(zoom - ZOOM_STEP);
      }
      if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        setRotation((value) => value + 90);
      }
      if (event.key === "ArrowLeft" && hasGalleryNavigation) {
        event.preventDefault();
        showPrevious();
      }
      if (event.key === "ArrowRight" && hasGalleryNavigation) {
        event.preventDefault();
        showNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasGalleryNavigation, isFullscreen, props, zoom]);

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    updateZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || event.button !== 0) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: offset.x,
      y: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: drag.x + event.clientX - drag.startX,
      y: drag.y + event.clientY - drag.startY,
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  return (
    <Modal
      title="图片预览"
      onClose={props.onClose}
      wide
      style={modalStyle}
      className={`image-preview-modal${isFullscreen ? " is-fullscreen" : ""}`}
      headerContent={(
        <>
          <div className="image-preview-header-meta">
            <span>{activeImage.meta}</span>
            <span>{hasGalleryNavigation ? `${activeIndex + 1}/${gallery.length} · ` : ""}{normalizedRotation === 0 ? "0deg" : `${normalizedRotation}deg`}</span>
          </div>
          <div className="image-preview-toolbar" aria-label="图片查看工具栏">
            <button className="image-preview-tool" type="button" onClick={() => updateZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} title="缩小" aria-label="缩小">
              <ZoomOut size={16} />
            </button>
            <span className="image-preview-zoom">{Math.round(zoom * 100)}%</span>
            <button className="image-preview-tool" type="button" onClick={() => updateZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} title="放大" aria-label="放大">
              <ZoomIn size={16} />
            </button>
            <button className="image-preview-tool" type="button" onClick={() => setRotation((value) => value - 90)} title="向左旋转" aria-label="向左旋转">
              <RotateCcw size={16} />
            </button>
            <button className="image-preview-tool" type="button" onClick={() => setRotation((value) => value + 90)} title="向右旋转" aria-label="向右旋转">
              <RotateCw size={16} />
            </button>
            <button
              className="image-preview-tool"
              type="button"
              onClick={() => setIsFullscreen((value) => !value)}
              title={isFullscreen ? "退出全屏" : "全屏查看"}
              aria-label={isFullscreen ? "退出全屏" : "全屏查看"}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              className={`image-preview-tool${copyFeedback?.tone === "success" ? " is-success" : ""}`}
              type="button"
              onClick={() => void copyActiveImage()}
              disabled={isCopying}
              title={isCopying ? "正在复制图片" : copyFeedback?.tone === "success" ? "图片已复制" : "复制图片"}
              aria-label={isCopying ? "正在复制图片" : copyFeedback?.tone === "success" ? "图片已复制" : "复制图片"}
            >
              {isCopying ? <LoaderCircle className="spin" size={16} /> : copyFeedback?.tone === "success" ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <a className="image-preview-tool" href={activeImage.src} download={activeImage.filename || "generated-image.png"} title="下载图片" aria-label="下载图片">
              <Download size={16} />
            </a>
          </div>
        </>
      )}
    >
      {isFullscreen ? (
        <button
          className="image-preview-fullscreen-close"
          type="button"
          onClick={props.onClose}
          title="关闭图片预览"
          aria-label="关闭图片预览"
        >
          <X size={22} />
        </button>
      ) : null}
      <div
        ref={stageRef}
        className={`image-preview-stage ${zoom > 1 ? "is-zoomed" : ""} ${isQuarterTurn ? "is-quarter-turn" : ""} ${isFullscreen ? "is-fullscreen-stage" : ""}`}
        style={stageStyle}
        onDoubleClick={() => {
          if (isFullscreen) {
            setIsFullscreen(false);
          }
        }}
        onWheel={handleWheel}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {hasGalleryNavigation ? (
          <>
            <button className="image-preview-nav is-prev" type="button" onClick={showPrevious} onPointerDown={(event) => event.stopPropagation()} title="上一张" aria-label="上一张">
              <ChevronLeft size={24} />
            </button>
            <button className="image-preview-nav is-next" type="button" onClick={showNext} onPointerDown={(event) => event.stopPropagation()} title="下一张" aria-label="下一张">
              <ChevronRight size={24} />
            </button>
          </>
        ) : null}
        <div className="image-preview-pan" style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`, ...placeholderStyle }}>
          <img
            src={activeImage.src}
            alt={activeImage.filename || "图片预览"}
            draggable={false}
            className={hasPlaceholder && !imageLoaded ? "is-loading-original" : undefined}
            decoding="async"
            onLoad={(event) => {
              const target = event.currentTarget;
              if (target.naturalWidth > 0 && target.naturalHeight > 0) {
                setNaturalRatio(target.naturalWidth / target.naturalHeight);
                setNaturalSize({ width: target.naturalWidth, height: target.naturalHeight });
              }
              setImageLoaded(true);
              setImageLoadFailed(false);
            }}
            onError={() => {
              setImageLoaded(false);
              setImageLoadFailed(true);
            }}
            style={imageStyle}
          />
        </div>
        {hasPlaceholder && !imageLoaded && !imageLoadFailed ? (
          <span className="image-preview-loading">正在加载原图...</span>
        ) : null}
        {imageLoadFailed ? <span className="image-preview-loading is-error">原图加载失败，正在显示预览图</span> : null}
        {copyFeedback ? (
          <span className={`image-preview-copy-feedback is-${copyFeedback.tone}`} role="status" aria-live="polite">
            {copyFeedback.message}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
