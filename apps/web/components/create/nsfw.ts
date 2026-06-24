/** NSFW 档:从 /api/models 的可选 nsfw 标记筛选成人向模型。
 *
 * 后端契约由另一车道提供,字段可能暂缺 —— 这里做契约无关的优雅降级:
 * 支持两种可能的标记形态,任一存在即可用;都没有则回退"全部模型 + 开关仍在"。
 *
 *  形态 A(推荐):mode 条目带 `nsfw: string[]`(该模式下的 NSFW 模型文件名子集)。
 *  形态 B(兼容):顶层 `nsfw: Record<mode, string[]>`。
 *
 * vpred 等采样适配由后端自动处理,前端只负责"选到 nsfw 模型"。 */

import type { ModelsResponse } from "@/lib/types";

/** 给 ModeModels 增补可选 nsfw 子列表(本地视图,不改共享类型)。 */
interface NsfwModeModels {
  models?: string[];
  nsfw?: string[];
}

/** 给 ModelsResponse 增补可选 nsfw 映射(本地视图,不改共享类型)。 */
interface NsfwAware {
  modes?: Record<string, NsfwModeModels>;
  nsfw?: Record<string, string[]>;
}

/** 读取某模式的 NSFW 文件名集合(任一形态),无标记返回 null。 */
function nsfwNamesFor(models: ModelsResponse | null, mode: string): string[] | null {
  if (!models) return null;
  const aware = models as ModelsResponse & NsfwAware;
  const fromMode = aware.modes?.[mode]?.nsfw;
  if (Array.isArray(fromMode)) return fromMode;
  const fromTop = aware.nsfw?.[mode];
  if (Array.isArray(fromTop)) return fromTop;
  return null;
}

/** 后端是否提供了该模式的 NSFW 标记(决定 NSFW 档是否真正能筛选)。 */
export function hasNsfwData(models: ModelsResponse | null, mode: string): boolean {
  const names = nsfwNamesFor(models, mode);
  return !!names && names.length > 0;
}

/**
 * 按 NSFW 档过滤模型下拉列表。
 * - on=false → 原样返回(全部模型)。
 * - on=true 且有标记 → 仅保留标记中的 NSFW 模型。
 * - on=true 但无标记 → 优雅降级:返回原列表(开关在,列表回退全部)。
 */
export function filterModelsByNsfw(
  list: readonly string[],
  models: ModelsResponse | null,
  mode: string,
  on: boolean,
): string[] {
  if (!on) return list.slice();
  const names = nsfwNamesFor(models, mode);
  if (!names || names.length === 0) return list.slice();
  const set = new Set(names);
  const filtered = list.filter((m) => set.has(m));
  // 若标记与当前列表无交集,仍回退全部,避免空下拉锁死用户
  return filtered.length > 0 ? filtered : list.slice();
}
