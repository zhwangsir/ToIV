/**
 * 设置页纯函数层（M26）：缓存占用估算 / 清理计划与执行 / 诊断信息组装
 * - expo-file-system v57 新 API：Directory.size / list() / File.delete() 均为同步
 *   （读 v57 官方文档确认；与 lib/media.ts 的 File/Paths 用法同源）
 * - MMKV 走全局实例（lib/mmkv，同步读写）；token 只存 expo-secure-store 不在 MMKV，
 *   天然不在清理范围（开发规范禁令 3）
 */
import { Directory, Paths } from 'expo-file-system';

import { storage } from '@/lib/mmkv';

/** 清理白名单：exact 精确匹配 + prefixes 前缀匹配（对话草稿一族） */
export interface CacheWhitelist {
  exact: string[];
  prefixes: string[];
}

/**
 * 白名单锚点：设置（含主题/API 覆盖/NSFW 的 zustand persist 键）与登录态快照保留；
 * 对话草稿 `assistant_draft:*` 保留（M24 用户未发送的输入不属于缓存）
 */
export const CACHE_CLEAR_WHITELIST: CacheWhitelist = {
  exact: ['toiv.settings', 'toiv.cachedUser'],
  prefixes: ['assistant_draft:'],
};

/** 字节数 → 人话：<1KB `{n} B`；<1MB `{x.x} KB`；<1GB `{x.x} MB`；否则 `{x.x} GB`；负数/NaN 按 0 */
export function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface CacheClearPlan {
  /** 将删：不在白名单的缓存键 */
  toDelete: string[];
  /** 将留：白名单键 */
  toKeep: string[];
}

/** 清理计划：白名单（exact / prefixes）保留，其余删除；不改入参，保持原顺序分组 */
export function planCacheClear(keys: string[], whitelist: CacheWhitelist): CacheClearPlan {
  const toDelete: string[] = [];
  const toKeep: string[] = [];
  for (const key of keys) {
    const keep =
      whitelist.exact.includes(key) || whitelist.prefixes.some((p) => key.startsWith(p));
    (keep ? toKeep : toDelete).push(key);
  }
  return { toDelete, toKeep };
}

/** MMKV 键值大小估算（字符串长度近似；值不存在按 0） */
function cacheValueSize(key: string): number {
  return storage.getString(key)?.length ?? 0;
}

/** 估算可清理缓存占用：cache 目录大小 + MMKV 非白名单键值大小 */
export function estimateCacheBytes(): number {
  let bytes = 0;
  try {
    bytes += new Directory(Paths.cache).size ?? 0;
  } catch {
    // 目录不可读按 0 计
  }
  const { toDelete } = planCacheClear(storage.getAllKeys(), CACHE_CLEAR_WHITELIST);
  for (const key of toDelete) bytes += cacheValueSize(key);
  return bytes;
}

/**
 * 执行缓存清理：逐项删除 cache 目录内容（保留目录本身）+ 移除 MMKV 非白名单键
 * 单项失败跳过不中断；返回释放字节数（估算口径同 estimateCacheBytes，删除失败项不计）
 */
export function clearCache(): number {
  let freed = 0;
  try {
    const dir = new Directory(Paths.cache);
    for (const item of dir.list()) {
      try {
        item.delete();
        freed += item.size ?? 0;
      } catch {
        // 单项删除失败：跳过，大小不计入释放
      }
    }
  } catch {
    // cache 目录不可读按无文件缓存
  }
  const { toDelete } = planCacheClear(storage.getAllKeys(), CACHE_CLEAR_WHITELIST);
  for (const key of toDelete) {
    freed += cacheValueSize(key);
    storage.remove(key);
  }
  return freed;
}

/**
 * 诊断信息入参（调用方采集后传入）
 * 脱敏契约：本结构就没有 token 字段；storageKeys 仅键名 + 大小，不含值
 */
export interface DiagnosticsInput {
  appName: string;
  appVersion: string;
  platform: string;
  osVersion: string | number;
  deviceModel: string | null;
  pixelRatio: number;
  apiBase: string;
  /** 登录态有无（布尔，不含 token） */
  signedIn: boolean;
  nsfwIntent: boolean;
  storageKeys: { key: string; size: number }[];
  generatedAt: Date;
}

/** 诊断信息（导出到剪贴板的 JSON 形状） */
export interface Diagnostics {
  app: { name: string; version: string };
  device: { platform: string; osVersion: string; model: string | null; pixelRatio: number };
  config: { apiBase: string; signedIn: boolean; nsfwIntent: boolean };
  storage: { keys: { key: string; size: number }[]; totalBytes: number };
  generatedAt: string;
}

/** 组装诊断对象：osVersion 归一字符串；totalBytes 键大小合计；时间戳 ISO */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const keys = input.storageKeys.map((k) => ({ key: k.key, size: k.size }));
  return {
    app: { name: input.appName, version: input.appVersion },
    device: {
      platform: input.platform,
      osVersion: String(input.osVersion),
      model: input.deviceModel,
      pixelRatio: input.pixelRatio,
    },
    config: {
      apiBase: input.apiBase,
      signedIn: input.signedIn,
      nsfwIntent: input.nsfwIntent,
    },
    storage: {
      keys,
      totalBytes: keys.reduce((sum, k) => sum + k.size, 0),
    },
    generatedAt: input.generatedAt.toISOString(),
  };
}

/** 采集 MMKV 存储键清单：仅键名 + 值大小，不透出值本体 */
export function collectStorageKeyStats(): { key: string; size: number }[] {
  return storage
    .getAllKeys()
    .map((key) => ({ key, size: storage.getString(key)?.length ?? 0 }));
}
