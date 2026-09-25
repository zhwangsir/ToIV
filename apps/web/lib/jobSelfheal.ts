/**
 * U1(2026-09-26):助手作业卡失败自愈纯函数。
 * 大白话原因 / 同类 PASS 卡挑选——零 hex、无 DOM,单测友好。
 */
import { friendlyError } from "./friendlyError";
import type { AppItem, AppCategory, AppOutputKind } from "./apps";
import { kindToFilter } from "./libraryQuery";

/** 剥掉堆栈/多行噪声,只留首条可读原因(后端偶发 traceback 全文)。 */
export function stripErrorNoise(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  // Traceback 块:取最后一行 Exception: msg,或首行非 File/Traceback
  if (/^Traceback \(most recent call last\)/i.test(text) || /\n\s*File "/.test(text)) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    const m = last.match(/^(?:\w+(?:\.\w+)*:\s*)?(.+)$/);
    return (m?.[1] || last).slice(0, 240);
  }
  // 多行时取第一行非空
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) || text;
  return first.slice(0, 240);
}

/** 作业失败 → 用户可见大白话(不露栈;已知模式走 friendlyError)。 */
export function plainJobErrorReason(
  error?: string | null,
  holdReason?: string | null,
): string {
  const raw = stripErrorNoise(String(error || holdReason || "").trim());
  if (!raw) return "生成失败,请重试或换一张同类卡";
  // 已含明确后续指引的文案原样透传(与 friendlyError 对齐)
  if (raw.includes("请在作品库查看")) return raw;
  // 常见 Comfy/应用失败模式(在 friendlyError 通用模式之前)
  const EXTRA: { re: RegExp; message: string }[] = [
    { re: /CUDA out of memory|out of memory|OOM|显存不足|VRAM/i, message: "显存不足,请稍后重试或换一张更轻的同类卡" },
    { re: /内存不足|RAM 不足|Cannot allocate/i, message: "内存不足,请稍后重试" },
    { re: /not found|找不到|缺失|missing.*(model|node|ckpt|unet|lora)/i, message: "缺少模型或节点,请换一张同类可用卡" },
    { re: /timeout|超时|timed?\s*out/i, message: "生成超时,请重试或换一张更快的同类卡" },
    { re: /canceled|cancelled|已中止|用户取消/i, message: "作业已中止" },
    { re: /NSFW|R18|内容分级|403/i, message: "当前内容模式不可用,请切换模式或换卡" },
  ];
  for (const { re, message } of EXTRA) {
    if (re.test(raw)) return message;
  }
  const fe = friendlyError(raw);
  // 若仍是长英文/路径噪声,给兜底
  if (fe.message.length > 120 || /\/[a-zA-Z0-9_.-]+\.(py|js|tsx?)\b/.test(fe.message)) {
    return "生成失败,请重试或换一张同类卡";
  }
  return fe.message || "生成失败,请重试或换一张同类卡";
}

/** 引擎 kind → 市场 category(找不到则 all)。 */
export function jobKindToAppCategory(kind: string): AppCategory | "all" {
  const f = kindToFilter(kind);
  if (f === "image" || f === "video" || f === "audio" || f === "3d") return f;
  // app_image / app_video …
  const m = /^app_(image|video|audio|3d)$/.exec(kind);
  if (m) return m[1] as AppCategory;
  return "all";
}

export interface SimilarAppsSeed {
  /** 失败作业来源应用(排除自身)。 */
  excludeAppId?: string;
  /** 优先同 category。 */
  category?: AppCategory | "all" | string;
  /** 优先同 use_case。 */
  useCase?: string;
  /** 优先同 output_kind。 */
  outputKind?: AppOutputKind | string;
  /** 候选池(通常已是公开列表)。 */
  apps: readonly AppItem[];
  /** 最多返回几条(默认 3)。 */
  limit?: number;
}

/**
 * 从公开应用池挑 smoke_status=pass 的同类卡。
 * 排序:同 use_case > 同 output_kind > 同 category > 名称。
 */
export function pickSimilarPassApps(seed: SimilarAppsSeed): AppItem[] {
  const limit = seed.limit ?? 3;
  const exclude = (seed.excludeAppId || "").trim();
  const cat = (seed.category || "all").trim();
  const useCase = (seed.useCase || "").trim();
  const outKind = (seed.outputKind || "").trim();

  const pool = seed.apps.filter((a) => {
    if (!a || a.smoke_status !== "pass") return false;
    if (exclude && a.id === exclude) return false;
    // 公开市场卡优先;本人私有卡不进「换一张」
    if (a.is_public === false) return false;
    return true;
  });

  const score = (a: AppItem): number => {
    let s = 0;
    if (useCase && a.use_case === useCase) s += 8;
    if (outKind && a.output_kind === outKind) s += 4;
    if (cat && cat !== "all" && a.category === cat) s += 2;
    return s;
  };

  return pool
    .map((a) => ({ a, s: score(a) }))
    .filter(({ s }) => {
      // 有种子维度时至少命中一项;全无种子则任意 PASS 均可
      if (!useCase && !outKind && (!cat || cat === "all")) return true;
      return s > 0;
    })
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name, "zh"))
    .slice(0, limit)
    .map(({ a }) => a);
}

/** 作业卡是否适合走后端 /jobs/{id}/rerun(与 canRerun 镜像,不依赖完整 JobItem)。 */
export function jobCardCanRerun(card: {
  kind: string;
  status: string;
  hasParams?: boolean;
}): boolean {
  // 延迟 import 避免循环;白名单内联最小集与 libraryQuery.RERUNNABLE_KINDS 对齐关键点
  // 实际判定仍建议调用方用 canRerun(JobItem);此处给 UI 显隐用
  const RERUN = new Set([
    "txt2img", "nsfw-txt2img", "img2img", "nsfw-img2img",
    "controlnet", "upscale", "facedetailer", "raw",
    "removebg", "inpaint", "wan_t2v", "wan_i2v",
    "hunyuan3d", "ace_audio", "audio",
    "manju_lipsync", "manju_shot_txt2img", "manju_shot_ipadapter",
    "video_upscale",
    "h3_t2v", "h3_multishot", "longcat_t2v", "ovi_t2v", "ltx_t2v",
  ]);
  return (
    RERUN.has(card.kind) &&
    !!card.hasParams &&
    card.status !== "queued" &&
    card.status !== "running" &&
    card.status !== "held"
  );
}
