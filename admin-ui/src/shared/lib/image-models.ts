/** 网关支持的生图服务模型。 */
export const SUPPORTED_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

/** 网关默认生图服务模型，与服务端默认值保持一致。 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";
