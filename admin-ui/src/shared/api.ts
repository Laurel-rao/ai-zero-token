export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: options?.credentials ?? "include",
  });
  const text = await response.text();
  let body: unknown = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : typeof body === "string"
          ? body
          : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return body as T;
}

export function downloadJsonFile(filename: string, payload: unknown): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(filename: string, content: string, mimeType = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type ImageSaveResult = "shared" | "downloaded";

/**
 * 把图片保存到设备，和分享页 `/s/<token>` 的「保存图片」保持同一套逻辑：
 * - 支持文件分享的浏览器（iOS Safari / 企微 / 微信）直接调起系统保存面板；
 * - 其它浏览器用 blob + download，避免 `download` 属性被忽略时整页跳转到图片地址。
 * 失败时抛错，由调用方降级成「长按保存」浮层。
 */
export async function saveImageToDevice(src: string, filename: string): Promise<ImageSaveResult> {
  const response = await fetch(src, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`图片读取失败（${response.status}）`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("读取到的内容不是图片");
  }
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  const canShareFiles =
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFiles) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "shared";
      }
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
  return "downloaded";
}
