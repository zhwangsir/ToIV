import { describe, expect, it } from 'vitest';

import {
  CACHE_WHITELIST,
  buildDiagnostics,
  formatBytes,
  planCacheClear,
  type DiagnosticsInput,
} from '@/utils/maintenance';

describe('formatBytes', () => {
  it('0 / 负数 / 非有限数 → 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-128)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('字节级原样展示', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('KB 级：整数去尾零，非整数保留一位', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('MB 级：整数去尾零，非整数保留一位', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('planCacheClear', () => {
  it('默认白名单保留登录与设置：token / 设置（主题色板）/ 缓存用户', () => {
    const plan = planCacheClear(['toiv_token', 'toiv.settings', 'toiv.cachedUser', 'tmp_cover_1']);
    expect(plan.toKeep).toEqual(['toiv_token', 'toiv.settings', 'toiv.cachedUser']);
    expect(plan.toRemove).toEqual(['tmp_cover_1']);
  });

  it('assistant_draft: 前缀草稿键保留（用户数据）', () => {
    const plan = planCacheClear(['assistant_draft:__new__', 'assistant_draft:s1']);
    expect(plan.toKeep).toEqual(['assistant_draft:__new__', 'assistant_draft:s1']);
    expect(plan.toRemove).toEqual([]);
  });

  it('其余键进删除列表，双列表保持输入顺序', () => {
    const plan = planCacheClear(['tmp_b', 'toiv_token', 'tmp_a', 'assistant_draft:s9', 'tmp_c']);
    expect(plan.toRemove).toEqual(['tmp_b', 'tmp_a', 'tmp_c']);
    expect(plan.toKeep).toEqual(['toiv_token', 'assistant_draft:s9']);
  });

  it('空输入 → 双空列表', () => {
    const plan = planCacheClear([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toKeep).toEqual([]);
  });

  it('白名单可注入（自定义精确键 + 前缀）', () => {
    const plan = planCacheClear(['a', 'b:c', 'b:d', 'e'], { exact: ['a'], prefixes: ['b:'] });
    expect(plan.toKeep).toEqual(['a', 'b:c', 'b:d']);
    expect(plan.toRemove).toEqual(['e']);
  });

  it('出厂白名单覆盖全部受保护键', () => {
    expect(CACHE_WHITELIST.exact).toContain('toiv_token');
    expect(CACHE_WHITELIST.exact).toContain('toiv.settings');
    expect(CACHE_WHITELIST.exact).toContain('toiv.cachedUser');
    expect(CACHE_WHITELIST.prefixes).toContain('assistant_draft:');
  });
});

describe('buildDiagnostics', () => {
  const base: DiagnosticsInput = {
    app: { name: 'ToIV', version: '1.0.0' },
    env: {
      platform: 'h5',
      system: 'macOS 15.0',
      pixelRatio: 2,
      sdkVersion: null,
      hostVersion: 'Chrome 126',
    },
    apiBase: 'http://localhost:9800',
    loggedIn: true,
    nsfwIntent: false,
    storageKeys: [
      { key: 'toiv_token', size: 120 },
      { key: 'toiv.settings', size: 100 },
      { key: 'assistant_draft:s1', size: 30 },
    ],
    now: '2026-08-15T10:00:00.000Z',
  };

  it('输出形状完整：app / env / apiBase / session / features / storage / generatedAt', () => {
    const d = buildDiagnostics(base);
    expect(d.app).toEqual({ name: 'ToIV', version: '1.0.0' });
    expect(d.env.platform).toBe('h5');
    expect(d.env.pixelRatio).toBe(2);
    expect(d.env.hostVersion).toBe('Chrome 126');
    expect(d.apiBase).toBe('http://localhost:9800');
    expect(d.session).toEqual({ loggedIn: true });
    expect(d.features).toEqual({ nsfwIntent: false });
    expect(d.generatedAt).toBe('2026-08-15T10:00:00.000Z');
  });

  it('storage：键大小合计正确 + 格式化文本', () => {
    const d = buildDiagnostics(base);
    expect(d.storage.totalSize).toBe(250);
    expect(d.storage.totalSizeText).toBe('250 B');
    expect(d.storage.keys).toHaveLength(3);
    expect(d.storage.keys[0]).toEqual({ key: 'toiv_token', size: 120 });
  });

  it('脱敏：仅登录态布尔与键名，token 值不出现在输出', () => {
    const secret = 'sk-live-secret-token-value';
    const d = buildDiagnostics({
      ...base,
      storageKeys: [{ key: 'toiv_token', size: 'toiv_token'.length + secret.length }],
    });
    const json = JSON.stringify(d);
    expect(json).toContain('toiv_token');
    expect(json).not.toContain(secret);
    expect(d.storage.keys[0]).not.toHaveProperty('value');
  });

  it('空存储：合计 0 + 空清单', () => {
    const d = buildDiagnostics({ ...base, storageKeys: [] });
    expect(d.storage.totalSize).toBe(0);
    expect(d.storage.totalSizeText).toBe('0 B');
    expect(d.storage.keys).toEqual([]);
  });
});
