import { createPortal } from "react-dom";

/**
 * 微信 / 企业微信内置浏览器没有下载能力，也没有可用的文件分享 API，
 * 只能让用户在原生图片视图里长按保存。预览弹窗自身为了拖拽把
 * touch-action / user-select 关掉了，会顺带屏蔽长按菜单，所以这里用
 * portal 铺一层只有 `<img>` 的浮层，恢复浏览器默认的长按行为。
 */
export function ImageSaveOverlay(props: { src: string; hint?: string; onClose: () => void }) {
  return createPortal(
    <div className="image-save-overlay" role="dialog" aria-modal="true" aria-label="保存图片">
      <img className="image-save-overlay-image" src={props.src} alt="" draggable={false} />
      <div className="image-save-overlay-bar">
        <span>{props.hint ?? "长按图片 → 保存图片 / 存到相册"}</span>
        <button type="button" onClick={props.onClose}>
          关闭
        </button>
      </div>
    </div>,
    document.body,
  );
}
