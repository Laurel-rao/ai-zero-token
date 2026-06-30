import { ChevronLeft, ChevronRight, Download, Maximize2, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Modal } from "./Modal";
import type { ModalImage, ModalImageItem } from "@/shared/lib/app-types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.25;

function ratioClassName(value?: string): string {
  const normalized = value?.trim();
  const match = normalized?.match(/^(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio < 0.75) return "ratio-tall";
      if (ratio > 1.45) return "ratio-wide";
      if (ratio > 1.15) return "ratio-classic";
      return "ratio-square";
    }
  }

  if (normalized === "16:9") return "ratio-wide";
  if (normalized === "9:16") return "ratio-tall";
  if (normalized === "4:3") return "ratio-classic";
  return "ratio-square";
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

export function ImagePreviewModal(props: { image: ModalImage; onClose: () => void }) {
  const gallery = useMemo<ModalImageItem[]>(() => {
    const items = props.image.gallery?.length ? props.image.gallery : [props.image];
    return items.map((item) => ({
      src: item.src,
      meta: item.meta,
      filename: item.filename,
      ratio: item.ratio,
    }));
  }, [props.image]);
  const initialIndex = Math.min(Math.max(props.image.index ?? 0, 0), Math.max(gallery.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const activeImage = gallery[activeIndex] ?? gallery[0] ?? props.image;
  const hasGalleryNavigation = gallery.length > 1;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;

  const resetView = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
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
  }, [activeImage.src]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [hasGalleryNavigation, props, zoom]);

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
    <Modal title="图片预览" onClose={props.onClose} wide>
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
        <button className="image-preview-tool" type="button" onClick={resetView} title="重置视图" aria-label="重置视图">
          <Maximize2 size={16} />
        </button>
        <a className="image-preview-tool" href={activeImage.src} download={activeImage.filename || "generated-image.png"} title="下载图片" aria-label="下载图片">
          <Download size={16} />
        </a>
      </div>
      <div
        className={`image-preview-stage ${ratioClassName(activeImage.ratio)} ${zoom > 1 ? "is-zoomed" : ""} ${isQuarterTurn ? "is-quarter-turn" : ""}`}
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
        <div className="image-preview-pan" style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}>
          <img
            src={activeImage.src}
            alt={activeImage.filename || "图片预览"}
            draggable={false}
            style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }}
          />
        </div>
      </div>
      <div className="preview-modal-meta">
        <span>{activeImage.meta}</span>
        <span>{hasGalleryNavigation ? `${activeIndex + 1}/${gallery.length} · ` : ""}{normalizedRotation === 0 ? "0deg" : `${normalizedRotation}deg`}</span>
      </div>
    </Modal>
  );
}
