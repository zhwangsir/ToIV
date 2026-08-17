/**
 * 作品库无限分页纯逻辑（MP15）：服务端无 total，hasMore 用「本页返回数 === 页大小」启发式
 * 游标 offset 独立追踪服务端流位置（按原始返回数推进，与去重后的可见长度解耦），
 * 页面只持状态与渲染，判定全部落在本文件供 vitest 直测
 */

/** 分页游标：已拉取的服务端流长度 + 是否可能还有下一页 */
export interface PageCursor {
  offset: number;
  hasMore: boolean;
}

/** 初始游标：尚未拉取，offset 0 且假定可能有数据 */
export const INITIAL_CURSOR: PageCursor = { offset: 0, hasMore: true };

/**
 * 追加一页并按 id 去重（不改入参；同 id 保留先出现者）
 * 新完成的作业由 refresh 重置回流顶部，追加路径绝不重复插入
 */
export function appendPage<T extends { id: string }>(
  existing: readonly T[],
  page: readonly T[],
): T[] {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  for (const item of page) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

/** 首页（首屏/下拉刷新/重进）后的游标：offset=本页长度，满页即可能还有 */
export function cursorAfterFirst<T>(page: readonly T[], pageSize: number): PageCursor {
  return { offset: page.length, hasMore: page.length === pageSize };
}

/**
 * 追加一页后的游标：offset 按服务端原始返回数推进
 * （新作业插入流顶部会造成页间重叠，若按去重后可见长度推进游标会回退重拉死循环）
 */
export function cursorAfterNext<T>(
  prev: PageCursor,
  page: readonly T[],
  pageSize: number,
): PageCursor {
  return { offset: prev.offset + page.length, hasMore: page.length === pageSize };
}

/** 过滤后可视项不足且服务端可能还有 → 续拉下一页填补（客户端过滤不阻断滚动加载） */
export function needsAutoFill(visibleCount: number, minVisible: number, hasMore: boolean): boolean {
  return hasMore && visibleCount < minVisible;
}
