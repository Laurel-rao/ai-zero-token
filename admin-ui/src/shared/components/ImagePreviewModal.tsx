import { Download } from "lucide-react";
import { Modal } from "./Modal";
import type { ModalImage } from "@/hooks/useAdminWorkspace";

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

export function ImagePreviewModal(props: { image: ModalImage; onClose: () => void }) {
  return (
    <Modal title="图片预览" onClose={props.onClose} wide>
      <div className={`image-preview-stage ${ratioClassName(props.image.ratio)}`}>
        <img src={props.image.src} alt="生成图片预览" />
      </div>
      <div className="preview-modal-meta">
        <span>{props.image.meta}</span>
        <a className="btn-secondary" href={props.image.src} download={props.image.filename || "generated-image.png"}>
          <Download size={16} />
          下载图片
        </a>
      </div>
    </Modal>
  );
}
