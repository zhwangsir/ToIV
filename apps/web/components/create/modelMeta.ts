/** 底模族元信息 —— 让创作台按所选底模的族自适应 UI(A 期次世代升级)。
 *
 *  次世代族(flux2/qwen_image/z_image)走 UNET 图,服务端强制采样(CFG≈1、simple);
 *  其中蒸馏档(flux2 dev / z_image turbo)负向失效 → 前端隐藏负向框、隐藏 CFG/采样、
 *  提示词切自然语言。Qwen-Image 底模仍用真 CFG + 负向,故只隐 CFG/采样不隐负向。
 */
import type { CheckpointTag, ModelsResponse } from "@/lib/types";

export interface FamilyMeta {
  /** 下拉/徽章展示名。 */
  label: string;
  /** 角标短词(次世代 / 极速 / 写实 / 动漫 / 旧)。 */
  badge: string;
  /** 徽章色调:next(品紫强调)/ warm / neutral。 */
  tone: "next" | "warm" | "neutral";
  /** 一句定位提示。 */
  hint: string;
}

/** 族 → 展示元信息。未知族回落 neutral。 */
export const FAMILY_META: Record<string, FamilyMeta> = {
  flux2: {
    label: "FLUX.2",
    badge: "画质天花板",
    tone: "next",
    hint: "次世代 · 提示词遵循与综合画质最强 · 自然语言描述",
  },
  qwen_image: {
    label: "Qwen-Image",
    badge: "次世代 · 底模",
    tone: "next",
    hint: "次世代 · 中文/画面文字最强 · 自然语言 + 负向有效",
  },
  z_image: {
    label: "Z-Image",
    badge: "极速",
    tone: "next",
    hint: "次世代 · 8 步极速出图 · 批量/预览首选 · 自然语言",
  },
  pony: { label: "Pony", badge: "动漫", tone: "warm", hint: "SDXL 动漫 · score 标签体系" },
  sdxl_anime: {
    label: "SDXL 动漫",
    badge: "动漫",
    tone: "warm",
    hint: "Illustrious / NoobAI / Animagine · danbooru 标签",
  },
  sdxl: { label: "SDXL 写实", badge: "写实", tone: "warm", hint: "写实/通用 · 逗号短语 + 摄影词" },
  flux: { label: "Flux.1", badge: "次世代", tone: "next", hint: "自然语言长句" },
  qwen: { label: "Qwen", badge: "次世代", tone: "next", hint: "自然语言" },
  sd15: { label: "SD1.5", badge: "旧", tone: "neutral", hint: "上一代 · 已退默认(仍可显式用)" },
};

export function familyMeta(family?: string): FamilyMeta | null {
  return family ? FAMILY_META[family] ?? null : null;
}

/** 从 /api/models 的 image 标签里查某底模的族/次世代/负向信息。 */
export function checkpointTag(
  models: ModelsResponse | null,
  ckpt: string,
): CheckpointTag | null {
  const tags = models?.modes?.image?.checkpoints;
  return tags?.find((t) => t.name === ckpt) ?? null;
}

/** 便捷派生:所选底模是否次世代 / 负向是否有效(缺标时保守:非次世代、负向有效)。 */
export function modelBehavior(models: ModelsResponse | null, ckpt: string): {
  tag: CheckpointTag | null;
  meta: FamilyMeta | null;
  nextgen: boolean;
  usesNeg: boolean;
} {
  const tag = checkpointTag(models, ckpt);
  return {
    tag,
    meta: familyMeta(tag?.family),
    nextgen: !!tag?.nextgen,
    usesNeg: tag?.neg !== false, // 缺标或 true → 显示负向框
  };
}
