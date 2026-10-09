/**
 * 意图 keepers 单源（无 UI 依赖）。
 * Web PortalEmpty / canvas 首页意图条共用；深链优先本地 altAppId（H3/Ovi/…），RH 备选。
 */

export type IntentKeeper = {
  id: string;
  label: string;
  /** 公开最佳卡（多为 RH 或内置短名） */
  appId: string;
  /** 本地备选（H3/Ovi/内置）；有则默认优先于 RH appId */
  altAppId?: string;
  medianSec?: number;
  /** 与 apps/web IconName 对齐的短名；canvas 侧自行映射 lucide */
  icon: string;
};

/** 是否本地/内置 keeper（非 RH 账号卡）。 */
export function isLocalIntentAppId(appId: string): boolean {
  const id = appId.trim();
  return Boolean(id) && !id.startsWith("rh-");
}

/**
 * 默认打开的市场 app id：优先本地 altAppId（H3/Ovi/…），否则 appId；
 * 若 alt 是 RH 而 appId 是本地（如放大），仍用本地 appId。
 */
export function resolveIntentAppId(entry: Pick<IntentKeeper, "appId" | "altAppId">): string {
  const primary = entry.appId.trim();
  const alt = entry.altAppId?.trim();
  if (alt && isLocalIntentAppId(alt)) return alt;
  if (primary) return primary;
  return alt || "";
}

/** 融合壳市场深链。 */
export function intentMarketPath(entry: Pick<IntentKeeper, "appId" | "altAppId">): string {
  return `/toiv/market?app=${encodeURIComponent(resolveIntentAppId(entry))}`;
}

/** Next 门户 `market?app=` 查询串（经 handleFusionNavigate）。 */
export function intentMarketQuery(entry: Pick<IntentKeeper, "appId" | "altAppId">): string {
  return `market?app=${encodeURIComponent(resolveIntentAppId(entry))}`;
}

/**
 * 意图 → 公开最佳卡（计划 d + 融合意图条）。
 * avatar（数字人）与 lipsync（对口型）分轨：avatar→avatar-talk，lipsync→ovi-i2v。
 */
export const INTENT_ENTRIES: IntentKeeper[] = [
  { id: "outfit", label: "换装", appId: "rh-acc-3051342849-5d0a1c", medianSec: 132, icon: "layers" },
  { id: "bg", label: "换背景", appId: "rh-acc-0017330178-cb700a", medianSec: 120, icon: "image" },
  { id: "i2v", label: "图生视频", appId: "rh-acc-1833790465-924e7f", altAppId: "h3-i2v", medianSec: 984, icon: "video" },
  { id: "t2v", label: "文生视频", appId: "rh-acc-8490907650-9066b5", altAppId: "h3-t2v", medianSec: 234, icon: "film" },
  { id: "lipsync", label: "对口型", appId: "rh-acc-0520274945-8fa1b4", altAppId: "ovi-i2v", medianSec: 304, icon: "mic" },
  { id: "avatar", label: "数字人", appId: "avatar-talk", medianSec: 366, icon: "user" },
  { id: "voice", label: "配音", appId: "h3-r2v-voice", medianSec: 366, icon: "audio" },
  { id: "cutout", label: "抠图", appId: "removebg", medianSec: 7, icon: "scissors" },
  { id: "upscale", label: "放大", appId: "upscale", altAppId: "rh-acc-3722891266-720f7b", medianSec: 223, icon: "maximize" },
  { id: "vfi", label: "补帧", appId: "rh-acc-8235642881-d2b7ba", medianSec: 257, icon: "play" },
  { id: "line", label: "线稿上色", appId: "rh-acc-4520427522-dfb012", medianSec: 142, icon: "pencil" },
  { id: "vace", label: "视频换装", appId: "vace-edit", medianSec: 470, icon: "clapperboard" },
  { id: "music", label: "音乐", appId: "ace-music", medianSec: 56, icon: "audio" },
  { id: "t2i", label: "文生图", appId: "rh-acc-4888229889-d922f7", medianSec: 122, icon: "sparkles" },
  { id: "restore", label: "老照片修复", appId: "rh-acc-5353125890-0e3695", medianSec: 110, icon: "history" },
  { id: "inpaint", label: "局部重绘", appId: "rh-acc-1967241218-76fc32", medianSec: 84, icon: "brush" },
  { id: "portrait", label: "人像写真", appId: "rh-acc-6626592769-075f0c", medianSec: 146, icon: "user" },
  { id: "product", label: "产品图", appId: "rh-acc-5532266497-a8b665", medianSec: 164, icon: "package" },
  { id: "edit", label: "图像编辑", appId: "rh-acc-3722891266-720f7b", medianSec: 120, icon: "palette" },
  { id: "style", label: "风格化", appId: "rh-acc-0466103297-947a01", icon: "brush" },
  { id: "3d", label: "3D", appId: "rh-acc-1922543617-0d4e78", medianSec: 126, icon: "model3d" },
];
