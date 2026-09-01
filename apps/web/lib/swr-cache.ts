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

/* ── IndexedDB 大容量层(L2) ─────────────────────────────────────────── */

const IDB_NAME = "toiv-cache";
const IDB_STORE = "kv";

let _idbPromise: Promise<IDBDatabase | null> | null = null;

/** 打开(并复用)IDB 连接;不可用/失败一律 resolve(null),调用方降级仅内存。 */
function idbOpen(): Promise<IDBDatabase | null> {
  if (!hasWindow() || typeof window.indexedDB === "undefined") return Promise.resolve(null);
  if (!_idbPromise) {
    _idbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return _idbPromise;
}

async function idbGet<T>(key: string): Promise<CacheEntry<T> | null> {
  const db = await idbOpen();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as CacheEntry<T> | undefined;
        resolve(v && typeof v.ts === "number" ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** fire-and-forget 写入;失败静默(内存层仍有效)。 */
function idbSet(key: string, entry: CacheEntry<unknown>): void {
  void idbOpen().then((db) => {
    if (!db) return;
    try {
      db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(entry, key);
    } catch {
      /* 忽略 */
    }
  });
}

function idbDel(key: string): void {
  void idbOpen().then((db) => {
    if (!db) return;
    try {
      db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(key);
    } catch {
      /* 忽略 */
    }
  });
}

function idbDelPrefix(prefix: string): void {
  void idbOpen().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result) {
          if (typeof k === "string" && k.startsWith(prefix)) store.delete(k);
        }
      };
    } catch {
      /* 忽略 */
    }
  });
}

/** 读缓存条目:内存 → localStorage →(large 键)IndexedDB;损坏 / 缺失返回 null。 */
async function readEntry<T>(key: string, large?: boolean): Promise<CacheEntry<T> | null> {
  const m = mem.get(key);
  if (m) return m as CacheEntry<T>;
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw) as CacheEntry<T>;
      if (typeof parsed?.ts === "number") {
        // 回填内存层,后续命中走内存。
        mem.set(key, parsed as CacheEntry<unknown>);
        return parsed;
      }
    }
  } catch {
    /* 损坏当缺失,继续探 IDB */
  }
  if (large) {
    const fromIdb = await idbGet<T>(key);
    if (fromIdb) {
      mem.set(key, fromIdb as CacheEntry<unknown>);
      return fromIdb;
    }
  }
  return null;
}

/** 不可变写入:新建条目对象,同步进内存与持久层(large→IDB,否则 LS;失败静默)。 */
function writeEntry<T>(key: string, value: T, large?: boolean): void {
  const entry: CacheEntry<T> = { value, ts: Date.now() };
  mem.set(key, entry as CacheEntry<unknown>);
  if (!hasWindow()) return;
  if (large) {
    // 大负载进 IDB;清掉可能存在的旧 LS 副本(升级迁移)
    idbSet(key, entry as CacheEntry<unknown>);
    try {
      window.localStorage.removeItem(STORE_PREFIX + key);
    } catch {
      /* 忽略 */
    }
    return;
  }
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
 * @param opts.large 大负载走 IndexedDB(会话/作品库全量等),不挤 localStorage。
 * @returns        命中即返缓存值(可能 stale),否则等待网络。
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
  opts?: { large?: boolean },
): Promise<T> {
  const entry = await readEntry<T>(key, opts?.large);
  const now = Date.now();

  // 后台刷新:并发去重,成功落盘,失败不影响已返回的缓存值。
  const revalidate = (): Promise<T> => {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fetcher()
      .then((fresh) => {
        writeEntry(key, fresh, opts?.large);
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

/** 直接写入缓存(强制刷新流程回种,如「重新检测引擎」):下次 swr 命中新鲜值。 */
export function prime<T>(key: string, value: T, opts?: { large?: boolean }): void {
  writeEntry(key, value, opts?.large);
}

/** 主动失效单个键:删内存 + 删盘(LS+IDB),下次 swr 强制走网络。 */
export function invalidate(key: string): void {
  mem.delete(key);
  inflight.delete(key);
  idbDel(key);
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
  idbDelPrefix(prefix);
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
  trainJobs: "train-jobs",
  /** 引擎注册表(含可用性) */
  engines: "engines",
  /** 助手会话列表(大负载:走 IDB) */
  sessions: "agent-sessions",
  /** 主体库清单(@ 提及数据源) */
  entities: "entities",
  /** 应用市场/融合列表(带过滤后缀,如 apps:category=video) */
  apps: "apps",
  /** Agent Team 历史 run 列表 */
  agentRuns: "agent-runs",
  /** Studio 项目列表 */
  studioProjects: "studio-projects",
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
  /** 训练作业:训练中频繁变,完成后稳定。 */
  trainJobs: 10 * 1000,
  /** 引擎注册表:可用性随 worker 上下线变,短缓存 + 「重新检测」prime 回种。 */
  engines: 60 * 1000,
  /** 会话列表:发消息/删除即变,短缓存 + 写路径显式失效。 */
  sessions: 30 * 1000,
  /** 主体库:偶有增删改,中长缓存 + CRUD 显式失效。 */
  entities: 5 * 60 * 1000,
  /** 应用市场:偶有 fork/导入,中长缓存 + 写路径显式失效。 */
  apps: 5 * 60 * 1000,
  /** Agent run 列表:运行中状态流转快,极短缓存仅去重连击。 */
  agentRuns: 15 * 1000,
  /** Studio 项目列表:短缓存 + 增删改显式失效。 */
  studioProjects: 30 * 1000,
} as const;
