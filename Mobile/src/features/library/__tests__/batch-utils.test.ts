import type { JobItem } from '@/types/api';

import {
  BATCH_CONCURRENCY,
  runBatchLimited,
  selectAllIds,
  splitSavable,
  summarizeBatch,
  toggleSelect,
} from '../batch-utils';

function makeJob(overrides: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: '一只猫',
    seed: 7,
    created_at: new Date().toISOString(),
    results: ['/outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: false,
    ...overrides,
  };
}

describe('toggleSelect', () => {
  it('未选 → 加入；已选 → 移除', () => {
    const s0 = new Set<string>();
    const s1 = toggleSelect(s0, 'a');
    expect([...s1]).toEqual(['a']);
    const s2 = toggleSelect(s1, 'b');
    expect([...s2].sort()).toEqual(['a', 'b']);
    const s3 = toggleSelect(s2, 'a');
    expect([...s3]).toEqual(['b']);
  });

  it('返回新 Set，不改入参（useState 直接落）', () => {
    const s0 = new Set(['a']);
    const s1 = toggleSelect(s0, 'b');
    expect(s1).not.toBe(s0);
    expect([...s0]).toEqual(['a']);
  });
});

describe('selectAllIds', () => {
  it('拍平项全部入集', () => {
    const ids = selectAllIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('空列表 → 空集', () => {
    expect(selectAllIds([]).size).toBe(0);
  });
});

describe('splitSavable', () => {
  it('image/video/未知 kind 可保存，audio/3D 跳过计数', () => {
    const jobs = [
      makeJob({ id: 'img', kind: 'txt2img' }),
      makeJob({ id: 'vid', kind: 'wan_t2v', results: ['/v.mp4'] }),
      makeJob({ id: 'aud', kind: 'ace_audio', results: ['/a.mp3'] }),
      makeJob({ id: 'm3d', kind: 'hunyuan3d', results: ['/m.glb'] }),
      makeJob({ id: 'xyz', kind: 'unknown_future', results: ['/x.bin'] }),
    ];
    const { savable, skipped } = splitSavable(jobs);
    expect(savable.map((j) => j.id)).toEqual(['img', 'vid', 'xyz']);
    expect(skipped).toBe(2);
  });

  it('全部不可保存：savable 空、skipped 为总数', () => {
    const jobs = [
      makeJob({ id: 'a1', kind: 'audio' }),
      makeJob({ id: 'a2', kind: 'model3d' }),
    ];
    const { savable, skipped } = splitSavable(jobs);
    expect(savable).toEqual([]);
    expect(skipped).toBe(2);
  });
});

describe('summarizeBatch', () => {
  it('删除全成：已删除 N 项', () => {
    expect(summarizeBatch({ action: 'delete', succeeded: 3, failed: 0 })).toBe('已删除 3 项');
  });

  it('删除部分失败：成功 N 失败 M，失败项已保留勾选', () => {
    expect(summarizeBatch({ action: 'delete', succeeded: 2, failed: 1 })).toBe(
      '成功 2 项，失败 1 项，失败项已保留勾选',
    );
  });

  it('保存全成：已保存 N 项到相册', () => {
    expect(summarizeBatch({ action: 'save', succeeded: 2, failed: 0 })).toBe(
      '已保存 2 项到相册',
    );
  });

  it('保存含跳过：跳过计数进文案', () => {
    expect(summarizeBatch({ action: 'save', succeeded: 2, failed: 0, skipped: 1 })).toBe(
      '已保存 2 项到相册，跳过 1 项不支持的类型',
    );
  });

  it('保存含失败与跳过：两项计数都进文案', () => {
    expect(summarizeBatch({ action: 'save', succeeded: 1, failed: 1, skipped: 1 })).toBe(
      '已保存 1 项到相册，失败 1 项，跳过 1 项不支持的类型',
    );
  });

  it('保存全跳过（audio/3D）：说明不支持保存', () => {
    expect(summarizeBatch({ action: 'save', succeeded: 0, failed: 0, skipped: 2 })).toBe(
      '已跳过 2 项（音频与 3D 作品不支持保存到相册）',
    );
  });
});

describe('runBatchLimited', () => {
  it('并发 1 时按序执行，进度逐项回报 done/total', async () => {
    const calls: string[] = [];
    const progress: [number, number][] = [];
    const fn = jest.fn(async (id: string) => {
      calls.push(id);
    });
    const result = await runBatchLimited(['a', 'b', 'c'], fn, {
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(result).toEqual({ succeeded: ['a', 'b', 'c'], failed: [] });
  });

  it('同时在跑的任务数不超过并发上限', async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: (() => void)[] = [];
    const fn = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        }),
    );
    const run = runBatchLimited(['a', 'b', 'c', 'd', 'e'], fn, { concurrency: 2 });
    // 让已启动的工作进入等待：只放行 concurrency 个
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvers).toHaveLength(2);
    expect(maxActive).toBe(2);
    // 逐个放行，池子补位但峰值并发始终 ≤2
    while (resolvers.length > 0) {
      const release = resolvers.shift();
      release?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(maxActive).toBeLessThanOrEqual(2);
    }
    await run;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('单项失败不中断：失败 id 收集，其余继续完成', async () => {
    const attempted: string[] = [];
    const fn = jest.fn(async (id: string) => {
      attempted.push(id);
      if (id === 'b') throw new Error('boom');
    });
    const result = await runBatchLimited(['a', 'b', 'c'], fn, { concurrency: 1 });
    expect(attempted).toEqual(['a', 'b', 'c']);
    expect(result.succeeded).toEqual(['a', 'c']);
    expect(result.failed).toEqual(['b']);
  });

  it('空输入：不调用 fn，直接返回空结果', async () => {
    const fn = jest.fn();
    const result = await runBatchLimited([], fn);
    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual({ succeeded: [], failed: [] });
  });

  it('批量并发上限 ≤3（无批量端点，客户端循环限速）', () => {
    expect(BATCH_CONCURRENCY).toBeLessThanOrEqual(3);
    expect(BATCH_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});
