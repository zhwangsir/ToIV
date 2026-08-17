import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { getToken, setNsfwIntent, setToken } from '@/api/client';
import { resolveApiBase, setApiBaseOverride } from '@/api/config';
import { useAuthStore } from '@/stores/auth';
import { useDraftStore } from '@/stores/draft';
import { useSettingsStore } from '@/stores/settings';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';
import { enqueueResponse, installMockUni } from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setActivePinia(createPinia());
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('settings store', () => {
  it('默认值：palette-01 浅色', () => {
    const s = useSettingsStore();
    expect(s.paletteId).toBe(DEFAULT_PALETTE_ID);
    expect(s.mode).toBe('light');
    expect(s.nsfwIntent).toBe(false);
  });

  it('setPalette/setMode 持久化并可恢复', () => {
    const s = useSettingsStore();
    s.setPalette('palette-03');
    s.setMode('dark');

    // 模拟冷启动：新 pinia 实例 + restore
    setActivePinia(createPinia());
    const restored = useSettingsStore();
    restored.restore();
    expect(restored.paletteId).toBe('palette-03');
    expect(restored.mode).toBe('dark');
  });

  it('setApiBase 桥接到 resolveApiBase', () => {
    const s = useSettingsStore();
    s.setApiBase('https://override.example.com');
    expect(resolveApiBase()).toBe('https://override.example.com');
  });

  it('restore 时桥接持久化的覆盖值', () => {
    const s = useSettingsStore();
    s.setApiBase('https://saved.example.com');
    s.setNsfw(true);
    setApiBaseOverride(null); // 清掉内存态模拟重启

    setActivePinia(createPinia());
    const restored = useSettingsStore();
    restored.restore();
    expect(resolveApiBase()).toBe('https://saved.example.com');
  });
});

describe('auth store', () => {
  it('无 token → signedOut', async () => {
    const auth = useAuthStore();
    await auth.restore();
    expect(auth.status).toBe('signedOut');
    expect(auth.isLoggedIn).toBe(false);
  });

  it('token 有效 → signedIn 并缓存用户', async () => {
    setToken('tk');
    enqueueResponse(200, { user: { id: 'u1', email: 'a@b.c', role: 'user' } });
    const auth = useAuthStore();
    await auth.restore();
    expect(auth.status).toBe('signedIn');
    expect(auth.user?.id).toBe('u1');
  });

  it('401 → 清 token 踢回 signedOut', async () => {
    setToken('expired');
    enqueueResponse(401, {});
    const auth = useAuthStore();
    await auth.restore();
    expect(auth.status).toBe('signedOut');
    expect(getToken()).toBeNull();
  });

  it('弱网 + 缓存用户 → 保持会话', async () => {
    // 先登录写入缓存
    enqueueResponse(200, { token: 'tk', user: { id: 'u1', email: 'a@b.c', role: 'user' } });
    const auth = useAuthStore();
    await auth.signIn('a@b.c', 'pw');
    expect(auth.status).toBe('signedIn');

    // 模拟重启后 restore 遇到网络错误（非 401）
    setActivePinia(createPinia());
    const auth2 = useAuthStore();
    enqueueResponse(500, {});
    await auth2.restore();
    expect(auth2.status).toBe('signedIn');
    expect(auth2.user?.id).toBe('u1');
  });

  it('弱网且无缓存 → signedOut', async () => {
    setToken('tk');
    enqueueResponse(500, {});
    const auth = useAuthStore();
    await auth.restore();
    expect(auth.status).toBe('signedOut');
  });

  it('signOut 清空会话', async () => {
    enqueueResponse(200, { token: 'tk', user: { id: 'u1', email: 'a@b.c', role: 'user' } });
    const auth = useAuthStore();
    await auth.signIn('a@b.c', 'pw');
    auth.signOut();
    expect(auth.status).toBe('signedOut');
    expect(getToken()).toBeNull();
  });
});

describe('draft store', () => {
  it('fill 后 consume 读走即清空', () => {
    const draft = useDraftStore();
    draft.fill({ prompt: 'a cat', engineId: 'sdxl', fromJobId: 'j1' });
    expect(draft.hasDraft).toBe(true);

    const consumed = draft.consume();
    expect(consumed.prompt).toBe('a cat');
    expect(consumed.engineId).toBe('sdxl');
    expect(draft.hasDraft).toBe(false);
    expect(draft.prompt).toBe('');
  });
});
