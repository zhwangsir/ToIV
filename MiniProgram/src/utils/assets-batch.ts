/**
 * 资产库批量管理纯逻辑（MP27）：多选状态机 + 批量删除结果落地
 * 通用批量原语复用 utils/library-batch.ts（MP25：toggleSelect/selectAll/runBatch/
 * summarizeBatch/deleteSummaryText/BATCH_CONCURRENCY 并发限速 ≤3），本文件只落资产页
 * 特有判定（编辑弹层守卫 / 删除结果落地），页面只持状态与渲染，vitest 直测
 * 约束：后端 ReferenceAsset 无 tags 字段（kind/name/description/images/nsfw）——「批量打标」不可行，不做
 */
import type { AssetItem } from '@/types/api';
import {
  deleteSummaryText,
  selectAll,
  summarizeBatch,
  toggleSelect,
  type BatchItemResult,
} from '@/utils/library-batch';

/** 多选状态：selecting=选择模式开关；selected=勾选 id 集（不可变语义，整体替换即触发重渲） */
export interface AssetSelectState {
  selecting: boolean;
  selected: ReadonlySet<string>;
}

/** 进入守卫输入：编辑弹层打开（卡片点按=打开编辑，长按须让位）/ 批量执行中（防重入） */
export interface AssetSelectGuard {
  editorOpen: boolean;
  acting: boolean;
}

/** 非选择态（空选集）；每次调用返回新实例，避免共享引用污染响应式替换语义 */
export function assetSelectIdle(): AssetSelectState {
  return { selecting: false, selected: new Set<string>() };
}

/** 进入守卫：编辑弹层打开或批量执行中 → 拦截（false） */
export function canEnterAssetSelecting(guard: AssetSelectGuard): boolean {
  return !guard.editorOpen && !guard.acting;
}

/** 「选择」钮入口：进入选择模式（空选）；已在选择态幂等返回原态；守卫拦截返回 null */
export function enterAssetSelecting(
  state: AssetSelectState,
  guard: AssetSelectGuard,
): AssetSelectState | null {
  if (!canEnterAssetSelecting(guard)) return null;
  if (state.selecting) return state;
  return { selecting: true, selected: new Set<string>() };
}

/**
 * 长按卡片入口：未在选择态 → 进入并选中该卡；已在选择态 → toggle 该卡
 * 守卫拦截返回 null（编辑弹层打开/批量执行中长按不动作）
 */
export function longPressAssetCard(
  state: AssetSelectState,
  guard: AssetSelectGuard,
  id: string,
): AssetSelectState | null {
  if (!canEnterAssetSelecting(guard)) return null;
  if (!state.selecting) return { selecting: true, selected: new Set([id]) };
  return { selecting: true, selected: toggleSelect(state.selected, id) };
}

/** 选择态下点按卡片 = toggle 选中；非选择态返回 null（调用方走 openEdit） */
export function tapAssetCard(state: AssetSelectState, id: string): AssetSelectState | null {
  if (!state.selecting) return null;
  return { selecting: true, selected: toggleSelect(state.selected, id) };
}

/** 全选当前过滤可见项（资产库本地过滤一次拉全量，无跨分页语义） */
export function selectAllAssets(items: readonly AssetItem[]): Set<string> {
  return selectAll(items);
}

/** 取消/完成退出：回非选择态并清空选择集 */
export function exitAssetSelecting(): AssetSelectState {
  return assetSelectIdle();
}

export interface AssetBatchDeleteOutcome {
  /** 剩余勾选集：失败项保留（含全败）待重试；全成为空集 */
  selected: Set<string>;
  /** 全成退出选择模式；有失败停留 */
  selecting: boolean;
  /** 成功删除项 id（调用方从本地列表移除，保持输入序） */
  removedIds: string[];
  /** 汇总 toast 文案（deleteSummaryText 三态） */
  toast: string;
}

/** 批量删除结果落地：汇总 → 失败保留勾选/全成退出 + 成功项 id 清单 + toast 文案 */
export function applyAssetBatchDelete(
  results: readonly BatchItemResult<AssetItem>[],
): AssetBatchDeleteOutcome {
  const summary = summarizeBatch(results);
  return {
    selected: new Set(summary.failedIds),
    selecting: summary.failed > 0,
    removedIds: results.filter((r) => r.ok).map((r) => r.item.id),
    toast: deleteSummaryText(summary),
  };
}

/** 本地列表移除已成功删除项（保持剩余顺序；removedIds 空 → 原内容不变） */
export function removeDeletedAssets(
  items: readonly AssetItem[],
  removedIds: readonly string[],
): AssetItem[] {
  const gone = new Set(removedIds);
  return items.filter((item) => !gone.has(item.id));
}
