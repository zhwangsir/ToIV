import { describe, expect, it, vi } from 'vitest';

import { cancelPoll, createPollHandle, PollAbortedError, pollUntil } from '@/composables/use-poll';

describe('pollUntil', () => {
  it('到达终态即停止并返回', async () => {
    vi.useFakeTimers();
    const values = [1, 2, 3];
    const fetcher = vi.fn(async () => values.shift() ?? 3);
    const promise = pollUntil({
      fetcher,
      shouldStop: (v) => v === 3,
      intervals: [10, 20],
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('onUpdate 收到每次成功值', async () => {
    vi.useFakeTimers();
    const updates: number[] = [];
    const promise = pollUntil({
      fetcher: async () => 1,
      shouldStop: () => true,
      onUpdate: (v) => {
        if (v !== null) updates.push(v);
      },
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(updates).toEqual([1]);
    vi.useRealTimers();
  });

  it('取消句柄触发 PollAbortedError', async () => {
    vi.useFakeTimers();
    const handle = createPollHandle();
    const promise = pollUntil({
      fetcher: async () => 'pending',
      shouldStop: () => false,
      intervals: [100],
      handle,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(PollAbortedError);
    cancelPoll(handle);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it('连续失败达到上限抛出最后错误', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollUntil({
      fetcher: async () => {
        calls += 1;
        throw new Error(`boom-${calls}`);
      },
      shouldStop: () => false,
      intervals: [1],
      maxConsecutiveErrors: 3,
    });
    const assertion = expect(promise).rejects.toThrow('boom-3');
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it('失败后成功会重置连续失败计数', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollUntil({
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error('flaky');
        return 'done';
      },
      shouldStop: (v) => v === 'done',
      intervals: [1],
      maxConsecutiveErrors: 2,
    });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('done');
    vi.useRealTimers();
  });
});
