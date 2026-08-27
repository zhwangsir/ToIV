/**
 * 作品库批量管理纯逻辑（M25）
 * - 后端无批量端点（契约已读 apps/api routes/jobs.py）：批量 = 客户端循环单删/存单，
 *   并发限速 ≤3（BATCH_CONCURRENCY），单项失败不中断，成败 id 收集供选择集差集
 * - 选择集用 Set<id>，跨分页保持；纯函数不改入参，返回值可直接落 useState
 */

import type { JobItem } from '@/types/api';

import { kindToFilter } from './library-utils';

/** 批量并发上限：循环打单删/下载端点，限速 ≤3 防瞬峰打爆后端与相册写入 */
export const BATCH_CONCURRENCY = 3;

/** 勾选切换：返回新 Set（不改入参） */
export function toggleSelect(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 全选：当前已加载（pages 拍平）项的 id 集 */
export function selectAllIds(items: readonly { id: string }[]): Set<string> {
  return new Set(items.map((i) => i.id));
}

/**
 * 保存相册分流：仅 image/video 可保存（audio/3D 跳过计数）；
 * 未知 kind 对齐网格卡/详情页语义按图像处理（可保存）
 */
export function splitSavable(jobs: readonly JobItem[]): { savable: JobItem[]; skipped: number } {
  const savable: JobItem[] = [];
  let skipped = 0;
  for (const j of jobs) {
    const group = kindToFilter(j.kind);
    if (group === 'audio' || group === '3d') skipped += 1;
    else savable.push(j);
  }
  return { savable, skipped };
}

export interface BatchSummaryInput {
  action: 'delete' | 'save';
  succeeded: number;
  failed: number;
  /** 仅保存：audio/3D 不支持入册的跳过数 */
  skipped?: number;
}

/** 批量结果 → 汇总人话（内联展示于过滤行下方） */
export function summarizeBatch({
  action,
  succeeded,
  failed,
  skipped = 0,
}: BatchSummaryInput): string {
  if (action === 'delete') {
    return failed === 0
      ? `已删除 ${succeeded} 项`
      : `成功 ${succeeded} 项，失败 ${failed} 项，失败项已保留勾选`;
  }
  if (succeeded === 0 && failed === 0 && skipped > 0) {
    return `已跳过 ${skipped} 项（音频与 3D 作品不支持保存到相册）`;
  }
  const parts = [`已保存 ${succeeded} 项到相册`];
  if (failed > 0) parts.push(`失败 ${failed} 项`);
  if (skipped > 0) parts.push(`跳过 ${skipped} 项不支持的类型`);
  return parts.join('，');
}

export interface BatchRunOptions {
  /** 默认 BATCH_CONCURRENCY（≤3） */
  concurrency?: number;
  /** 每项 settle 后回报（done 从 1 递增至 total） */
  onProgress?: (done: number, total: number) => void;
}

export interface BatchRunResult {
  succeeded: string[];
  failed: string[];
}

/**
 * 批量执行器：工作池限速循环单项 fn，失败不中断，收集成败 id。
 * fn 可注入（deleteJob / 下载封装），本函数不感知具体 IO，纯编排可单测。
 */
export async function runBatchLimited(
  ids: readonly string[],
  fn: (id: string) => Promise<unknown>,
  { concurrency = BATCH_CONCURRENCY, onProgress }: BatchRunOptions = {},
): Promise<BatchRunResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  const total = ids.length;
  if (total === 0) return { succeeded, failed };

  let cursor = 0;
  let done = 0;
  const pump = async () => {
    while (cursor < total) {
      const id = ids[cursor];
      cursor += 1;
      try {
        await fn(id);
        succeeded.push(id);
      } catch {
        failed.push(id);
      }
      done += 1;
      onProgress?.(done, total);
    }
  };
  const lanes = Math.min(Math.max(1, Math.floor(concurrency)), total);
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return { succeeded, failed };
}
