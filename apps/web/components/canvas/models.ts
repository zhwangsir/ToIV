"use client";

/** 画布域:NSFW 档的模型解析。
 *
 *  契约说明(本车道前端 / 另一车道后端):
 *   - /api/models 现返回 { checkpoints: string[], modes?: { image: { models, editable } } }。
 *   - NSFW 档需要按模型的 `nsfw` / `vpred` 标记筛选。该标记由后端在
 *     modes.image.models 升级为对象数组({ name, nsfw?, vpred? })时提供;
 *     vpred 由后端自动适配采样,前端只管「选哪个模型」。
 *   - 字段暂缺时优雅降级:NSFW 开关仍存在,但模型列表回退为全部 checkpoints。
 *
 *  ModelsResponse 来自 lib/types(本车道不改 lib/types),故这里用结构化解析
 *  从 listModels() 的返回里「尽力」抽取 nsfw 标记,无标记则回退。 */

import { listModels } from "@/lib/api";

/** 解析后的单个图像底模(含可选 NSFW / vpred 标记)。 */
export interface CanvasModelOption {
  name: string;
  nsfw: boolean;
  /** vpred:后端自动适配,前端仅透传展示(不参与请求构造)。 */
  vpred: boolean;
}

/** 画布需要的模型解析结果。 */
export interface CanvasModels {
  /** 全部图像底模(向后兼容,等价旧 checkpoints)。 */
  all: CanvasModelOption[];
  /** 后端是否提供了 nsfw 标记(false → NSFW 档回退全部)。 */
  hasNsfwMarks: boolean;
}

/** 从 modes.image.models 的「对象形态」里抽 nsfw/vpred(后端升级契约后命中)。 */
function fromModeEntry(entry: unknown): CanvasModelOption | null {
  if (typeof entry === "string") {
    return { name: entry, nsfw: false, vpred: false };
  }
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    if (typeof o.name === "string") {
      return {
        name: o.name,
        nsfw: o.nsfw === true,
        vpred: o.vpred === true,
      };
    }
  }
  return null;
}

/**
 * 拉取并解析画布可用的图像底模(NSFW 标记尽力解析,缺失则降级)。
 * 失败时返回空集合(调用方回退「默认模型」)。
 */
export async function fetchCanvasModels(): Promise<CanvasModels> {
  let res: Awaited<ReturnType<typeof listModels>>;
  try {
    res = await listModels();
  } catch {
    return { all: [], hasNsfwMarks: false };
  }

  // 真实后端契约:顶层扁平 nsfw_models / vpred_models 列表(打标用)。
  const aware = res as typeof res & {
    nsfw_models?: string[];
    vpred_models?: string[];
  };
  const nsfwSet = new Set(Array.isArray(aware.nsfw_models) ? aware.nsfw_models : []);
  const vpredSet = new Set(Array.isArray(aware.vpred_models) ? aware.vpred_models : []);

  // 模型名列表读 modes.image.models(string[] 或未来对象数组),回退 checkpoints。
  const imageMode = res.modes?.image;
  const rawList: unknown[] = Array.isArray(imageMode?.models)
    ? (imageMode!.models as unknown[])
    : (res.checkpoints ?? []);

  const all: CanvasModelOption[] = [];
  for (const raw of rawList) {
    const opt = fromModeEntry(raw);
    if (!opt) continue;
    // 对象形态自带标记则保留其真值,否则用顶层 nsfw_models/vpred_models 打标。
    all.push({
      name: opt.name,
      nsfw: opt.nsfw || nsfwSet.has(opt.name),
      vpred: opt.vpred || vpredSet.has(opt.name),
    });
  }
  const hasNsfwMarks = all.some((m) => m.nsfw);

  return { all, hasNsfwMarks };
}

/**
 * 按 NSFW 档筛选模型名列表(供下拉)。
 *  - nsfw=false:返回非 NSFW 模型(若无任何标记 → 全部)。
 *  - nsfw=true :返回 NSFW 标记模型;若后端未提供标记则回退全部(优雅降级)。
 */
export function filterModels(
  models: CanvasModels,
  nsfw: boolean,
): string[] {
  const { all, hasNsfwMarks } = models;
  if (!hasNsfwMarks) return all.map((m) => m.name); // 无标记 → 回退全部
  if (nsfw) return all.filter((m) => m.nsfw).map((m) => m.name);
  return all.filter((m) => !m.nsfw).map((m) => m.name);
}
