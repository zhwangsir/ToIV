/**
 * 作品库无限分页纯逻辑（M15，契约已读 apps/api routes/jobs.py list_jobs 源码验证）
 * - offset 分页：limit 1-200 默认 50；offset ≥0 默认 0；返回最新在前；越界返回 []
 * - hasMore 启发式：本页返回数 === limit 即可能还有下一页
 */

import type { InfiniteData } from '@tanstack/react-query';

import type { JobItem } from '@/types/api';

/**
 * 页大小 50：对齐后端默认档（1-200 内）；双列网格约 25 行 ≈ 3-4 屏，
 * 首屏延迟与请求频次的折中（200 一次拉满首屏慢，20 则滚动请求过密）
 */
export const LIBRARY_PAGE_SIZE = 50;

/** hasMore 启发式：本页返回数 === limit 即可能还有（后端契约注释原义） */
export function pageHasMore(pageLength: number, limit: number): boolean {
  return pageLength === limit;
}

/** 下一页 offset：已消费的服务端行数（页数 × 页大小，与去重后的可见条数解耦） */
export function nextOffset(pageCount: number, limit: number): number {
  return pageCount * limit;
}

/**
 * 多页合并为单一列表：按 id 去重保序，先出现（更靠顶部/更新）的一份胜出。
 * offset 分页下页边界会随顶部新作插入漂移，追加/失效重取都可能带回重叠行。
 */
export function mergePagesUnique(pages: JobItem[][]): JobItem[] {
  const seen = new Set<string>();
  const merged: JobItem[] = [];
  for (const page of pages) {
    for (const job of page) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      merged.push(job);
    }
  }
  return merged;
}

/**
 * 下拉刷新重置：截断到首页。TanStack infinite refetch 按 pageParams 逐页重取，
 * 截断后仅重取 offset=0 一页并由其长度重算 hasMore（抛弃已加载的后续页）。
 */
export function firstPageOnly(
  data: InfiniteData<JobItem[], number>,
): InfiniteData<JobItem[], number> {
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
}
