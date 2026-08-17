import type { InfiniteData } from '@tanstack/react-query';

import type { JobItem } from '@/types/api';

import {
  firstPageOnly,
  LIBRARY_PAGE_SIZE,
  mergePagesUnique,
  nextOffset,
  pageHasMore,
} from '../library-paging';

function job(id: string): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: 'txt2img',
    status: 'done',
    prompt: id,
    seed: 1,
    created_at: '2026-08-14T00:00:00',
    results: [`/${id}.png`],
    nsfw: false,
    parent_id: '',
    root_id: id,
    has_params: false,
  };
}

describe('LIBRARY_PAGE_SIZE', () => {
  it('对齐后端默认 50，且在契约允许范围 1-200 内', () => {
    expect(LIBRARY_PAGE_SIZE).toBe(50);
    expect(LIBRARY_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(LIBRARY_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});

describe('pageHasMore（hasMore 启发式：本页返回数 === limit 即可能还有）', () => {
  it('满页 → 可能还有', () => {
    expect(pageHasMore(50, 50)).toBe(true);
  });

  it('不足页 / 空页 → 没有更多', () => {
    expect(pageHasMore(49, 50)).toBe(false);
    expect(pageHasMore(0, 50)).toBe(false);
  });
});

describe('nextOffset（已消费的服务端行数 = 页数 × 页大小）', () => {
  it('0 页 → 0；2 页 → 2 × 页大小', () => {
    expect(nextOffset(0, 50)).toBe(0);
    expect(nextOffset(2, 50)).toBe(100);
  });
});

describe('mergePagesUnique（append + dedupe）', () => {
  it('多页按序拼接', () => {
    const merged = mergePagesUnique([[job('a'), job('b')], [job('c')]]);
    expect(merged.map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('跨页重复 id 去重，保留先出现（更靠顶部）的一份', () => {
    const first = job('b');
    const dup = { ...job('b'), prompt: '漂移后重复' };
    const merged = mergePagesUnique([[job('a'), first], [dup, job('c')]]);
    expect(merged.map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1].prompt).toBe('b');
  });

  it('空页与空输入 → 空列表', () => {
    expect(mergePagesUnique([])).toEqual([]);
    expect(mergePagesUnique([[], []])).toEqual([]);
  });
});

describe('firstPageOnly（下拉刷新重置：截断到首页，refetch 仅重取 offset=0）', () => {
  it('多页截断到首页，pages/pageParams 同步截断', () => {
    const data: InfiniteData<JobItem[], number> = {
      pages: [[job('a')], [job('b')], [job('c')]],
      pageParams: [0, 50, 100],
    };
    const reset = firstPageOnly(data);
    expect(reset.pages).toEqual([[job('a')]]);
    expect(reset.pageParams).toEqual([0]);
  });

  it('单页数据内容不变', () => {
    const data: InfiniteData<JobItem[], number> = {
      pages: [[job('a')]],
      pageParams: [0],
    };
    const reset = firstPageOnly(data);
    expect(reset.pages).toHaveLength(1);
    expect(reset.pageParams).toEqual([0]);
  });
});
