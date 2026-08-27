/**
 * 指数退避轮询（复刻 Web usePoll/trackJob 语义）
 * 默认 1s → 2s → 4s → 8s 封顶；AbortSignal 取消（页面失焦/卸载/下拉刷新替换）
 */

export interface PollOptions<T> {
  /** 每次拉取；抛错计入连续失败 */
  fetcher: () => Promise<T>;
  /** 返回 true 表示到达终态，停止轮询并返回该值 */
  shouldStop: (value: T) => boolean;
  /** 退避间隔序列（ms），最后一个值封顶复用 */
  intervals?: number[];
  /** 每次拉取后的回调（成功给值，失败给错） */
  onUpdate?: (value: T | null, error: Error | null) => void;
  signal?: AbortSignal;
  /** 连续失败上限，达到后抛出最后一次错误（默认 5） */
  maxConsecutiveErrors?: number;
}

const DEFAULT_INTERVALS = [1000, 2000, 4000, 8000];

export class PollAbortedError extends Error {
  constructor() {
    super('轮询已取消');
    this.name = 'PollAbortedError';
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof PollAbortedError ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PollAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PollAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const {
    fetcher,
    shouldStop,
    intervals = DEFAULT_INTERVALS,
    onUpdate,
    signal,
    maxConsecutiveErrors = 5,
  } = options;

  let attempt = 0;
  let consecutiveErrors = 0;

  for (;;) {
    if (signal?.aborted) throw new PollAbortedError();

    try {
      const value = await fetcher();
      consecutiveErrors = 0;
      onUpdate?.(value, null);
      if (shouldStop(value)) return value;
    } catch (err) {
      if (isAbortError(err)) throw new PollAbortedError();
      consecutiveErrors += 1;
      onUpdate?.(null, err as Error);
      if (consecutiveErrors >= maxConsecutiveErrors) throw err;
    }

    const wait = intervals[Math.min(attempt, intervals.length - 1)];
    attempt += 1;
    await sleep(wait, signal);
  }
}
