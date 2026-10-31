/**
 * 作品库批量管理纯逻辑（MP25）：多选集合 / 可保存拆分 / 并发限速批量执行器 / 汇总人话文案
 * 后端无批量端点（契约已读 apps/api routes/jobs.py）：批量 = 客户端循环单删/单存，
 * 并发上限 3 防打爆服务端；页面只持状态与渲染，判定全部落在本文件供 vitest 直测
 */
import { kindToFilter } from '@/utils/library';

/** 批量执行并发上限（≤3：任务书硬性约束） */
export const BATCH_CONCURRENCY = 3;

/**
 * 选择集 toggle：未选加入 / 已选移除
 * 不可变语义（返回新 Set，不改入参）——Vue 引用替换即触发重渲，无需依赖 collection 深度追踪
 */
export function toggleSelect(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 全选：当前已加载项的全量 id 集合（跨分页已加载的都在内） */
export function selectAll<T extends { id: string }>(items: readonly T[]): Set<string> {
  return new Set(items.map((item) => item.id));
}

export interface SavableSplit<T> {
  /** 可保存相册（image/video） */
  savable: T[];
  /** 不支持保存（audio/3d/未识别 kind），计入汇总跳过数 */
  skipped: T[];
}

/** 按 kind 过滤桶拆可保存/不可保存，保持输入相对顺序 */
export function splitSavable<T extends { kind: string }>(items: readonly T[]): SavableSplit<T> {
  const savable: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    const group = kindToFilter(item.kind);
    if (group === 'image' || group === 'video') savable.push(item);
    else skipped.push(item);
  }
  return { savable, skipped };
}

/** 单项执行结果：ok=false 时 error 带人话文案（供汇总/排查） */
export interface BatchItemResult<T> {
  item: T;
  ok: boolean;
  error?: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  /** 失败项 id（按输入序）——部分失败时调用方据此保留勾选 */
  failedIds: string[];
}

export function summarizeBatch<T extends { id: string }>(
  results: readonly BatchItemResult<T>[],
): BatchSummary {
  const failedIds: string[] = [];
  for (const r of results) {
    if (!r.ok) failedIds.push(r.item.id);
  }
  return {
    total: results.length,
    succeeded: results.length - failedIds.length,
    failed: failedIds.length,
    failedIds,
  };
}

/** 批量删除汇总人话：全成 / 部分（失败项保留勾选） / 全败 */
export function deleteSummaryText(summary: BatchSummary): string {
  if (summary.failed === 0) return `已删除 ${summary.succeeded} 项`;
  if (summary.succeeded === 0) return '删除失败，请稍后重试';
  return `成功 ${summary.succeeded} 失败 ${summary.failed}，失败项已保留勾选`;
}

/** 批量保存汇总人话：跳过（audio/3d 不支持）与失败分开计数 */
export function saveSummaryText(summary: BatchSummary, skipped: number): string {
  const { succeeded, failed } = summary;
  if (succeeded === 0 && failed === 0) return '仅图像与视频支持保存相册';
  if (succeeded === 0) return '保存失败，请检查相册权限';
  if (failed === 0) {
    return skipped > 0 ? `已保存 ${succeeded} 项，${skipped} 项不支持保存` : `已保存 ${succeeded} 项`;
  }
  return skipped > 0
    ? `已保存 ${succeeded} 项，${skipped} 项不支持，${failed} 项失败`
    : `已保存 ${succeeded} 项，${failed} 项保存失败`;
}

/**
 * 并发限速批量执行器：lane 模型同时最多 concurrency 个 worker 在途
 * - 结果与输入同序（与完成序解耦，summarizeBatch 的 failedIds 即输入序）
 * - onProgress(done, total) 每项 settle 后回调（done 单调 1..total），初始 0/N 由调用方自置
 * - worker 抛错不中断批次：该项记 ok:false 继续后续（部分失败语义）
 */
export async function runBatch<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<BatchItemResult<T>[]> {
  const total = items.length;
  const results: BatchItemResult<T>[] = items.map((item) => ({ item, ok: false }));
  if (total === 0) return results;
  const limit = Math.max(1, Math.min(options.concurrency ?? BATCH_CONCURRENCY, total));
  let cursor = 0;
  let done = 0;
  async function lane(): Promise<void> {
    while (cursor < total) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      try {
        await worker(item);
        results[index] = { item, ok: true };
      } catch (err) {
        results[index] = {
          item,
          ok: false,
          error: err instanceof Error ? err.message : '操作失败',
        };
      }
      done += 1;
      options.onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => lane()));
  return results;
}
