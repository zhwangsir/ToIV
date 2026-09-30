/** 意图 → 公开最佳卡(计划 d 首页入口用)。与 core 评分表 keepers 对齐,2026-09-30 wave5。 */
export type IntentEntry = {
  id: string;
  label: string;
  appId: string;
  altAppId?: string;
  medianSec?: number;
};

export const INTENT_ENTRIES: IntentEntry[] = [
  { id: "outfit", label: "换装", appId: "rh-acc-3051342849-5d0a1c", medianSec: 132 },
  { id: "bg", label: "换背景", appId: "rh-acc-0017330178-cb700a", medianSec: 120 },
  { id: "i2v", label: "图生视频", appId: "rh-acc-1833790465-924e7f", altAppId: "h3-i2v", medianSec: 984 },
  { id: "t2v", label: "文生视频", appId: "rh-acc-8490907650-9066b5", altAppId: "h3-t2v", medianSec: 234 },
  { id: "lipsync", label: "对口型", appId: "rh-acc-0520274945-8fa1b4", altAppId: "ovi-i2v", medianSec: 304 },
  { id: "voice", label: "配音", appId: "h3-r2v-voice", medianSec: 366 },
  { id: "cutout", label: "抠图", appId: "removebg", medianSec: 7 },
  { id: "upscale", label: "放大", appId: "upscale", altAppId: "rh-acc-3722891266-720f7b", medianSec: 223 },
  { id: "vfi", label: "补帧", appId: "rh-acc-8235642881-d2b7ba", medianSec: 257 },
  { id: "line", label: "线稿上色", appId: "rh-acc-4520427522-dfb012", medianSec: 142 },
  { id: "vace", label: "视频换装", appId: "vace-edit", medianSec: 470 },
  { id: "music", label: "音乐", appId: "ace-music", medianSec: 56 },
  { id: "t2i", label: "文生图", appId: "rh-acc-4888229889-d922f7", medianSec: 122 },
  { id: "restore", label: "老照片修复", appId: "rh-acc-5532266497-a8b665", medianSec: 110 },
  { id: "inpaint", label: "局部重绘", appId: "rh-acc-1967241218-76fc32", medianSec: 84 },
  { id: "portrait", label: "人像写真", appId: "rh-acc-6626592769-075f0c", medianSec: 146 },
  { id: "product", label: "产品图", appId: "rh-acc-5353125890-0e3695", medianSec: 164 },
  { id: "edit", label: "图像编辑", appId: "qwen-image-edit", medianSec: 120 },
  { id: "style", label: "风格化", appId: "rh-acc-0041242626-43a90a" },
  { id: "3d", label: "3D", appId: "rh-acc-1922543617-0d4e78", medianSec: 126 },
];
