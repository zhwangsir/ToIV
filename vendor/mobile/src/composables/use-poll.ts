/**
 * 指数退避轮询（复刻 Mobile lib/poll.ts 语义）
 * 默认 1s → 2s → 4s → 8s 封顶；协作式取消（页面失焦/卸载/下拉刷新替换）
 * 小程序端 AbortController 不可靠，用 { cancelled } 句柄替代
 */

export interface PollHandle {
  cancelled: boolean;
}

export interface PollOptions<T> {
  /** 每次拉取；抛错计入连续失败 */
  fetcher: () => Promise<T>;
  /** 返回 true 表示到达终态，停止轮询并返回该值 */
  shouldStop: (value: T) => boolean;
  /** 退避间隔序列（ms），最后一个值封顶复用 */
  intervals?: number[];
  /** 每次拉取后的回调（成功给值，失败给错） */
  onUpdate?: (value: T | null, error: Error | null) => void;
  /** 取消句柄（cancelPoll 或自行置 cancelled） */
  handle?: PollHandle;
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

export function createPollHandle(): PollHandle {
  return { cancelled: false };
}

export function cancelPoll(handle: PollHandle | undefined): void {
  if (handle) handle.cancelled = true;
}

function sleep(ms: number, handle?: PollHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    if (handle?.cancelled) {
      reject(new PollAbortedError());
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    // 轮询间隔中每 100ms 检查一次取消标志，保证及时退出
    const checker = setInterval(() => {
      if (handle?.cancelled) {
        clearTimeout(timer);
        clearInterval(checker);
        reject(new PollAbortedError());
      }
    }, 100);
    setTimeout(() => clearInterval(checker), ms + 20);
  });
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const {
    fetcher,
    shouldStop,
    intervals = DEFAULT_INTERVALS,
    onUpdate,
    handle,
    maxConsecutiveErrors = 5,
  } = options;

  let attempt = 0;
  let consecutiveErrors = 0;

  for (;;) {
    if (handle?.cancelled) throw new PollAbortedError();

    try {
      const value = await fetcher();
      if (handle?.cancelled) throw new PollAbortedError();
      consecutiveErrors = 0;
      onUpdate?.(value, null);
      if (shouldStop(value)) return value;
    } catch (err) {
      if (err instanceof PollAbortedError) throw err;
      consecutiveErrors += 1;
      onUpdate?.(null, err as Error);
      if (consecutiveErrors >= maxConsecutiveErrors) throw err;
    }

    const wait = intervals[Math.min(attempt, intervals.length - 1)];
    attempt += 1;
    await sleep(wait, handle);
  }
}
