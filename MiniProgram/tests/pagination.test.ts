import { describe, expect, it } from 'vitest';

import type { JobItem } from '@/types/api';
import {
  appendPage,
  cursorAfterFirst,
  cursorAfterNext,
  INITIAL_CURSOR,
  needsAutoFill,
} from '@/utils/pagination';

function job(id: string): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: 'txt2img',
    status: 'done',
    prompt: '',
    seed: 1,
    created_at: '2026-08-14T10:00:00',
    results: [`outputs/${id}.png`],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: true,
  };
}

describe('INITIAL_CURSOR', () => {
  it('未拉取：offset 0 且假定可能有数据', () => {
    expect(INITIAL_CURSOR).toEqual({ offset: 0, hasMore: true });
  });
});

describe('appendPage', () => {
  it('追加保持顺序：已有在前，新页在后', () => {
    const merged = appendPage([job('a'), job('b')], [job('c'), job('d')]);
    expect(merged.map((j) => j.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('按 id 去重：重叠项不重复插入，保留先出现者', () => {
    const merged = appendPage([job('a'), job('b')], [job('b'), job('c'), job('c')]);
    expect(merged.map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('空页原样（引用内容一致）且不改变入参', () => {
    const existing = [job('a')];
    expect(appendPage(existing, []).map((j) => j.id)).toEqual(['a']);
    expect(existing).toHaveLength(1);
  });
});

describe('cursorAfterFirst', () => {
  it('满页：hasMore=true，offset=页大小', () => {
    const page = Array.from({ length: 24 }, (_, i) => job(`p${i}`));
    expect(cursorAfterFirst(page, 24)).toEqual({ offset: 24, hasMore: true });
  });

  it('不足页：hasMore=false，offset=实际数', () => {
    expect(cursorAfterFirst([job('a')], 24)).toEqual({ offset: 1, hasMore: false });
  });

  it('空页：hasMore=false，offset=0（真的无作品）', () => {
    expect(cursorAfterFirst([], 24)).toEqual({ offset: 0, hasMore: false });
  });
});

describe('cursorAfterNext', () => {
  it('offset 按服务端原始返回数推进（与去重后可见长度解耦）', () => {
    const prev = { offset: 24, hasMore: true };
    // 重叠页：2 条与上一页重复（顶部插入了新作业），但游标仍按原始 24 推进
    const page = Array.from({ length: 24 }, (_, i) => job(`n${i}`));
    expect(cursorAfterNext(prev, page, 24)).toEqual({ offset: 48, hasMore: true });
  });

  it('越界空页：hasMore=false 且 offset 不变', () => {
    const prev = { offset: 48, hasMore: true };
    expect(cursorAfterNext(prev, [], 24)).toEqual({ offset: 48, hasMore: false });
  });

  it('尾页不足：hasMore=false，offset 收齐', () => {
    const prev = { offset: 48, hasMore: true };
    const tail = Array.from({ length: 4 }, (_, i) => job(`t${i}`));
    expect(cursorAfterNext(prev, tail, 24)).toEqual({ offset: 52, hasMore: false });
  });
});

describe('needsAutoFill', () => {
  it('hasMore 且可视不足一屏 → 续拉填补（过滤不阻断滚动加载）', () => {
    expect(needsAutoFill(2, 8, true)).toBe(true);
  });

  it('可视项已够 / 无更多 → 不补', () => {
    expect(needsAutoFill(8, 8, true)).toBe(false);
    expect(needsAutoFill(2, 8, false)).toBe(false);
  });
});
