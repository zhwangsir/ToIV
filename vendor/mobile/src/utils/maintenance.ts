/**
 * 设置页维护工具（MP26）：缓存清理计划 + 诊断信息组装 + 字节格式化
 * - 纯函数可单测；uni.* 副作用调用留在页面层
 */

/** 字节数 → 可读文本（1024 进制，非整数保留一位小数，整数去尾零） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${trimOne(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimOne(mb)} MB`;
  return `${trimOne(mb / 1024)} GB`;
}

function trimOne(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 缓存清理白名单：精确键 + 前缀（前缀命中即保护） */
export interface CacheWhitelist {
  exact: readonly string[];
  prefixes: readonly string[];
}

/**
 * 出厂白名单：登录会话（token + 缓存用户快照）+ 设置（主题/色板/API 覆盖/NSFW）+ 助手草稿（用户数据）
 * 键名与 stores/api 层落盘键保持一致，改动需同步
 */
export const CACHE_WHITELIST: CacheWhitelist = {
  exact: ['toiv_token', 'toiv.cachedUser', 'toiv.settings'],
  prefixes: ['assistant_draft:'],
};

export interface CacheClearPlan {
  /** 将删除的键（保持输入顺序） */
  toRemove: string[];
  /** 白名单保护的键（保持输入顺序） */
  toKeep: string[];
}

/** 缓存清理计划：白名单（精确 + 前缀）保护，其余待删；不改入参 */
export function planCacheClear(
  keys: readonly string[],
  whitelist: CacheWhitelist = CACHE_WHITELIST,
): CacheClearPlan {
  const toRemove: string[] = [];
  const toKeep: string[] = [];
  for (const key of keys) {
    const keep =
      whitelist.exact.includes(key) || whitelist.prefixes.some((p) => key.startsWith(p));
    (keep ? toKeep : toRemove).push(key);
  }
  return { toRemove, toKeep };
}

/** 持久化键统计（仅键名 + 估算大小，绝不含值——诊断脱敏的结构保证） */
export interface StorageKeyStat {
  key: string;
  /** 估算字节 = 键长 + 值长（UTF-16 code unit 口径，估算语义） */
  size: number;
}

export interface DiagnosticsInput {
  app: { name: string; version: string };
  env: {
    /** 编译期平台（h5 / mp-weixin / ...） */
    platform: string;
    /** 操作系统描述（设备平台 + 系统版本） */
    system: string;
    pixelRatio: number;
    /** 小程序基础库版本（无则 null） */
    sdkVersion: string | null;
    /** 宿主版本（微信版本 / 浏览器版本，无则 null） */
    hostVersion: string | null;
  };
  /** effective API 基址（含用户覆盖） */
  apiBase: string;
  /** 登录态有无（token 本体不进诊断） */
  loggedIn: boolean;
  nsfwIntent: boolean;
  storageKeys: StorageKeyStat[];
  /** 生成时间（ISO，注入便于单测） */
  now: string;
}

export interface Diagnostics {
  app: { name: string; version: string };
  env: DiagnosticsInput['env'];
  apiBase: string;
  session: { loggedIn: boolean };
  features: { nsfwIntent: boolean };
  storage: { keys: StorageKeyStat[]; totalSize: number; totalSizeText: string };
  generatedAt: string;
}

/** 组装诊断对象：输入即输出 + storage 合计；脱敏由输入侧结构保证（只收键名+大小、登录态布尔） */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const keys = input.storageKeys.map((k) => ({ key: k.key, size: k.size }));
  const totalSize = keys.reduce((sum, k) => sum + k.size, 0);
  return {
    app: { name: input.app.name, version: input.app.version },
    env: { ...input.env },
    apiBase: input.apiBase,
    session: { loggedIn: input.loggedIn },
    features: { nsfwIntent: input.nsfwIntent },
    storage: { keys, totalSize, totalSizeText: formatBytes(totalSize) },
    generatedAt: input.now,
  };
}
