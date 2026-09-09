import type { ModelInfo } from "../types.js";

export const SUPPORTED_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
] as const;

export type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];

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
