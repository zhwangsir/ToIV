/**
 * 轻量本机内容缓存(stale-while-revalidate)。
 *
 * 目标:把读多写少、跨视图反复拉取的列表(模型 / 本地模型 / 账户 / 作品)
 * 缓存到「内存 + localStorage」,二访秒开并显著减轻服务器负载。
 *
 * 语义:
 *  - 首次:无缓存 → 直接走网络,落盘。
 *  - 再访:命中(未过期)→ 立即返回缓存值,不打网络。
 *           命中但已过期(stale)→ 仍立即返回旧值(避免白屏),后台拉新覆盖,下次更新。
 *  - 失效:写操作(切 R18 / 生成新作品)主动 invalidate 指定键,下次强制走网络。
 *
 * 所有写入均不可变:缓存条目以新对象整体替换,绝不就地修改已读出的引用。
 * SSR / 无 window 时缓存层退化为「每次直连」,不抛错。
 */

interface CacheEntry<T> {
  /** 缓存的负载(已是反序列化后的结构)。 */
  value: T;
  /** 写入时间戳(ms),与 TTL 比较判断是否过期。 */
  ts: number;
}

/** localStorage 命名空间前缀;升级缓存结构时改 v 号即整体作废旧盘缓存。 */
const STORE_PREFIX = "toiv_swr_v1:";

/** 进程内内存层:比 localStorage 更快,跨视图切换零反序列化开销。 */
const mem = new Map<string, CacheEntry<unknown>>();

/** 同键 revalidate 去重:并发读不重复打网络,共享同一 in-flight Promise。 */
const inflight = new Map<string, Promise<unknown>>();

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** 从内存优先、localStorage 兜底读出缓存条目;损坏 / 缺失返回 null。 */
function readEntry<T>(key: string): CacheEntry<T> | null {
  const m = mem.get(key);
  if (m) return m as CacheEntry<T>;
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (typeof parsed?.ts !== "number") return null;
    // 回填内存层,后续命中走内存。
    mem.set(key, parsed as CacheEntry<unknown>);
    return parsed;
  } catch {
    return null;
  }
}

/** 不可变写入:新建条目对象,同步进内存与 localStorage(后者失败静默)。 */
function writeEntry<T>(key: string, value: T): void {
  const entry: CacheEntry<T> = { value, ts: Date.now() };
  mem.set(key, entry as CacheEntry<unknown>);
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* 配额满 / 隐私模式:仅丢盘缓存,内存层仍有效 */
  }
}

/**
 * stale-while-revalidate 取数。
 *
 * @param key      缓存键(同一资源全局唯一)。
 * @param fetcher  实际网络取数函数(缓存未命中 / 后台刷新时调用)。
 * @param ttlMs    新鲜窗口;在此窗口内的缓存视为 fresh,不触发后台刷新。
 * @returns        命中即返缓存值(可能 stale),否则等待网络。
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
): Promise<T> {
  const entry = readEntry<T>(key);
  const now = Date.now();

  // 后台刷新:并发去重,成功落盘,失败不影响已返回的缓存值。
  const revalidate = (): Promise<T> => {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fetcher()
      .then((fresh) => {
        writeEntry(key, fresh);
        return fresh;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p as Promise<unknown>);
    return p;
  };

  if (entry) {
    const fresh = now - entry.ts < ttlMs;
    // 过期才后台刷新;新鲜则直接用,避免无谓请求。
    if (!fresh) void revalidate().catch(() => undefined);
    return entry.value;
  }

  // 无缓存:必须等网络(同时也填充缓存)。
  return revalidate();
}

/** 主动失效单个键:删内存 + 删盘,下次 swr 强制走网络。 */
export function invalidate(key: string): void {
  mem.delete(key);
  inflight.delete(key);
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    /* 忽略 */
  }
}

/** 按前缀批量失效(如 R18 切换时清掉所有受其影响的列表缓存)。 */
export function invalidatePrefix(prefix: string): void {
  for (const k of Array.from(mem.keys())) {
    if (k.startsWith(prefix)) {
      mem.delete(k);
      inflight.delete(k);
    }
  }
  if (!hasWindow()) return;
  try {
    const full = STORE_PREFIX + prefix;
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(full)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    /* 忽略 */
  }
}

/** 缓存键常量:集中管理避免散落字符串拼写漂移。 */
export const CACHE_KEYS = {
  models: "models",
  localModels: "local-models",
  me: "me",
  jobs: "jobs",
} as const;

/** 默认 TTL(ms):按资源更新频率分档。 */
export const TTL = {
  /** 模型列表:几乎不变,长缓存。 */
  models: 5 * 60 * 1000,
  /** 本地已装模型:偶有安装,中等。 */
  localModels: 5 * 60 * 1000,
  /** 账户(含 R18 态 / 用量):较易变,短缓存。 */
  me: 60 * 1000,
  /** 作品库:生成后即变,短缓存 + 生成完显式失效。 */
  jobs: 30 * 1000,
} as const;
