/**
 * Studio 短剧项目产出规格(分辨率/帧率)预设,与后端 app.models.STUDIO_DEFAULT_* 保持一致。
 */

/** 分辨率预设(全部 32 对齐;首项为短剧默认竖屏,与后端 STUDIO_DEFAULT_* 一致)。 */
export const RES_PRESETS = [
  { w: 768, h: 1344, label: "768×1344 竖屏·短剧" },
  { w: 768, h: 384, label: "768×384 横屏·流畅" },
  { w: 1024, h: 576, label: "1024×576 横屏·标清" },
  { w: 1280, h: 720, label: "1280×720 横屏·高清" },
  { w: 576, h: 1024, label: "576×1024 竖屏·标清" },
  { w: 720, h: 1280, label: "720×1280 竖屏·高清" },
] as const;
export const FPS_OPTIONS = [8, 12, 16, 24] as const;
export const DEFAULT_FPS = 24;

export type ResPreset = { w: number; h: number; label: string };

/**
 * 项目当前规格不在预设里时(如旧项目/接口建的自定义规格),把它作为首项保留,
 * 避免下拉回落到首项后「拆解」把项目规格静默改写。
 */
export function resOptionsFor(width?: number, height?: number): ResPreset[] {
  const list: ResPreset[] = [...RES_PRESETS];
  if (width && height && !list.some((p) => p.w === width && p.h === height)) {
    list.unshift({ w: width, h: height, label: `${width}×${height} 当前` });
  }
  return list;
}
