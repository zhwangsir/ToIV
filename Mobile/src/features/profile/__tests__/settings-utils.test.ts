import { Directory } from 'expo-file-system';

import { storage } from '@/lib/mmkv';

import {
  buildDiagnostics,
  CACHE_CLEAR_WHITELIST,
  clearCache,
  collectStorageKeyStats,
  estimateCacheBytes,
  formatBytes,
  planCacheClear,
} from '../settings-utils';

// react-native-mmkv 由 jest moduleNameMapper 全局替换为内存替身（src/test/mmkv-mock.ts）
// expo-file-system v57 新 API（Directory.size/list() 同步、File.delete()）jest 替身
jest.mock('expo-file-system', () => {
  class MockDirectory {
    static sizeValue: number | null = 0;
    static listItems: { name: string; size: number | null; delete: jest.Mock }[] = [];
    static throws = false;
    get size(): number | null {
      if (MockDirectory.throws) throw new Error('unreadable');
      return MockDirectory.sizeValue;
    }
    list(): { name: string; size: number | null; delete: jest.Mock }[] {
      if (MockDirectory.throws) throw new Error('unreadable');
      return MockDirectory.listItems;
    }
  }
  return {
    Paths: { cache: { uri: 'file:///mock/cache' } },
    Directory: MockDirectory,
  };
});

const mockDir = Directory as unknown as {
  sizeValue: number | null;
  listItems: { name: string; size: number | null; delete: jest.Mock }[];
  throws: boolean;
};

beforeEach(() => {
  storage.clearAll();
  mockDir.sizeValue = 0;
  mockDir.listItems = [];
  mockDir.throws = false;
});

describe('formatBytes（M26 字节数人话）', () => {
  it('0 / 负数 / NaN 归一为 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-10)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('不足 1KB 直显字节（取整）', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('KB / MB / GB 档一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('planCacheClear（M26 清理计划纯函数）', () => {
  it('白名单 exact 与前缀保留，其余进入待删', () => {
    const keys = ['toiv.settings', 'toiv.cachedUser', 'assistant_draft:s1', 'img_a', 'tmp_b'];
    const plan = planCacheClear(keys, CACHE_CLEAR_WHITELIST);
    expect(plan.toKeep).toEqual(['toiv.settings', 'toiv.cachedUser', 'assistant_draft:s1']);
    expect(plan.toDelete).toEqual(['img_a', 'tmp_b']);
  });

  it('前缀仅开头匹配（中间出现不算）', () => {
    const plan = planCacheClear(['x_assistant_draft:s1'], CACHE_CLEAR_WHITELIST);
    expect(plan.toDelete).toEqual(['x_assistant_draft:s1']);
  });

  it('不改入参，空数组进 → 双空出', () => {
    const keys = Object.freeze(['a', 'b']) as unknown as string[];
    const plan = planCacheClear(keys, CACHE_CLEAR_WHITELIST);
    expect(keys).toEqual(['a', 'b']);
    expect(planCacheClear([], CACHE_CLEAR_WHITELIST)).toEqual({ toDelete: [], toKeep: [] });
    expect(plan.toDelete).toEqual(['a', 'b']);
  });

  it('白名单契约：token 之外的登录态/设置/对话草稿锚点固定', () => {
    expect(CACHE_CLEAR_WHITELIST.exact).toEqual(['toiv.settings', 'toiv.cachedUser']);
    expect(CACHE_CLEAR_WHITELIST.prefixes).toEqual(['assistant_draft:']);
  });
});

describe('estimateCacheBytes（M26 占用估算）', () => {
  it('cache 目录大小 + MMKV 非白名单键值合计；白名单不计入', () => {
    mockDir.sizeValue = 2048;
    storage.set('toiv.settings', 'x'.repeat(100));
    storage.set('assistant_draft:s1', 'y'.repeat(50));
    storage.set('tmp_cache', 'z'.repeat(10));
    expect(estimateCacheBytes()).toBe(2048 + 10);
  });

  it('目录大小为 null / 读目录抛错按 0 计，不抛出', () => {
    mockDir.sizeValue = null;
    storage.set('tmp_cache', '1234');
    expect(estimateCacheBytes()).toBe(4);
    mockDir.throws = true;
    expect(estimateCacheBytes()).toBe(4);
  });
});

describe('clearCache（M26 执行清理）', () => {
  it('逐项删 cache 内容 + 移除非白名单键；白名单保留；返回释放字节', () => {
    const delA = jest.fn();
    const delB = jest.fn();
    mockDir.listItems = [
      { name: 'a.png', size: 100, delete: delA },
      { name: 'b.mp4', size: 50, delete: delB },
    ];
    storage.set('toiv.settings', 'keep-settings');
    storage.set('toiv.cachedUser', 'keep-user');
    storage.set('assistant_draft:s1', 'keep-draft');
    storage.set('tmp_a', '12345');

    const freed = clearCache();

    expect(delA).toHaveBeenCalledTimes(1);
    expect(delB).toHaveBeenCalledTimes(1);
    expect(freed).toBe(100 + 50 + 5);
    expect(storage.contains('tmp_a')).toBe(false);
    expect(storage.contains('toiv.settings')).toBe(true);
    expect(storage.contains('toiv.cachedUser')).toBe(true);
    expect(storage.contains('assistant_draft:s1')).toBe(true);
  });

  it('单项删除失败跳过不中断，且失败项大小不计入释放', () => {
    const delOk = jest.fn();
    const delBad = jest.fn(() => {
      throw new Error('locked');
    });
    mockDir.listItems = [
      { name: 'ok.bin', size: 10, delete: delOk },
      { name: 'bad.bin', size: 999, delete: delBad },
    ];
    const freed = clearCache();
    expect(delOk).toHaveBeenCalledTimes(1);
    expect(delBad).toHaveBeenCalledTimes(1);
    expect(freed).toBe(10);
  });

  it('cache 目录不可读（list 抛错）仍清 MMKV 键', () => {
    mockDir.throws = true;
    storage.set('tmp_a', '123');
    const freed = clearCache();
    expect(freed).toBe(3);
    expect(storage.contains('tmp_a')).toBe(false);
  });
});

describe('buildDiagnostics（M26 诊断信息组装）', () => {
  const input = {
    appName: 'Mobile',
    appVersion: '1.0.0',
    platform: 'android',
    osVersion: 34,
    deviceModel: 'Pixel 8',
    pixelRatio: 2.625,
    apiBase: 'https://api.test',
    signedIn: true,
    nsfwIntent: false,
    storageKeys: [
      { key: 'toiv.settings', size: 120 },
      { key: 'assistant_draft:s1', size: 12 },
    ],
    generatedAt: new Date('2026-08-15T10:00:00.000Z'),
  };

  it('形状与字段映射：app/device/config/storage/generatedAt 五区，osVersion 字符串化', () => {
    const d = buildDiagnostics(input);
    expect(d.app).toEqual({ name: 'Mobile', version: '1.0.0' });
    expect(d.device).toEqual({
      platform: 'android',
      osVersion: '34',
      model: 'Pixel 8',
      pixelRatio: 2.625,
    });
    expect(d.config).toEqual({ apiBase: 'https://api.test', signedIn: true, nsfwIntent: false });
    expect(d.generatedAt).toBe('2026-08-15T10:00:00.000Z');
  });

  it('storage.totalBytes 为键大小合计；设备型号 null 透传', () => {
    const d = buildDiagnostics(input);
    expect(d.storage.totalBytes).toBe(132);
    expect(d.storage.keys).toHaveLength(2);
    const noModel = buildDiagnostics({ ...input, deviceModel: null, storageKeys: [] });
    expect(noModel.device.model).toBeNull();
    expect(noModel.storage.totalBytes).toBe(0);
  });

  it('脱敏：序列化产物无 token/存储值，存储区仅键名+大小', () => {
    const d = buildDiagnostics(input);
    const json = JSON.stringify(d);
    expect(json).not.toContain('token');
    expect(json).not.toContain('SECRET');
    for (const k of d.storage.keys) {
      expect(Object.keys(k).sort()).toEqual(['key', 'size']);
    }
  });
});

describe('collectStorageKeyStats（M26 存储键清单采集）', () => {
  it('仅键名 + 值大小，不透出值本体', () => {
    storage.set('toiv.settings', 'x'.repeat(7));
    storage.set('assistant_draft:s1', 'SECRET_DRAFT');
    const stats = collectStorageKeyStats();
    expect(stats).toContainEqual({ key: 'toiv.settings', size: 7 });
    expect(stats).toContainEqual({ key: 'assistant_draft:s1', size: 12 });
    expect(JSON.stringify(stats)).not.toContain('SECRET_DRAFT');
  });
});
