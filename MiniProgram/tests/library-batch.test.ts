import { describe, expect, it } from 'vitest';

import type { JobItem } from '@/types/api';
import {
  BATCH_CONCURRENCY,
  type BatchItemResult,
  deleteSummaryText,
  runBatch,
  saveSummaryText,
  selectAll,
  splitSavable,
  summarizeBatch,
  toggleSelect,
} from '@/utils/library-batch';

function job(partial: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: 'a cat',
    seed: 42,
    created_at: '2026-08-13T10:00:00',
    results: ['outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: true,
    ...partial,
  };
}

describe('toggleSelect', () => {
  it('未选 id 加入集合，且不改入参（不可变语义）', () => {
    const origin = new Set(['a']);
    const next = toggleSelect(origin, 'b');
    expect([...next].sort()).toEqual(['a', 'b']);
    expect([...origin]).toEqual(['a']);
    expect(next).not.toBe(origin);
  });

  it('已选 id 再 toggle 则移除', () => {
    const next = toggleSelect(new Set(['a', 'b']), 'a');
    expect([...next]).toEqual(['b']);
  });

  it('空集合 toggle 出单项', () => {
    expect([...toggleSelect(new Set<string>(), 'x')]).toEqual(['x']);
  });
});

describe('selectAll', () => {
  it('返回当前已加载项全量 id 集合', () => {
    const items = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })];
    expect([...selectAll(items)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('空数组 → 空集合', () => {
    expect(selectAll([]).size).toBe(0);
  });
});

describe('splitSavable', () => {
  it('image/video 进可保存，audio/3d/未知进跳过，保持相对顺序', () => {
    const items = [
      job({ id: 'img', kind: 'txt2img' }),
      job({ id: 'aud', kind: 'ace_audio' }),
      job({ id: 'vid', kind: 'wan_t2v' }),
      job({ id: '3d', kind: 'hunyuan3d' }),
      job({ id: 'unk', kind: 'some_new_kind' }),
    ];
    const { savable, skipped } = splitSavable(items);
    expect(savable.map((j) => j.id)).toEqual(['img', 'vid']);
    expect(skipped.map((j) => j.id)).toEqual(['aud', '3d', 'unk']);
  });

  it('全不可保存 → savable 为空', () => {
    const { savable, skipped } = splitSavable([
      job({ id: 'a', kind: 'audio' }),
      job({ id: 'b', kind: '3d' }),
    ]);
    expect(savable).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('新图像/视频 kind 可保存，音频/3D 新 kind 跳过', () => {
    const items = [
      job({ id: 'qe', kind: 'qwen_edit' }),
      job({ id: 'ms', kind: 'h3_multishot' }),
      job({ id: 'tr', kind: 'transition' }),
      job({ id: 'mv', kind: 'manju_voice' }),
      job({ id: 'tm', kind: 'threed_material' }),
    ];
    const { savable, skipped } = splitSavable(items);
    expect(savable.map((j) => j.id)).toEqual(['qe', 'ms', 'tr']);
    expect(skipped.map((j) => j.id)).toEqual(['mv', 'tm']);
  });
});

function resultOf(jobs: JobItem[], failIds: string[] = []): BatchItemResult<JobItem>[] {
  return jobs.map((j) =>
    failIds.includes(j.id)
      ? { item: j, ok: false, error: 'mock 失败' }
      : { item: j, ok: true },
  );
}

describe('summarizeBatch', () => {
  it('全成功：failed=0，failedIds 为空', () => {
    const summary = summarizeBatch(resultOf([job({ id: 'a' }), job({ id: 'b' })]));
    expect(summary).toEqual({ total: 2, succeeded: 2, failed: 0, failedIds: [] });
  });

  it('部分失败：failedIds 按输入序收集', () => {
    const summary = summarizeBatch(
      resultOf([job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })], ['c', 'a']),
    );
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.failedIds).toEqual(['a', 'c']);
  });
});

describe('deleteSummaryText', () => {
  it('全成 → 已删除 N 项', () => {
    expect(deleteSummaryText({ total: 3, succeeded: 3, failed: 0, failedIds: [] })).toBe(
      '已删除 3 项',
    );
  });

  it('部分失败 → 成功 N 失败 M，失败项已保留勾选', () => {
    expect(
      deleteSummaryText({ total: 3, succeeded: 1, failed: 2, failedIds: ['b', 'c'] }),
    ).toBe('成功 1 失败 2，失败项已保留勾选');
  });

  it('全败 → 删除失败，请稍后重试（不报「成功 0」）', () => {
    expect(
      deleteSummaryText({ total: 2, succeeded: 0, failed: 2, failedIds: ['a', 'b'] }),
    ).toBe('删除失败，请稍后重试');
  });
});

describe('saveSummaryText', () => {
  it('全成无跳过 → 已保存 N 项', () => {
    expect(saveSummaryText({ total: 2, succeeded: 2, failed: 0, failedIds: [] }, 0)).toBe(
      '已保存 2 项',
    );
  });

  it('全成有跳过 → 已保存 N 项，M 项不支持保存', () => {
    expect(saveSummaryText({ total: 2, succeeded: 2, failed: 0, failedIds: [] }, 2)).toBe(
      '已保存 2 项，2 项不支持保存',
    );
  });

  it('有失败无跳过 → 已保存 N 项，M 项保存失败', () => {
    expect(
      saveSummaryText({ total: 2, succeeded: 1, failed: 1, failedIds: ['b'] }, 0),
    ).toBe('已保存 1 项，1 项保存失败');
  });

  it('跳过 + 失败组合 → 已保存 N 项，M 项不支持，K 项失败', () => {
    expect(
      saveSummaryText({ total: 2, succeeded: 1, failed: 1, failedIds: ['b'] }, 1),
    ).toBe('已保存 1 项，1 项不支持，1 项失败');
  });

  it('全败 → 保存失败，请检查相册权限', () => {
    expect(
      saveSummaryText({ total: 2, succeeded: 0, failed: 2, failedIds: ['a', 'b'] }, 0),
    ).toBe('保存失败，请检查相册权限');
  });

  it('全跳过（无可保存项）→ 仅图像与视频支持保存相册', () => {
    expect(saveSummaryText({ total: 0, succeeded: 0, failed: 0, failedIds: [] }, 3)).toBe(
      '仅图像与视频支持保存相册',
    );
  });
});

describe('runBatch', () => {
  it('全成功：结果全 ok 且与输入同序，进度回调 1..N', async () => {
    const items = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' }), job({ id: 'd' })];
    const progress: Array<[number, number]> = [];
    const results = await runBatch(items, async () => undefined, {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(results.map((r) => r.item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it('部分失败：对应项 ok:false 带错误文案，其余成功（失败项可由调用方保留勾选）', async () => {
    const items = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })];
    const results = await runBatch(
      items,
      async (j) => {
        if (j.id === 'b') throw new Error('网络连接失败');
      },
      { concurrency: 2 },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]?.error).toBe('网络连接失败');
    const summary = summarizeBatch(results);
    expect(summary.failedIds).toEqual(['b']);
  });

  it('并发限速：峰值在途数 ≤ BATCH_CONCURRENCY', async () => {
    const items = Array.from({ length: 10 }, (_, i) => job({ id: `j${i}` }));
    let inflight = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const resultsPromise = runBatch(
      items,
      async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise<void>((resolve) => gate.push(resolve));
        inflight -= 1;
      },
      { concurrency: BATCH_CONCURRENCY },
    );
    // 等首批 lane 全部挂起后一次性放行，观察峰值
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBeLessThanOrEqual(BATCH_CONCURRENCY);
    while (gate.length > 0) gate.shift()?.();
    // 后续 lane 会再挂起，持续放行直至结束（有界循环防 no-constant-condition，200×10ms 足够 10 项跑完）
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      while (gate.length > 0) gate.shift()?.();
      let settled = false;
      await Promise.race([
        resultsPromise.then(() => {
          settled = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 5)),
      ]);
      if (settled) break;
    }
    const results = await resultsPromise;
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(BATCH_CONCURRENCY);
  });

  it('默认并发即 BATCH_CONCURRENCY（≤3）', () => {
    expect(BATCH_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('空输入 → 空结果，无进度回调', async () => {
    let called = 0;
    const results = await runBatch([], async () => undefined, { onProgress: () => (called += 1) });
    expect(results).toEqual([]);
    expect(called).toBe(0);
  });
});
