import type { ModelInfo } from "../types.js";

export const SUPPORTED_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

export type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];

/** 网关默认生图服务模型。 */
export const DEFAULT_IMAGE_MODEL: SupportedImageModel = "gpt-image-2.5-sunburst";

/**
 * 各结构版本当时的默认生图模型。
 * 只有"记录里的值仍等于它所属版本的默认值"时才认为管理员没有显式选择过，自动升级到
 * DEFAULT_IMAGE_MODEL。这样：
 * - 版本 1 的 gpt-image-2、版本 2 的 gpt-image-2.5-flare 会自动升级；
 * - 管理员在版本 2 之后显式选回的 gpt-image-2 等值不会被覆盖。
 */
export const VERSION_DEFAULT_IMAGE_MODELS: Record<number, SupportedImageModel> = {
  1: "gpt-image-2",
  2: "gpt-image-2.5-flare",
};

export const IMAGE_MODEL_INFOS: ModelInfo[] = SUPPORTED_IMAGE_MODELS.map((id) => ({
  provider: "openai-codex",
  id,
  name: id,
  input: ["text", "image"],
  output: ["image"],
  source: "static",
}));

export function isSupportedImageModel(model: string): model is SupportedImageModel {
  return SUPPORTED_IMAGE_MODELS.includes(model as SupportedImageModel);
}
