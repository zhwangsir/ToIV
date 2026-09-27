/**
 * 局部重绘遮罩(2026-09-27):市场局部重绘卡的图槽绑定 LoadImage,工作流消费其 MASK 输出(slot 1)。
 * ComfyUI LoadImage 的 MASK = 1 - alpha:透明像素 = 要重绘的区域。RunningHub 里用户在 clipspace 手涂,
 * ToIV 原先只能让用户自己传透明 PNG;这里提供纯函数,把涂抹层合成进上传图的 alpha 通道。
 *
 * 与后端 services/app_smoke.mask_consuming_image_keys 同判据(LoadImage/LoadImageMask 的 slot 1 被下游连线)。
 */

const MASK_LOADERS = new Set(["LoadImage", "LoadImageMask"]);

interface WfNode {
  class_type: string;
  inputs?: Record<string, unknown>;
}

/** 返回需要遮罩的图槽 key:绑定节点是 LoadImage 且其 MASK 输出(slot 1)被任一节点连线消费。 */
export function maskImageKeys(
  workflow: Record<string, WfNode> | null | undefined,
  bindings: Record<string, { node: string }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!workflow || !bindings) return out;
  const consumed = new Set<string>();
  for (const node of Object.values(workflow)) {
    for (const v of Object.values(node?.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && v[1] === 1 && v[0] != null) consumed.add(String(v[0]));
    }
  }
  for (const [key, b] of Object.entries(bindings)) {
    const id = String(b?.node ?? "");
    const node = workflow[id];
    if (node && MASK_LOADERS.has(node.class_type) && consumed.has(id)) out.add(key);
  }
  return out;
}

/**
 * 合成上传像素:RGB 取原图,alpha = 255 - 遮罩覆盖度(遮罩层取其 alpha 通道,支持羽化半透明)。
 * rgba 与 mask 均为 RGBA Uint8ClampedArray,等长;返回新数组,不改入参。
 */
export function composeMaskedPixels(rgba: Uint8ClampedArray, mask: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  if (rgba.length !== mask.length) throw new Error("遮罩尺寸与原图不一致");
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i + 2];
    out[i + 3] = 255 - mask[i + 3];
  }
  return out;
}

/** 从已带透明度的原图提取初始遮罩覆盖度(用户上传的透明 PNG 直接成为可编辑遮罩)。 */
export function maskFromAlpha(rgba: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i + 3] = 255 - rgba[i + 3];
  }
  return out;
}

/** 遮罩覆盖率(0-1,alpha>0 的像素占比);用于提示“尚未涂抹”与脚注统计。 */
export function maskCoverage(mask: Uint8ClampedArray): number {
  const total = mask.length / 4;
  if (total === 0) return 0;
  let n = 0;
  for (let i = 3; i < mask.length; i += 4) if (mask[i] > 0) n++;
  return n / total;
}

/** 画笔直径(图像像素):按长边百分比换算,限制在 [4, 长边/2]。 */
export function brushDiameterPx(longSide: number, pct: number): number {
  const d = Math.round((longSide * pct) / 100);
  return Math.max(4, Math.min(Math.round(longSide / 2), d));
}

/** 涂抹图文件名:原名去扩展 + _mask.png(统一 PNG,保留 alpha)。 */
export function maskedFileName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").replace(/_mask$/, "") || "image";
  return `${stem}_mask.png`;
}

/** 撤销栈上限(每步一份整图快照,4K 图约 32MB/步,留 12 步)。 */
export const MASK_UNDO_LIMIT = 12;
