import { pollUntil, PollAbortedError } from '../poll';

describe('pollUntil 指数退避轮询', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('到达终态即返回最新值', async () => {
    const seq = ['queued', 'running', 'done'];
    const fetcher = jest.fn(async () => seq.shift() ?? 'done');
    const promise = pollUntil({
      fetcher,
      shouldStop: (s) => s === 'done',
      intervals: [10, 20],
    });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('done');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('按退避序列等待并封顶', async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const fetcher = jest.fn(async () => {
      timestamps.push(Date.now());
      calls += 1;
      return calls >= 4 ? 'done' : 'running';
    });
    const promise = pollUntil({
      fetcher,
      shouldStop: (s) => s === 'done',
      intervals: [100, 200, 400],
    });
    await jest.runAllTimersAsync();
    await promise;
    // 间隔：100、200、400（第 3 次后仍用封顶值 400，但第 4 次已成功返回）
    expect(timestamps[1] - timestamps[0]).toBe(100);
    expect(timestamps[2] - timestamps[1]).toBe(200);
    expect(timestamps[3] - timestamps[2]).toBe(400);
  });

  it('连续失败达到上限后抛出', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('network down');
    });
    const promise = pollUntil({
      fetcher,
      shouldStop: () => false,
      intervals: [10],
      maxConsecutiveErrors: 3,
    });
    const assertion = expect(promise).rejects.toThrow('network down');
    await jest.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('AbortSignal 取消时抛 PollAbortedError 且不再拉取', async () => {
    const controller = new AbortController();
    const fetcher = jest.fn(async () => 'running');
    const promise = pollUntil({
      fetcher,
      shouldStop: () => false,
      intervals: [1000],
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(PollAbortedError);
    controller.abort();
    await jest.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('onUpdate 成功给值、失败给错', async () => {
    const updates: { value: string | null; error: Error | null }[] = [];
    let calls = 0;
    const fetcher = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return 'done';
    });
    const promise = pollUntil({
      fetcher,
      shouldStop: (s) => s === 'done',
      intervals: [10],
      onUpdate: (value, error) => updates.push({ value, error }),
    });
    await jest.runAllTimersAsync();
    await promise;
    expect(updates[0].error?.message).toBe('flaky');
    expect(updates[1].value).toBe('done');
  });
});
